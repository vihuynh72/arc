// The one guard for every server-side fetch of an address a user pasted or a page supplied (server-side request forgery):
// http/https only, no credentials, default ports only, every resolved address public, re-checked on each redirect hop, and the
// connection pinned to the address that was checked (no DNS rebinding between check and connect). Bright Data and the Browser
// API are only given addresses that pass checkUrl. Callers: lib/server/fetch.ts, images.ts, pdf.ts, tour.ts, brightdata.ts,
// remote.ts, khan.ts, app/api/load, app/api/preview. Checked offline by scripts/checks/ssrf.ts.
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import tls from "node:tls";
import zlib from "node:zlib";
import type { X509Certificate } from "node:crypto";
import { chainGap, issuerOf, issuerUrl, rootSigned } from "./aia";

export const NOT_PUBLIC = "Arc only opens public web addresses.";
export const NO_SITE = "I could not find that site. Check the address.";

/** True for addresses a server-side fetch must never reach: loopback, private, link-local, CGNAT, unspecified, multicast, reserved. */
export function privateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x)?.[1] ?? /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(x)?.slice(1).map((h) => parseInt(h, 16)).flatMap((n) => [n >> 8, n & 255]).join(".");
    if (mapped) return privateAddress(mapped);
    // 6to4 (2002::/16, the IPv4 address in groups 2 and 3) and Teredo (2001:0::/32, a tunnel whose last 32 bits are the client's
    // IPv4 address inverted) carry an IPv4 address. 6to4 is judged by that address; Teredo is never a study page: refused.
    const [h, t = ""] = x.split("::");
    const parts = (v: string) => (v ? v.split(":").map((p) => parseInt(p, 16)) : []);
    const g = x.includes("::") ? [...parts(h), ...Array(8 - parts(h).length - parts(t).length).fill(0), ...parts(t)] : parts(x);
    if (g[0] === 0x2002) return privateAddress([g[1] >> 8, g[1] & 255, g[2] >> 8, g[2] & 255].join("."));
    if (g[0] === 0x2001 && g[1] === 0) return true;
    return x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || /^64:ff9b:/.test(x) || /^2001:db8:/.test(x) || /^::\d/.test(x);
  }
  return true;
}

/** What the student typed, as an absolute URL: trimmed, https added when no scheme, scheme and host lower-cased (WHATWG URL also
 * normalises decimal, octal and hex IPv4). Null when it is not a web address; "scheme" when it names another scheme. */
export function normalizeUrl(input: unknown): string | null | "scheme" {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (!s || s.length > 8000 || /\s/.test(s)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https" && !/^\d+$/.test(s.slice(scheme.length + 1, s.indexOf("/") > 0 ? s.indexOf("/") : undefined))) return "scheme";
  if (!scheme || !/^https?:\/\//i.test(s)) {
    if (scheme === "http" || scheme === "https") return null; // "http:/x" and similar
    s = `https://${s.replace(/^\/+/, "")}`;
  }
  try {
    const u = new URL(s);
    if (!u.hostname || (!u.hostname.includes(".") && !isIP(u.hostname.replace(/^\[|\]$/g, "")) && u.hostname !== "localhost")) return null;
    for (const k of [...u.searchParams.keys()]) if (/^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|igshid)$/i.test(k)) u.searchParams.delete(k); // tracking only
    return u.href;
  } catch {
    return null;
  }
}

export type Checked = { ok: true; url: URL; address: string; family: 4 | 6 } | { ok: false; why: "scheme" | "private" | "dns" | "port" };

/** Checks one address. Every address the host resolves to must be public; the first is returned so the caller can pin to it. */
export async function checkUrl(raw: string | URL): Promise<Checked> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, why: "scheme" };
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return { ok: false, why: "scheme" };
  if (u.port && u.port !== "80" && u.port !== "443") return { ok: false, why: "port" }; // odd ports are internal services far more often than study pages
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa|.*\.intranet|.*\.corp)$/i.test(host) || !host) return { ok: false, why: "private" };
  if (isIP(host)) return privateAddress(host) ? { ok: false, why: "private" } : { ok: true, url: u, address: host, family: isIP(host) as 4 | 6 };
  const addrs = await lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (!addrs.length) return { ok: false, why: "dns" };
  if (addrs.some((a) => privateAddress(a.address))) return { ok: false, why: "private" };
  return { ok: true, url: u, address: addrs[0].address, family: addrs[0].family as 4 | 6 };
}

/** The plain line for a failed check. */
export const checkMessage = (why: Exclude<Checked, { ok: true }>["why"]) => (why === "dns" ? NO_SITE : NOT_PUBLIC);

export class BlockedUrl extends Error {
  constructor(public why: Exclude<Checked, { ok: true }>["why"]) {
    super(checkMessage(why));
    this.name = "BlockedUrl";
  }
}

type Ok = Extract<Checked, { ok: true }>;

