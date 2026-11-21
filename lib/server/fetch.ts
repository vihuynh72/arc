// Page fetch. MDPI and fixtures: fixtures, then .cache/pages, then Bright Data Web Unlocker markdown (live).
// Other pages: loadPage below. A stored copy is only the instant first view: components/Twin.tsx then asks for the
// live page (live: true). ARC_OFFLINE=1 (a room with no network) serves stored copies only and never fetches.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Twin } from "@/lib/types";
import { unlock } from "@/lib/server/brightdata";
import { parseHtml, paywalled } from "@/lib/parse/html";
import { parseMarkdown } from "@/lib/parse/markdown";
import { parseText } from "@/lib/parse/text";
import { sniff } from "@/lib/server/images";
import { safeFetch } from "@/lib/server/safeFetch";
import { doiIn } from "@/lib/server/scholar";

export type Fetched = { markdown: string; via: Twin["source"]["via"]; ms: number };

const liveBudget = () => Number(process.env.ARC_LIVE_BUDGET_MS) || 25_000; // env override is for the forced-timeout check
const cachePath = (url: string) => `.cache/pages/${createHash("sha1").update(url).digest("hex")}.md`;
const fixtureDir = (url: string) =>
  url.includes("1424-8220/24/6/1935") ? "lower" : url.includes("2226-4310") ? "mars" : null;
const read = (p: string) => readFile(p, "utf8").catch(() => null);
export const offline = () => process.env.ARC_OFFLINE === "1";
const NO_COPY = "Arc is offline and has no saved copy of this page.";
const viaMarkdown = (url: string) => !!fixtureDir(url) || /(^|\.)mdpi\.com$/i.test(new URL(url).hostname);
/** The route a live fetch of this link takes, for the status line shown while the stored copy is on screen. */
export const liveRoute = (url: string): "brightdata" | "direct" => (viaMarkdown(url) ? "brightdata" : "direct");

async function cached(url: string): Promise<string | null> {
  const dir = fixtureDir(url);
  return (dir && (await read(`fixtures/${dir}/main.md`))) || read(cachePath(url));
}

/** live=false: fixture or cache, else live. live=true: Unlocker; after 25 s or on error, the cached copy (the call finishes in the background and refreshes the cache). */
export async function fetchMarkdown(url: string, opts: { live?: boolean } = {}): Promise<Fetched> {
  const t = Date.now();
  const hit = await cached(url);
  if ((!opts.live || offline()) && hit) return { markdown: hit, via: "cache", ms: Date.now() - t };
  if (offline()) throw new Error(NO_COPY);

  const call = unlock(url).then(async (md) => {
    if (md.length > 1000) {
      await mkdir(".cache/pages", { recursive: true });
      await writeFile(cachePath(url), md);
    }
    return md;
  });
  call.catch(() => {}); // a late failure must not crash the process
  const timeout = new Promise<null>((r) => setTimeout(r, liveBudget(), null));
  try {
    const md = await Promise.race([call, timeout]);
    if (md) return { markdown: md, via: "unlocker", ms: Date.now() - t };
  } catch (e) {
    if (!hit) throw e;
  }
  if (!hit) return { markdown: await call, via: "unlocker", ms: Date.now() - t }; // nothing cached: keep waiting
  return { markdown: hit, via: "cache", ms: Date.now() - t };
}

