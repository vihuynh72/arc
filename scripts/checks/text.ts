// Offline check for lib/parse/text.ts: a plain-text book becomes sections from its chapter lines, paragraphs from blank lines.
import assert from "node:assert";
import { parseText } from "../../lib/parse/text";

export default function check() {
  const txt = `Title: A Small Book\r\n\r\n*** START OF THE PROJECT GUTENBERG EBOOK A SMALL BOOK ***\r\n\r\nPREFACE\r\n\r\nA word before.\r\n\r\nCHAPTER I.\r\n\r\nIt is a truth\r\nwidely known.\r\n\r\nA second paragraph.\r\n\r\nChapter 2\r\n\r\nThe end.\r\n\r\n*** END OF THE PROJECT GUTENBERG EBOOK ***\r\nLicence text.`;
  const t = parseText(txt, "https://example.org/book.txt");
  assert.equal(t.source.title, "A Small Book");
  assert.deepEqual(t.nodes.map((n) => [n.heading, n.blocks?.map((b) => b.text)]), [
    ["PREFACE", ["A word before."]],
    ["CHAPTER I.", ["It is a truth widely known.", "A second paragraph."]],
    ["Chapter 2", ["The end."]],
  ]);
  assert.ok(!JSON.stringify(t).includes("Licence"), "Gutenberg's licence is cut");
  assert.equal(t.nodes[1].blocks?.[1].id, "n02.b02");

  // An RFC: running page headers and footers, a table of contents with dot leaders, and "name = rule" lines are not headings or prose.
  const page = (n: number) => `RFC 2616                        HTTP/1.1                       June 1999\n\nA paragraph on page ${n} that runs\nacross two lines.\n\nFielding, et al.            Standards Track                    [Page ${n}]\n\f`;
  const rfc = parseText(`Network Working Group\n\n1 Introduction ........................ 9\n2 Notation ............................ 12\n\n${page(1)}\n${page(2)}\nCRLF = CR LF\n\n${page(3)}`, "https://example.org/rfc.txt");
  const all = JSON.stringify(rfc);
  assert.ok(!/RFC 2616 +HTTP|\[Page|Introduction \.\.\.|Notation \.\./.test(all), all);
  assert.ok(all.includes("A paragraph on page 1 that runs across two lines."));
  assert.ok(!rfc.nodes.some((n) => /CRLF/.test(n.heading)), "an ABNF rule is not a heading");
  const num = parseText("Intro line.\n\n1.1 Purpose\n\nThis specification defines things.\n\n1. If the first item applies, do the thing.\n\n- PUT: - DELETE: - POST\n", "https://example.org/n.txt");
  assert.deepEqual(num.nodes.map((n) => n.heading), ["Beginning", "1.1 Purpose"], "a numbered title is a heading; a numbered sentence and a caps list are not");
  // reStructuredText / setext: a title over ===== is a heading, and the page title.
  const rst = parseText("Linux kernel\n============\n\nThe Linux kernel is the core.\n\nBuilding\n--------\n\nRun make.\n", "https://example.org/README");
  assert.equal(rst.source.title, "Linux kernel");
  assert.deepEqual(rst.nodes.map((n) => [n.heading, n.blocks?.map((b) => b.text)]), [["Linux kernel", ["The Linux kernel is the core."]], ["Building", ["Run make."]]]);
}