// Sites that leave out the certificates above their own (lib/server/aia.ts): host -> this machine's roots plus those verified
// certificates, for this process. shortcut: the bundled roots only, so a machine that adds roots of its own (NODE_EXTRA_CA_CERTS)
// loses them for these few hosts; upgrade to tls.getCACertificates() if that is ever used.
const repaired = new Map<string, string[]>();

function once(c: Ok, init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }): Promise<http.IncomingMessage> {
  const mod = c.url.protocol === "https:" ? https : http;
  const options: https.RequestOptions = {
    method: init.method ?? "GET",
    headers: { "accept-encoding": "gzip, deflate, br", ...init.headers },
    signal: init.signal,
    ca: repaired.get(c.url.hostname),
    // Connect to the address that was checked, never a fresh lookup (DNS rebinding).
    lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o?.all ? cb(null, [{ address: c.address, family: c.family }]) : cb(null, c.address, c.family))) as never,
  };
  return new Promise((resolve, reject) => {
    const req = mod.request(c.url, options, resolve);
    req.on("error", reject);
    req.end();
  });
}

/** The site's own certificate, read from a handshake that is not trusted: nothing is sent on it and nothing is read from it. */
const leafOf = (c: Ok) =>
  new Promise<X509Certificate | null>((resolve) => {
    const s = tls.connect({ host: c.address, port: 443, servername: isIP(c.url.hostname) ? undefined : c.url.hostname, rejectUnauthorized: false }, () => {
      resolve(s.getPeerX509Certificate() ?? null);
      s.destroy();
    });
    s.setTimeout(4000, () => s.destroy(new Error("timeout")));
    s.on("error", () => resolve(null));
  });

/** A small public file (a certificate is a few kilobytes), through the guard like any address a page supplies. */
async function small(url: string): Promise<Uint8Array | null> {
  const res = await safeFetch(url, { signal: AbortSignal.timeout(4000) }, undefined, false).catch(() => null);
  if (!res?.ok || !res.body) return null;
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    if ((size += part.length) > 65536) return null;
    parts.push(part);
  }
  return Buffer.concat(parts);
}

/** Fetches the certificates missing above the site's own, at most three: each must have signed the one below it, and the last
 * must be signed by a trusted root. Only then are they kept, for this host. */
async function repair(c: Ok): Promise<boolean> {
  let child = await leafOf(c);
  const found: string[] = [];
  for (let level = 0; child && level < 3; level++) {
    const from = issuerUrl(child.infoAccess);
    const file = from ? await small(from) : null;
    const up = file && issuerOf(file, child);
    if (!up) return false;
    found.push(up.toString());
    if (rootSigned(up)) {
      if (repaired.size >= 200) repaired.clear();
      repaired.set(c.url.hostname, [...tls.rootCertificates, ...found]);
      return true;
    }
    child = up;
  }
  return false;
}

/** fetch() for untrusted addresses: redirects followed by hand (at most 5), each hop checked and pinned. Throws BlockedUrl. The
 * Response's `url` is the final address. Bodies are decompressed. */
export async function safeFetch(
  raw: string,
  init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal } = {},
  check: (u: string, hop: number) => Promise<Checked> = (u) => checkUrl(u), // scripts/checks/ssrf.ts passes its own for the first hop
  fix = true, // false only for the certificate fetch itself, so a repair can never start another
): Promise<Response & { url: string }> {
  let at = raw;
  for (let hop = 0; hop <= 5; hop++) {
    const c = await check(at, hop);
    if (!c.ok) throw new BlockedUrl(c.why);
    const res = await once(c, init).catch(async (e: { code?: string }) => {
      // The site left out certificates above its own: fetch and verify them as a browser does, then ask once more (verified in full).
      if (fix && c.url.protocol === "https:" && chainGap(e?.code) && (await repair(c).catch(() => false))) return once(c, init);
      throw e;
    });
    const status = res.statusCode ?? 502;
    const loc = res.headers.location;
    if (status >= 300 && status < 400 && loc && hop < 5) {
      res.resume();
      at = new URL(loc, c.url).href;
      continue;
    }
    const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
    const stream: Readable = enc === "gzip" || enc === "x-gzip" ? res.pipe(zlib.createGunzip()) : enc === "br" ? res.pipe(zlib.createBrotliDecompress()) : enc === "deflate" ? res.pipe(zlib.createInflate()) : res;
    stream.on("error", () => {}); // a broken body ends the read; it must not crash the process
    const headers = new Headers();
    for (const [k, v] of Object.entries(res.headers)) if (v != null && k !== "content-encoding" && k !== "content-length") headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
    const empty = status === 204 || status === 304 || init.method === "HEAD" || status < 200;
    if (empty) res.resume();
    const out = new Response(empty ? null : (Readable.toWeb(stream) as ReadableStream), { status: status < 200 ? 502 : status, headers });
    Object.defineProperty(out, "url", { value: c.url.href });
    return out as Response & { url: string };
  }
  throw new BlockedUrl("private"); // shortcut: a sixth redirect is treated like a refused address
}
