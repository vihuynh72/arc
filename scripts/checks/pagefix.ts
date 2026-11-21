// Run by scripts/selfcheck.ts: the page clean-up drops and re-voices blocks by id, never the held or the spoken one, and changes nothing twice.
import assert from "node:assert";
import { applyFix } from "../../lib/client/pageFix";
import type { TwinNode } from "../../lib/types";

export default function check() {
  const blocks = [0, 1, 2, 3].map((k) => ({ id: `n01.b0${k + 1}`, kind: "paragraph" as const, text: `T${k + 1}.` }));
  const nodes = [{ id: "n01", kind: "section", order: 1, level: 2, heading: "H", text: blocks.map((b) => b.text).join("\n\n"), blocks }] as TwinNode[];
  const fix = { drop: ["n01.b01", "n01.b03"], say: { "n01.b04": "four" } };
  const a = applyFix(nodes, fix);
  assert.deepEqual(a[0].blocks?.map((b) => b.id), ["n01.b02", "n01.b04"], "ids stay, dropped ones go");
  assert.equal(a[0].blocks?.[1].say, "four");
  assert.equal(a[0].text, "T2.\n\nT4.", "text follows the blocks");
  assert.equal(applyFix(a, fix), a, "nothing to change: same array");
  const held = applyFix(nodes, fix, "n01.b03", "n01.b04");
  assert.deepEqual(held[0].blocks?.map((b) => b.id), ["n01.b02", "n01.b03", "n01.b04"], "the block under the cursor stays");
  assert.equal(held[0].blocks?.[2].say, undefined, "a block being spoken keeps its words");
  const all = applyFix(nodes, { drop: blocks.map((b) => b.id), say: {} });
  assert.equal(all[0].blocks?.length, 0);
  assert.equal(all[0].text, "", "all dropped: no block comes back from the text");
}
