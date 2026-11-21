// Per-visitor limits for an open link, applied in ONE place: server.ts's request and upgrade handlers. Pure parts (the client
// address, the buckets, the route classes) live here so scripts/checks/budget.ts can test them with time injected.
// On when NODE_ENV=production (ARC_LIMITS=off turns them off) or ARC_LIMITS=on: local development is never throttled.
import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";

/** Token bucket per key: `cap` requests at once, refilled at `perMin` a minute. */
export class Buckets {
  private m = new Map<string, { tokens: number; at: number }>();
  constructor(
    readonly cap: number,
    readonly perMin: number,
  ) {}
  /** 0 when allowed (one token taken), else the seconds until the next token. */
  take(key: string, now = Date.now()): number {
    const b = this.m.get(key) ?? { tokens: this.cap, at: now };
    b.tokens = Math.min(this.cap, b.tokens + ((now - b.at) / 60_000) * this.perMin);
    b.at = now;
    this.m.set(key, b);
    if (this.m.size > 20_000) this.prune(now);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil(((1 - b.tokens) / this.perMin) * 60));
  }
  /** Drops buckets that have refilled (they hold no information). */
  prune(now = Date.now()) {
    for (const [k, b] of this.m) if (b.tokens + ((now - b.at) / 60_000) * this.perMin >= this.cap) this.m.delete(k);
  }
}

/**
 * The visitor's address. Behind Railway's proxy the client address is the one the proxy appended to x-forwarded-for, the
 * LAST entry: anything to its left was sent by the visitor and can be anything. `hops` is how many trusted proxies append
 * (1 on Railway); 0 ignores the header and uses the socket peer (local runs, where nobody appends).
 */
export function clientIp(forwarded: string | string[] | undefined, peer: string | undefined, hops: number): string {
  const list = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? "")).split(",").map((s) => s.trim()).filter(Boolean);
  const ip = hops > 0 && list.length >= hops ? list[list.length - hops] : (peer ?? "unknown");
  return per64(ip.replace(/^::ffff:/, ""));
}

/** An IPv6 address as its /64 (one household or phone gets a whole /64, so one address each would be no limit at all). */
export function per64(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const a = head ? head.split(":") : [];
  const b = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b] : a;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** A visitor's address as it may appear in a log line: a short keyed hash, enough to tell two visitors apart in one day's log. */
export const logIp = (ip: string) => createHash("sha256").update(`${LOG_SALT}${ip}`).digest("hex").slice(0, 10);
const LOG_SALT = randomBytes(8).toString("hex"); // per process: a log line cannot be matched to an address later

/** The socket peer is this machine (headers can lie; the peer cannot). */
export const loopback = (addr: string | undefined) => /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(addr ?? "");

/** Routes only the person at this machine may use: the peer must be loopback and every request to them must be same-origin. */
export const LOCAL_ONLY = /^\/api\/(pointer|budget)$/;
/** The one cross-origin caller: the extension and bookmarklet hand-off, which has its own origin rules (app/api/ingest). */
const CROSS_OK = /^\/api\/ingest$/;

/**
 * Cross-site request refusal (CSRF and cross-site WebSocket hijacking), applied in server.ts before Next sees a request.
 * Guarded: every method other than GET/HEAD/OPTIONS, every request to a LOCAL_ONLY route, every WebSocket upgrade. A guarded
 * request is refused when its Origin names another host or port than its Host, when Sec-Fetch-Site says another site sent it,
 * and (WebSocket only) when it has no Origin at all: every browser sends one, so a missing Origin is a tool, and tools pass one
 * (scripts/measure-costs.mjs). Returns the reason, or null when the request may go on.
 */
export function crossSite(method: string, path: string, h: { origin?: string; host?: string; "sec-fetch-site"?: string; "x-forwarded-host"?: string }, upgrade = false, hops = 0): string | null {
  const guarded = upgrade || LOCAL_ONLY.test(path) || !/^(GET|HEAD|OPTIONS)$/i.test(method);
  if (!guarded || (!upgrade && CROSS_OK.test(path))) return null;
  const site = (h["sec-fetch-site"] ?? "").toLowerCase();
  if (site === "cross-site" || site === "same-site") return `sec-fetch-site ${site}`; // same-site: another port or subdomain
  if (h.origin === undefined) return upgrade ? "no origin" : null;
  let o: URL;
  try {
    o = new URL(h.origin);
  } catch {
    return "bad origin"; // includes "null" (sandboxed frames, file: pages)
  }
  // Behind a trusted proxy (ARC_PROXY_HOPS) the public host may arrive as x-forwarded-host; a browser cannot set it cross-site.
  const hosts = [h.host, hops > 0 ? h["x-forwarded-host"]?.split(",").at(-1)?.trim() : undefined].filter(Boolean).map((x) => x!.toLowerCase());
  return hosts.includes(o.host.toLowerCase()) ? null : "foreign origin";
}

