// Live by default: which route a live fetch takes, and ARC_OFFLINE=1 serving stored copies only, with no network.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fetchMarkdown, liveRoute, loadPage } from "../../lib/server/fetch";

export default async function check() {
  assert.equal(liveRoute("https://www.mdpi.com/1424-8220/24/6/1935"), "brightdata");
  assert.equal(liveRoute("https://en.wikipedia.org/wiki/Photosynthesis"), "direct");
  const was = process.env.ARC_OFFLINE;
  process.env.ARC_OFFLINE = "1";
  const real = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("no network in offline mode"))) as typeof fetch;
  try {
    const r = await fetchMarkdown("https://www.mdpi.com/1424-8220/24/6/1935", { live: true });
    assert.equal(r.via, "cache");
    assert.equal(r.markdown, readFileSync("fixtures/lower/main.md", "utf8"));
    await assert.rejects(loadPage("https://example.invalid/never-stored", { live: true }), /offline/);
  } finally {
    globalThis.fetch = real;
    if (was === undefined) delete process.env.ARC_OFFLINE;
    else process.env.ARC_OFFLINE = was;
  }
}
