import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fetchMarkdown } from "../../lib/server/fetch";

export default async function check() {
  for (const [url, dir] of [
    ["https://www.mdpi.com/1424-8220/24/6/1935", "lower"],
    ["https://www.mdpi.com/2226-4310/11/1/1", "mars"],
  ]) {
    const r = await fetchMarkdown(url);
    assert.equal(r.via, "cache");
    assert.equal(r.markdown, readFileSync(`fixtures/${dir}/main.md`, "utf8"));
  }
}