// Any page that is not MDPI or a prepared fixture: a race, not a queue (measured; see the PAGES handoff).
// 1. Direct fetch starts at once (through the address guard, lib/server/safeFetch.ts). 2. The Web Unlocker starts when direct has
// nothing usable by RACE_MS, or sooner when direct comes back blocked, thin or a challenge. 3. The Browser API renders the page
// when both give nothing (JavaScript apps such as Khan Academy, challenges the Unlocker cannot pass) or the Unlocker is slow.
// The first usable result wins; `via` records which one, and the winning route is remembered per host for the next load.
// Failures end with one plain line, fast: not found, sign-in, empty, site errors, too slow, data, media.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const htmlPath = (url: string) => `.cache/pages/${createHash("sha1").update(url).digest("hex")}.html`;
const chars = (t: Twin) => t.nodes.reduce((n, x) => n + x.text.length, 0);
const squash = (s = "") => s.replace(/\s+/g, " ").trim();
const usable = (t: Twin) => chars(t) >= 800 || (t.counts.sections >= 2 && chars(t) >= 300) || (t.counts.figures >= 1 && chars(t) >= 200);
const keep = async (url: string, html: string) => {
  await mkdir(".cache/pages", { recursive: true });
  await writeFile(htmlPath(url), html);
};
const RACE_MS = Number(process.env.ARC_RACE_MS) || 1200; // direct answers in 0.1 to 0.9 s on every open study site measured
const DIRECT_MS = 8000;
const UNLOCK_MS = 20_000;
const RENDER_MS = 22_000;
const RENDER_AFTER_MS = 8000; // the Unlocker answers in 2 to 7 s when it can (Nature 3.5 s); past 8 s it is usually failing
const BUDGET_MS = 12_000; // the whole load, unless a Browser API render is under way (then HARD_MS)
const HARD_MS = 30_000;
const MAX_BYTES = 12 * 1024 * 1024;
// The route that last won per host (one long-lived process): a host that needed Bright Data starts it at once next time.
const learned = ((globalThis as unknown as { __arcRoutes?: Map<string, Twin["source"]["via"]> }).__arcRoutes ??= new Map());

/** Thrown when a link turns out to be a PDF (content-type or %PDF- bytes): app/api/load then reads it as a PDF, never as text. */
const pdfSignal = () => Object.assign(new Error("This link is a PDF."), { name: "IsPdf" });
/** A plain line for the student; `status` is the HTTP status app/api/load answers with. */
export const pageError = (message: string, status: number) => Object.assign(new Error(message), { name: "PageError", status });
const EXTENSION = "If it is open in your browser, the Arc extension can read it from your tab.";
export const MESSAGES = {
  notFound: "This page was not found. The link may be old or mistyped.",
  signIn: `That page needs you to sign in, so Arc cannot open it. ${EXTENSION}`,
  blocked: `That site would not let Arc in. ${EXTENSION}`,
  siteError: "That site is having problems right now.",
  empty: "That page is empty.",
  slow: "That site is too slow to answer.",
  unreachable: "That site is not answering.",
  data: "That link is data, not a page to read.",
  media: "Arc reads YouTube and Khan Academy videos for now.",
  quizlet: "Arc does not open Quizlet sets. Paste the textbook or course page the set comes from.",
};

