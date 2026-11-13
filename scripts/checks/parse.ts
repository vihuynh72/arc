import assert from "node:assert";
import { readFileSync } from "node:fs";
import { parseMarkdown } from "../../lib/parse/markdown";

export default function check() {
  const md = readFileSync("fixtures/lower/main.md", "utf8");
  const twin = parseMarkdown(md, "https://www.mdpi.com/1424-8220/24/6/1935");
  assert.ok(twin.source.title.startsWith("Development of Wearable Devices"), twin.source.title);

  const distinct = new Set([...md.matchAll(/^\s*\*\*(Figure \d+)\./gm)].map((m) => m[1]));
  const figures = twin.nodes.filter((n) => n.kind === "figure");
  assert.equal(figures.length, distinct.size);
  assert.equal(new Set(figures.map((f) => f.text)).size, figures.length, "figure captions repeat");
  assert.ok(figures.every((f) => f.image?.url.startsWith("https://mdpi-res.com/")));

  for (const n of twin.nodes) assert.ok(!/Propose a Journal|Journal Finder/.test(n.heading + n.text), n.id);
  assert.match(twin.source.credit ?? "", /CC BY|Creative Commons/);
  assert.deepEqual(
    twin.counts,
    {
      sections: twin.nodes.filter((n) => n.kind === "section").length,
      figures: figures.length,
      segments: 0,
    },
  );
  assert.deepEqual(twin.nodes.map((n) => n.id).slice(0, 2), ["n01", "n02"]);

  const mars = parseMarkdown(readFileSync("fixtures/mars/main.md", "utf8"), "https://www.mdpi.com/2226-4310/9/10/604");
  assert.ok(mars.counts.figures >= 1);
}
