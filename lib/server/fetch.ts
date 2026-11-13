// Page fetch. MDPI and fixtures: fixtures, then .cache/pages, then Bright Data Web Unlocker markdown (live).
// Other pages: loadPage below.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Twin } from "@/lib/types";
import { unlock } from "@/lib/server/brightdata";
import { parseHtml } from "@/lib/parse/html";
import { parseMarkdown } from "@/lib/parse/markdown";

export type Fetched = { markdown: string; via: Twin["source"]["via"]; ms: number };

const liveBudget = () => Number(process.env.ARC_LIVE_BUDGET_MS) || 25_000; // env override is for the forced-timeout check
const cachePath = (url: string) => `.cache/pages/${createHash("sha1").update(url).digest("hex")}.md`;
const fixtureDir = (url: string) =>
  url.includes("1424-8220/24/6/1935") ? "lower" : url.includes("2226-4310") ? "mars" : null;
const read = (p: string) => readFile(p, "utf8").catch(() => null);

async function cached(url: string): Promise<string | null> {
  const dir = fixtureDir(url);
  return (dir && (await read(`fixtures/${dir}/main.md`))) || read(cachePath(url));
}

/** live=false: fixture or cache, else live. live=true: Unlocker; after 25 s or on error, the cached copy (the call finishes in the background and refreshes the cache). */
export async function fetchMarkdown(url: string, opts: { live?: boolean } = {}): Promise<Fetched> {
  const t = Date.now();
  const hit = await cached(url);
  if (!opts.live && hit) return { markdown: hit, via: "cache", ms: Date.now() - t };

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

// Any page that is not MDPI or a prepared fixture: plain fetch, then Bright Data raw HTML, then the markdown route.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const htmlPath = (url: string) => `.cache/pages/${createHash("sha1").update(url).digest("hex")}.html`;
const usable = (t: Twin) => t.counts.sections >= 2 || t.nodes.reduce((n, x) => n + x.text.length, 0) >= 800;
const keep = async (url: string, html: string) => {
  await mkdir(".cache/pages", { recursive: true });
  await writeFile(htmlPath(url), html);
};

async function direct(url: string): Promise<string | null> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.9" },
    redirect: "follow",
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok || !/html/i.test(res.headers.get("content-type") ?? "")) return null;
  return res.text();
}

/** Called by app/api/load/route.ts. Returns a parsed Twin with `via` and `ms` set. */
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
  if (fixtureDir(url) || /(^|\.)mdpi\.com$/i.test(new URL(url).hostname)) return markdownRoute(); // the prepared demo route, unchanged

  const saved = opts.live ? null : await read(htmlPath(url));
  if (saved) return done(parseHtml(saved, url), "cache");

  const html = await direct(url).catch(() => null);
  if (html) {
    const twin = parseHtml(html, url);
    if (usable(twin)) {
      keep(url, html).catch(() => {});
      return done(twin, "direct");
    }
  }
  try {
    const raw = await unlock(url, { markdown: false, signal: AbortSignal.timeout(25_000) });
    if (raw.trim().length < 200) throw new Error("Bright Data returned an empty page"); // HTTP 200 with an empty body is a failure
    const twin = parseHtml(raw, url);
    if (twin.nodes.length) {
      keep(url, raw).catch(() => {});
      return done(twin, "unlocker");
    }
  } catch {
    // fall through to the markdown route
  }
  const last = await markdownRoute();
  if (!last.nodes.length) throw new Error("Arc could not read this page from here. If it is open in your browser, use the Arc extension to read it from your tab.");
  return last;
}