// Request bodies, refused early by Content-Length in server.ts. JSON routes are small; the upload routes count their own bodies
// (app/api/pdf/upload 60 MB, app/api/ingest 40 MB, app/api/pdf/figure 8 MB). A body with no Content-Length is refused on capped
// routes (411), so nothing reads an unbounded chunked stream. Each cap is a few times the largest body the app sends.
export const BODY_CAPS: [RegExp, number][] = [
  [/^\/api\/(pdf\/upload|ingest|pdf\/figure)$/, Infinity], // counted by the route itself
  [/^\/api\/pointer$/, 1024], // {x, y, ms}
  [/^\/api\/(tour\/prioritise|video\/shown|pdf\/page|load|preview|remote|search)$/, 16 * 1024], // an address or an id and a number
  [/^\/api\/speak$/, 8 * 1024], // one clip's text (the route also checks)
  [/^\/api\/decide$/, 64 * 1024], // an utterance with the items on screen
  [/^\/api\//, 64 * 1024], // any other route
];
export const bodyCap = (path: string) => BODY_CAPS.find(([r]) => r.test(path))?.[1] ?? 64 * 1024;

export type RouteClass = "page" | "model" | "search" | "image" | "speak" | "upload" | "store" | "api" | "web";

/** Which bucket a request draws from. */
export function classify(method: string, path: string): RouteClass {
  const post = method === "POST";
  if (/^\/api\/(load|preview|remote)$/.test(path) || (post && path === "/api/ingest")) return "page";
  if (path === "/api/search") return "search";
  if (path === "/api/image") return "image";
  if (path === "/api/speak") return "speak";
  if (path === "/api/pdf/upload") return "upload";
  if (post && path === "/api/pdf/figure") return "store";
  if (path === "/api/tour" || path === "/api/tour/prioritise" || path === "/api/page/blocks" || (post && /^\/api\/(video\/shown|pdf\/page|decide)$/.test(path))) return "model";
  if (path.startsWith("/api/")) return "api";
  return "web";
}

const env = (name: string, fallback: number) => Number(process.env[name]) || fallback;

// The limits table, per visitor address. Sized from a measured normal study session (README deploy section): a student never
// meets them; a script does within a minute. cap = burst, perMin = steady rate. Each is overridable: ARC_LIMIT_<CLASS>="cap,perMin".
export const LIMITS: Record<RouteClass, { cap: number; perMin: number }> = {
  page: { cap: 15, perMin: 2 }, // a page open costs a Bright Data request and queues tours
  model: { cap: 120, perMin: 30 }, // tours, decisions (one per command), PDF pages, video positions, clean-up polls
  search: { cap: 8, perMin: 1 }, // each search is several Bright Data requests
  image: { cap: 120, perMin: 30 }, // figure proxy; may use the Web Unlocker
  speak: { cap: 300, perMin: 90 }, // local voice: several clips per block, all CPU
  upload: { cap: 5, perMin: 0.2 }, // PDFs up to 60 MB each, on a small disk
  store: { cap: 60, perMin: 10 }, // PDF figure pictures the browser cuts out
  api: { cap: 600, perMin: 240 }, // polling: tour status, video status, PDF pages, frames
  web: { cap: 300, perMin: 120 }, // pages and static files
};
for (const k of Object.keys(LIMITS) as RouteClass[]) {
  const o = (process.env[`ARC_LIMIT_${k.toUpperCase()}`] ?? "").split(",").map(Number);
  if (o.length === 2 && o.every((v) => v > 0)) LIMITS[k] = { cap: o[0], perMin: o[1] };
}

export const VOICE = {
  perIp: env("ARC_VOICE_PER_IP", 2), // open voice sockets per visitor (one per tab; each holds up to six Live sessions)
  total: env("ARC_VOICE_TOTAL", 12), // across all visitors
};

export const SAY_SLOW = "Arc is getting too many requests from you. Wait a moment and try again.";
export const SAY_BUSY = "Arc's voice is busy with other students right now. Try again in a minute.";
export const SAY_TABS = "Arc is already open in other tabs on this connection. Close one of them and try again.";

export const limitsOn = () => process.env.ARC_LIMITS === "on" || (process.env.NODE_ENV === "production" && process.env.ARC_LIMITS !== "off");
// ARC_PROXY_HOPS: how many proxies in front of Arc append to x-forwarded-for (README, deploy). 0 (the default off Railway) keys
// every visitor by the socket peer: behind an unannounced proxy that is the proxy, so everyone shares one bucket. server.ts warns
// once in production when forwarded headers arrive while this is 0.
export const proxyHops = () => (process.env.ARC_PROXY_HOPS !== undefined ? Number(process.env.ARC_PROXY_HOPS) || 0 : process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT ? 1 : 0);
