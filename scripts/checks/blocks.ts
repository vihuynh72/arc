// Run by scripts/selfcheck.ts: blocks derived from text have stable, ordered ids; empty text gives none; given blocks win.
import assert from "node:assert";
import { blocksOf, isText } from "../../lib/blocks";

export default function check() {
  const node = { id: "n03", kind: "section" as const, text: "First paragraph.\n\nSecond one,\nover two lines.\n\n\n\nThird." };
  const a = blocksOf(node);
  assert.deepEqual(a.map((b) => b.id), ["n03.b01", "n03.b02", "n03.b03"]);
  assert.deepEqual(a.map((b) => b.text), ["First paragraph.", "Second one,\nover two lines.", "Third."]);
  assert.deepEqual(blocksOf(node), a, "same input, same ids");
  assert.equal(blocksOf({ ...node, text: "" }).length, 0);
  assert.equal(blocksOf({ ...node, text: " \n\n \n\n" }).length, 0);
  const given = [{ id: "n03.b01", kind: "equation" as const, text: "E = mc^2", say: "E equals m c squared" }];
  assert.equal(blocksOf({ ...node, blocks: given }), given, "existing blocks win");
  assert.equal(blocksOf({ id: "n04", kind: "figure", text: "Figure 1. A caption." }).length, 0, "a figure is one stop");
  assert.equal(blocksOf({ id: "n05", kind: "segment", text: "Words.\n\nMore." }).length, 0, "a video part is one stop");
  const pdfHead = { id: "p001-n02", kind: "section" as const, level: 2, page: 1, text: "1 Introduction" };
  const pdfText = { id: "p001-n03", kind: "section" as const, level: null, page: 1, text: "A paragraph.", heading: "1 Introduction" };
  assert.equal(blocksOf(pdfHead).length, 0, "a PDF heading is a stop with no blocks");
  assert.equal(blocksOf(pdfText).length, 1, "a PDF paragraph is its text");
  assert.ok(isText(pdfText) && !isText(pdfHead) && !isText({ kind: "section", level: null }), "only page nodes without a level are text-only");
  const many = blocksOf({ id: "n09", kind: "section", text: Array.from({ length: 120 }, (_, i) => `p${i}`).join("\n\n") });
  assert.equal(many[99].id, "n09.b100");
}
