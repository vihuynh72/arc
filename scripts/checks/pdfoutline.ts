// A PDF's whole-document outline (lib/server/pdf.ts pdfOutline, lib/outline.ts withToc and headingOn, lib/intent.ts): the file's
// bookmarks numbered back from their nesting, headings found by the quick stage when it has none, and the grammar resolving
// "section 3.2", a name and "next section" to an entry on a page not loaded yet. Offline, no keys.
import assert from "node:assert/strict";
import { PDFDocument, PDFHexString, PDFName, StandardFonts, type PDFRef } from "pdf-lib";
import { PAGES_ONLY, resolveLocal, type Ctx } from "../../lib/intent";
import { headingOn, TOC_ID, withToc, type NodeLike, type TocEntry } from "../../lib/outline";
import { pdfPage, pdfTwin } from "../../lib/server/pdf";

async function make(marks: boolean, tag: string) {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold), reg = await doc.embedFont(StandardFonts.TimesRoman);
  ["1 Introduction", "1.1 Scope", "2 Methods"].forEach((h, k) => {
    const p = doc.addPage([612, 792]);
    if (!k) p.drawText("A Test Paper", { x: 72, y: 740, size: 24, font: bold }); // the title: not an entry
    p.drawText(h, { x: 72, y: 700, size: 16, font: bold });
    for (let i = 0; i < 6; i++) p.drawText(`Line ${i + 1} of page ${k + 1} (${tag}) keeps the text long enough to read.`, { x: 72, y: 660 - i * 13, size: 10, font: reg });
  });
  if (marks) {
    // Bookmarks without numbers, as arXiv's are: Introduction > Scope, then Methods.
    const c = doc.context;
    const [root, a, b, d] = [c.nextRef(), c.nextRef(), c.nextRef(), c.nextRef()];
    const dest = (n: number) => c.obj([doc.getPage(n).ref, "XYZ", null, null, null]);
    const item = (title: string, parent: PDFRef, n: number, more: Record<string, PDFRef | number>) => c.obj({ Title: PDFHexString.fromText(title), Parent: parent, Dest: dest(n), ...more });
    c.assign(root, c.obj({ Type: "Outlines", First: a, Last: d, Count: 2 }));
    c.assign(a, item("Introduction", root, 0, { Next: d, First: b, Last: b, Count: 1 }));
    c.assign(b, item("Scope", a, 1, {}));
    c.assign(d, item("Methods", root, 2, { Prev: a }));
    doc.catalog.set(PDFName.of("Outlines"), root);
  }
  return doc.save();
}