/** Links Arc answers without fetching: sign-in-only apps, media files, other video sites, Quizlet. Null when the link should be fetched. */
export function refuseUrl(url: string): { message: string; status: number } | null {
  const u = new URL(url);
  const h = u.hostname.replace(/^www\.|^m\./, "");
  const p = u.pathname;
  if (/(^|\.)quizlet\.com$/.test(h)) return { message: MESSAGES.quizlet, status: 422 };
  if (/^(docs|drive|mail|classroom|calendar|keep|sites)\.google\.com$/.test(h) && !/\/pub(lished)?\b|\/pubhtml/.test(p)) return { message: MESSAGES.signIn, status: 403 };
  if (/(^|\.)(notion\.so|notion\.site)$/.test(h) && !/notion\.site$/.test(h)) return { message: MESSAGES.signIn, status: 403 };
  if (/^linkedin\.com$/.test(h) && !/^\/(pulse|learning)\//.test(p)) return { message: MESSAGES.signIn, status: 403 };
  if (/^(facebook\.com|instagram\.com|outlook\.(live|office)\.com|teams\.microsoft\.com|onedrive\.live\.com|canvas\.instructure\.com|icloud\.com|dropbox\.com)$/.test(h)) return { message: MESSAGES.signIn, status: 403 };
  if (/\.(mp4|m4v|webm|mov|avi|mkv|mp3|m4a|wav|ogg|oga|flac|aac)$/i.test(p)) return { message: MESSAGES.media, status: 422 };
  if (/^(vimeo\.com|player\.vimeo\.com|dailymotion\.com|twitch\.tv|tiktok\.com|bilibili\.com|rumble\.com|ted\.com)$/.test(h) && (h !== "ted.com" || /^\/talks\//.test(p))) return { message: MESSAGES.media, status: 422 };
  return null;
}

type Kind = "html" | "text" | "image" | "data" | "media" | "pdf";
type Got = { html: string; status: number; kind: Kind; url: string; type?: string; lang?: string | null }; // lang: the content-language header

/** What a response holds, by content-type and by its first bytes (never by the file extension). */
export function kindOf(type: string, head: Uint8Array): Kind {
  const t = type.toLowerCase();
  const start = Buffer.from(head.slice(0, 512)).toString("utf8").replace(/^﻿/, "").trimStart();
  if (start.startsWith("%PDF-") || /application\/pdf/.test(t)) return "pdf";
  if (sniff(head) && !/html/.test(t)) return "image";
  if (/^(audio|video)\//.test(t)) return "media";
  if (/html|xhtml/.test(t) || /^(<!doctype html|<html|<head|<body)/i.test(start)) return "html";
  if (!t && /<(html|head|body|div|p|title|meta|script)\b/i.test(start) && !/^<\?xml|^<(rss|feed|urlset)\b/i.test(start)) return "html"; // the Unlocker sends no type
  if (/json|csv|rss|atom|(^|\/)xml|\+xml|javascript|ecmascript/.test(t) || /^[\[{]/.test(start) || /^<\?xml|^<(rss|feed|urlset)\b/i.test(start)) return "data";
  if (/^text\/(plain|markdown|x-markdown)/.test(t)) return "text";
  if (/octet-stream/.test(t)) return "media";
  return /^text\//.test(t) ? "text" : "data";
}

function decode(buf: Buffer, type: string): string {
  const cs = /charset=([\w-]+)/i.exec(type)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 2048).toString("latin1"))?.[1] ?? "utf-8";
  try {
    return new TextDecoder(cs.toLowerCase()).decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

async function readCapped(res: Response): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    parts.push(value);
    if (n > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      break; // shortcut: a page over 12 MB is read up to 12 MB; a whole-book HTML is about 0.8 MB
    }
  }
  return Buffer.concat(parts);
}

async function directOnce(url: string, signal: AbortSignal): Promise<Got> {
  const res = await safeFetch(url, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.9" }, signal });
  const type = res.headers.get("content-type") ?? "";
  const buf = await readCapped(res);
  const kind = buf.length ? kindOf(type, buf.subarray(0, 1024)) : "html";
  if (kind === "pdf" && res.ok) throw pdfSignal();
  return { html: kind === "html" || kind === "text" ? decode(buf, type) : "", status: res.status, kind, url: res.url, type, lang: res.headers.get("content-language") };
}

/** Direct fetch; an http:// link tries its https:// form first (one plain fetch is much faster than a slow insecure redirect). */
export async function direct(url: string, signal: AbortSignal): Promise<Got> {
  if (url.startsWith("http://")) {
    const secure = await directOnce(url.replace(/^http:/, "https:"), signal).catch((e) => {
      if ((e as Error).name === "IsPdf") throw e;
      return null;
    });
    if (secure && secure.status < 400) return secure;
  }
  return directOnce(url, signal);
}

const CHALLENGE = /just a moment|attention required|client challenge|are you a robot|access denied|request unsuccessful|pardon our interruption|verify (that )?you are (a )?human|captcha|checking your browser|security check|bot detection|enable javascript and cookies|_fs-ch-|cf-chl|cf_chl|px-captcha|perimeterx|incapsula|distil_r|datadome/i;
const NOT_FOUND = /\b(404|page not found|not found|page (does not|doesn'?t) exist|no longer available|cannot be found|could not be found|page unavailable|article not found)\b/i;
const NOT_FOUND_BODY = /does not have an article with this exact name|the page you (requested|are looking for) (could not be found|does not exist|was not found)|we can'?t find (that|the) page|this page (doesn'?t|does not) exist/i;
const SIGN_IN = /\b(sign in|log ?in) to (continue|view|read|access)|subscribe to (read|continue)|purchase (this )?(article|pdf)|buy (this )?article|access through your institution|get full access|rent this article|institutional login required|create a free account to (continue|read)|already a subscriber/i;
const LOGIN_FORM = /<input[^>]+type=["']?password/i;
const MAINTENANCE = /maintenance|temporarily (down|unavailable)|service unavailable|be back soon|over capacity/i;
// A page that is only a JavaScript app until it runs: the Browser API is the route that can read it, so it starts at once.
const JS_SHELL = /<div[^>]+id=["'](root|app|__next|__nuxt|main-app)["'][^>]*>\s*<\/div>|<noscript>[^<]*(enable|turn on|requires?) javascript|<app-root|ng-version=|xplore-root|window\.__INITIAL_STATE__/i;

type Why = "notFound" | "signIn" | "challenge" | "thin" | "empty" | "siteError" | "data" | "media";
type Verdict = { ok: true; twin: Twin } | { ok: false; why: Why; twin?: Twin; doi?: string | null }; // doi: the page names its paper (app/api/load then asks the open indexes)
/** Decides in code whether a fetched page is the article: never a block page, a challenge or a "not found" page read as content. */
export function verdict(got: Got | null, url: string): Verdict {
  if (!got) return { ok: false, why: "thin" };
  if (got.status === 404 || got.status === 410) return { ok: false, why: "notFound" };
  if (got.status === 401) return { ok: false, why: "signIn" };
  if (got.status === 204) return { ok: false, why: "empty" };
  if (got.kind === "data") return got.status < 400 ? { ok: false, why: "data" } : { ok: false, why: "thin" };
  if (got.kind === "media") return { ok: false, why: "media" };
  if (got.kind === "image" && got.status < 400) return { ok: true, twin: imageTwin(got.url || url, url) };
  const html = got.html;
  if (got.kind === "text" && got.status < 400) {
    if (!html.trim()) return { ok: false, why: "empty" };
    return { ok: true, twin: parseText(html, url) };
  }
  if (!html.trim()) return { ok: false, why: got.status >= 500 ? "siteError" : got.status >= 400 ? "thin" : "empty" };
  if (html.trim().length < 200) return { ok: false, why: got.status >= 500 ? "siteError" : "thin" };
  const title = /<title[^>]*>([^<]*)/i.exec(html)?.[1] ?? "";
  // A browser shows raw JSON or XML as a page with one <pre>: still data.
  const pre = /^\s*(?:<html[^>]*>)?\s*(?:<head>[\s\S]*?<\/head>)?\s*<body[^>]*>\s*<pre[^>]*>([\s\S]{0,400})/i.exec(html)?.[1]?.trimStart() ?? "";
  if (/^[\[{]\s*"|^&lt;\?xml|^<\?xml/.test(pre)) return { ok: false, why: "data" };
  const twin = parseHtml(html, url, got.lang);
  const n = chars(twin);
  const head = twin.nodes.slice(0, 6).map((x) => x.text).join(" ").slice(0, 3000);
  if ((CHALLENGE.test(title) || (n < 1500 && CHALLENGE.test(head + html.slice(0, 4000)))) && n < 3000) return { ok: false, why: "challenge" };
  if (got.status >= 500) return { ok: false, why: got.status === 503 && !MAINTENANCE.test(title + head) ? "challenge" : "siteError" };
  if (NOT_FOUND_BODY.test(head) || (NOT_FOUND.test(title) && n < 2500)) return { ok: false, why: "notFound" };
  if (!usable(twin)) return { ok: false, why: SIGN_IN.test(html) || (LOGIN_FORM.test(html) && n < 400) ? "signIn" : got.status >= 400 ? "challenge" : n === 0 && !twin.nodes.length ? "thin" : "thin", twin, doi: doiIn(html) };
  if (got.status >= 400 && n < 1500) return { ok: false, why: "challenge" }; // a 403 page with a little text is a block page
  // A publisher page with only the abstract behind a paywall: when it names its paper, the open copy is the better page.
  if (paywalled(html, n)) {
    const doi = doiIn(html);
    if (doi) return { ok: false, why: "signIn", twin, doi };
  }
  const named = /<meta[^>]+name=["']citation_(doi|title|pdf_url)["']/i.test(html) ? doiIn(html) : null;
  if (named) stated.set(twin, named);
  return { ok: true, twin };
}
/** The DOI a loaded page states in its citation meta tags (citation_doi and kin). app/api/load asks the open indexes for a copy
 * when that page is only a preview (lib/server/scholar.ts isPreview). */
const stated = new WeakMap<Twin, string>();
export const statedDoi = (t: Twin) => stated.get(t) ?? null;

/** A link straight to a picture: one figure the student can tour. */
function imageTwin(src: string, url: string): Twin {
  const name = decodeURIComponent(new URL(src).pathname.split("/").pop() ?? "").replace(/\.[a-z0-9]+$/i, "").replace(/^\d+px-/, "").replace(/[_-]+/g, " ").trim();
  return {
    id: "twin-" + createHash("sha1").update(url).digest("hex").slice(0, 8),
    source: { url, kind: "page", title: name || "Picture", via: "direct" },
    nodes: [{ id: "n01", kind: "figure", order: 1, level: null, heading: "Figure 1", text: `A picture${name ? `: ${name}` : ""}.`, image: { url: src, alt: name || null } }],
    counts: { sections: 0, figures: 1, segments: 0 },
  };
}

/** Called by app/api/load/route.ts. Returns a parsed Twin with `via` and `ms` set. Throws pageError with a plain line otherwise. */
export async function loadPage(url: string, opts: { live?: boolean } = {}): Promise<Twin> {
  const t = Date.now();
  const done = (twin: Twin, via: Twin["source"]["via"]) => {
    twin.source.via = via;
    twin.source.ms = Date.now() - t;
    return twin;
  };
  const markdownRoute = async () => {
    const { markdown, via } = await fetchMarkdown(url, opts);
    return done(parseMarkdown(markdown, url), via);
  };
  if (viaMarkdown(url)) return markdownRoute(); // the prepared demo route, unchanged

  const saved = opts.live && !offline() ? null : await read(htmlPath(url));
  if (saved?.startsWith("%PDF-")) throw pdfSignal();
  if (saved) {
    // A stored copy is served only if it still passes the same checks (older copies may hold a block page or raw data).
    const v = verdict({ html: saved, status: 200, kind: kindOf("", Buffer.from(saved.slice(0, 1024))), url }, url);
    if (v.ok) return done(v.twin, "cache");
  }
  if (offline()) throw new Error(NO_COPY);

  const log: string[] = [];
  const mark = (s: string) => log.push(`${s} ${Date.now() - t}ms`);
  const verdicts: Why[] = [];
  let doiSeen: string | null = null; // a page that named its paper but would not show it: the error carries it to app/api/load
  // A paywalled publisher page that names its paper: Bright Data would only fetch the same paywall, so stop here.
  const paywall = (v: Verdict) => {
    if (v.ok || !v.doi) return false;
    doiSeen ??= v.doi;
    if (v.why !== "signIn") return false;
    fail(pageError(MESSAGES.signIn, 403));
    return true;
  };
  type Win = { twin: Twin; via: Twin["source"]["via"]; html: string };
  let resolve!: (r: Win | null) => void;
  const winner = new Promise<Win | null>((r) => (resolve = r));
  let settled = false;
  let final = null as Error | null;
  let directSlow = false;
  let jsShell = false;
  let renderAt = 0;
  const win = (twin: Twin, via: Twin["source"]["via"], html: string) => {
    if (settled) return;
    settled = true;
    resolve({ twin, via, html });
  };
  const fail = (e: Error) => {
    if (settled) return;
    settled = true;
    final = e;
    resolve(null);
  };
  const lineFor = (why: Why): [string, number] | null =>
    why === "notFound" ? [MESSAGES.notFound, 404] : why === "empty" ? [MESSAGES.empty, 422] : why === "data" ? [MESSAGES.data, 422] : why === "media" ? [MESSAGES.media, 422] : why === "siteError" ? [MESSAGES.siteError, 502] : null;

  let unlocking: Promise<void> | null = null;
  let rendering: Promise<void> | null = null;
  const render = () =>
    (rendering ??= (async () => {
      if (settled || !process.env.BRIGHTDATA_BROWSER_WSS) return;
      renderAt = Date.now() - t;
      mark("render start");
      const { renderHtml } = await import("./remote");
      const got = await renderHtml(url, RENDER_MS).catch((e) => {
        mark(`render error ${(e as Error).message.slice(0, 80)}`);
        return null;
      });
      const v = verdict(got && { html: got.html, status: got.status ?? 200, kind: "html", url }, url);
      mark(`render ${v.ok ? "ok" : v.why}`);
      paywall(v);
      if (!v.ok) verdicts.push(v.why);
      if (v.ok) win(v.twin, "browser-api", got!.html);
    })());
  const unlocker = () =>
    (unlocking ??= (async () => {
      if (settled) return;
      mark("unlocker start");
      const slow = setTimeout(() => void render(), RENDER_AFTER_MS); // the Unlocker is slow on this site: render alongside it
      const raw = await unlock(url, { markdown: false, signal: AbortSignal.timeout(UNLOCK_MS) }).catch((e) => {
        mark(`unlocker error ${(e as Error).message.slice(0, 60)}`);
        return null;
      });
      clearTimeout(slow);
      if (raw?.trimStart().startsWith("%PDF-")) return fail(pdfSignal());
      const v = verdict(raw == null ? null : { html: raw, status: 200, kind: raw.trim() ? kindOf("", Buffer.from(raw.slice(0, 1024))) : "html", url }, url);
      mark(`unlocker ${v.ok ? "ok" : v.why}`);
      if (paywall(v)) return;
      if (!v.ok) verdicts.push(v.why);
      if (v.ok) return win(v.twin, "unlocker", raw!);
      if (v.why === "notFound") return fail(pageError(MESSAGES.notFound, 404)); // the Unlocker passes the site's own "not found" page through
      await render();
    })());

  const directRun = (async () => {
    const got = await direct(url, AbortSignal.timeout(DIRECT_MS)).catch((e) => {
      const err = e as Error & { cause?: { code?: string } };
      if (err.name === "IsPdf" || err.name === "BlockedUrl") throw e;
      if (err.name === "TimeoutError" || err.name === "AbortError") directSlow = true;
      mark(`direct error ${err.name} ${err.message.slice(0, 50)}`);
      return null;
    });
    const v = verdict(got, url);
    mark(`direct ${got?.status ?? "-"} ${got?.kind ?? ""} ${v.ok ? "ok" : v.why}${v.ok || !got ? "" : ` "${squash(/<title[^>]*>([^<]*)/i.exec(got.html)?.[1]).slice(0, 40)}" ${got.html.length}b`}`);
    if (!v.ok) verdicts.push(v.why);
    if (v.ok) return win(v.twin, "direct", got!.kind === "html" ? got!.html : "");
    if (paywall(v)) return;
    // The site itself answered plainly: no need for Bright Data.
    const line = lineFor(v.why);
    if (line) return fail(pageError(...line)); // a 503 reaches here only as a maintenance page (a 503 challenge is "challenge")
    if (v.why === "signIn" && got?.status === 401) return fail(pageError(MESSAGES.signIn, 403));
    if (got && v.why === "thin" && (got.status === 202 || JS_SHELL.test(got.html))) {
      mark("javascript shell");
      jsShell = true;
      void render();
    }
    await unlocker();
  })().catch((e) => fail(e as Error));
  const host = new URL(url).hostname;
  const before = learned.get(host);
  if (before === "browser-api") void render();
  const early = setTimeout(() => void unlocker(), before === "unlocker" ? 0 : RACE_MS); // direct is slow: start Bright Data alongside it
  // The budget: 12 s, unless a Browser API render started early because the page is a JavaScript app or the host needs it
  // (Khan Academy, IEEE): that render may run to 30 s. A render started late, as a last try, does not extend the budget.
  const budget = setTimeout(() => {
    if (!(rendering && (jsShell || before === "browser-api" || renderAt <= 4000))) fail(pageError(directSlow ? MESSAGES.slow : MESSAGES.blocked, directSlow ? 504 : 502));
  }, BUDGET_MS);
  const hard = setTimeout(() => fail(pageError(directSlow ? MESSAGES.slow : MESSAGES.blocked, 502)), HARD_MS);
  // When every route has answered and none won, the race ends with the most telling reason.
  void (async () => {
    await directRun;
    await unlocking;
    await rendering;
    if (settled) return;
    if (verdicts.includes("signIn")) return fail(pageError(MESSAGES.signIn, 403));
    const plain = verdicts.map(lineFor).find(Boolean);
    if (plain) return fail(pageError(...plain));
    fail(pageError(directSlow ? MESSAGES.slow : verdicts.length && verdicts.every((w) => w === "thin") && !log.some((l) => l.startsWith("direct 2")) ? MESSAGES.unreachable : MESSAGES.blocked, 502));
  })();

  const got = await winner;
  clearTimeout(early);
  clearTimeout(budget);
  clearTimeout(hard);
  console.log(`[fetch] ${host}${before ? ` (learned ${before})` : ""} ${got ? `won by ${got.via}` : `failed (${final?.message.slice(0, 40)})`} | ${log.join(", ")}`);
  if (!got) throw Object.assign(final ?? pageError(MESSAGES.blocked, 502), doiSeen ? { doi: doiSeen } : {});
  learned.set(host, got.via);
  if (got.html) keep(url, got.html).catch(() => {});
  return done(got.twin, got.via);
}
