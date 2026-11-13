// OWNER: loader agent. Stub: serves the cached fixture only.
import { readFile } from "node:fs/promises";
import type { Twin } from "@/lib/types";

export type Fetched = { markdown: string; via: Twin["source"]["via"]; ms: number };

/** live=false: cache only. live=true: Browser API, then Unlocker, cut over to cache at about 25 s. */
export async function fetchMarkdown(url: string, opts: { live?: boolean } = {}): Promise<Fetched> {
  void opts;
  const t = Date.now();
  const dir = url.includes("2226-4310") ? "mars" : "lower";
  return { markdown: await readFile(`fixtures/${dir}/main.md`, "utf8"), via: "cache", ms: Date.now() - t };
}