export default async function check() {
  // Bookmarks: in the first response, numbered from their nesting.
  const t = await pdfTwin(await make(true, "marks"), "file://outline-marks.pdf");
  assert.deepEqual(t.pdf?.outline, [
    { title: "1 Introduction", page: 1, level: 1 },
    { title: "1.1 Scope", page: 2, level: 2 },
    { title: "2 Methods", page: 3, level: 1 },
  ]);

  // No bookmarks: not in the first response; the quick stage's headings arrive with a later page reply.
  const u = await pdfTwin(await make(false, "plain"), "file://outline-plain.pdf");
  let o: TocEntry[] | undefined;
  for (let k = 0; k < 50 && !o; k++) o = (await pdfPage(u.pdf!.id, 1)).outline ?? (await new Promise((r) => setTimeout(r, 50)), undefined);
  assert.deepEqual(o?.map((e) => [e.title, e.page]), [["1 Introduction", 1], ["1.1 Scope", 2], ["2 Methods", 3]]);

  // The grammar over pages 1 and 2 loaded plus the outline of a 15-page paper.
  const nodes: NodeLike[] = [
    { id: "p001-n01", kind: "section", level: 1, heading: "Attention Is All You Need", page: 1 },
    { id: "p001-n02", kind: "section", level: 3, heading: "Abstract", page: 1 },
    { id: "p001-n03", kind: "section", level: null, heading: "", text: "The dominant models...", page: 1 },
    { id: "p002-n01", kind: "section", level: 3, heading: "1 Introduction", page: 2 },
    { id: "p002-n02", kind: "section", level: 3, heading: "2 Background", page: 2 },
    { id: "p002-n03", kind: "section", level: 3, heading: "3 Model Architecture", page: 2 },
  ];
  const toc: TocEntry[] = [
    ["1 Introduction", 2, 1], ["2 Background", 2, 1], ["3 Model Architecture", 2, 1], ["3.1 Encoder and Decoder Stacks", 3, 2], ["3.2 Attention", 3, 2],
    ["3.2.1 Scaled Dot-Product Attention", 4, 3], ["3.2.2 Multi-Head Attention", 4, 3], ["4 Why Self-Attention", 6, 1], ["5 Training", 7, 1], ["7 Conclusion", 10, 1],
  ].map(([title, page, level]) => ({ title, page, level }) as TocEntry);
  const outline = withToc(nodes, toc);
  assert.deepEqual(outline.filter((e) => e.kind === "section").map((e) => e.label).slice(0, 7), ["Attention Is All You Need", "Abstract", "1 Introduction", "2 Background", "3 Model Architecture", "3.1 Encoder and Decoder Stacks", "3.2 Attention"], "loaded headings once, then the pages not loaded");
  assert.ok(outline.every((e, k) => !k || e.i > outline[k - 1].i), "in reading order");
  const pageOf = Object.fromEntries([...nodes.map((n) => [n.id, n.page!]), ...toc.map((e, k) => [`${TOC_ID}${k}`, e.page])]);
  const ctx = (id: string, extra: Partial<Ctx> = {}): Ctx => ({ mode: "article", onKind: "section", index: nodes.findIndex((n) => n.id === id), total: nodes.length, canGoBack: false, now: 1e6, paged: true, page: 2, pages: 15, title: "Attention Is All You Need", outline, pageOf, whole: true, ...extra });
  const go = (u: string, c = ctx("p002-n01")) => {
    const r = resolveLocal(u, c);
    return r?.name === "goto" ? toc[Number(String(r.args?.id).slice(TOC_ID.length))]?.title ?? r.args?.id : r?.say;
  };
  assert.equal(go("section 3.2"), "3.2 Attention");
  assert.equal(go("go to section three point two point one"), "3.2.1 Scaled Dot-Product Attention");
  assert.equal(go("go to the attention section"), "3.2 Attention");
  assert.equal(go("go to the conclusion"), "7 Conclusion");
  assert.equal(go("next section", ctx("p002-n03")), "4 Why Self-Attention", "across a page boundary, past the subsections");
  assert.equal(go("next subsection", ctx("p002-n03")), "3.1 Encoder and Decoder Stacks");
  const p = resolveLocal("which page does the training section start on", ctx("p002-n01"));
  assert.equal(p?.say, "5 Training starts on page 7 of 15. Say yes to go there.");
  assert.equal(p?.offer?.args?.id, `${TOC_ID}8`);
  assert.match(go("contents") ?? "", / main sections: .*; 3 Model Architecture; 4 Why Self-Attention; 5 Training; 7 Conclusion\. Say more/);

  // Nothing known beyond the loaded pages: the honest line, not "I could not find".
  const part = (id: string) => ctx(id, { outline: withToc(nodes), whole: false, pageOf: undefined });
  assert.equal(go("section 3.2", part("p002-n01")), PAGES_ONLY);
  assert.equal(go("which page does the training section start on", part("p002-n01")), PAGES_ONLY);
  assert.equal(go("next section", part("p002-n03")), PAGES_ONLY);
  assert.match(go("contents", part("p002-n01")) ?? "", new RegExp(`${PAGES_ONLY.replace(/\./g, "\\.")}$`));

  // Landing on a loaded page: by number, else by words, else the page's top (undefined).
  const page3: NodeLike[] = [{ id: "p003-n01", kind: "section", level: 3, heading: "3.1 Encoder and Decoder Stacks", page: 3 }, { id: "p003-n04", kind: "section", level: 3, heading: "3.2. Attention", page: 3 }];
  assert.equal(headingOn(page3, 3, "3.2 Attention"), "p003-n04");
  assert.equal(headingOn(page3, 3, "Encoder and decoder stacks"), "p003-n01");
  assert.equal(headingOn(page3, 3, "3.3 Feed-Forward"), undefined);
}
