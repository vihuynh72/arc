// Page fetch: fixtures, then .cache/pages, then Bright Data Web Unlocker (live).
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Twin } from "@/lib/types";
import { unlock } from "@/lib/server/brightdata";

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
