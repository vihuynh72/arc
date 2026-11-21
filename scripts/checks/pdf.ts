// Offline check for lib/parse/pdf.ts and the quick stage of lib/server/pdf.ts, run by `npm run selfcheck`. The PDF is made
// here with pdf-lib (no fixture file): 3 pages, two columns, a running header and page numbers, a bold heading, a hyphen.
import assert from "node:assert";
import { PDFDocument, PDFHexString, rgb, StandardFonts } from "pdf-lib";
import { cleanBlocks, cleanBox, equationsOf, fitEquationBox, fitEquations, isPdf, joinLines, mergeNodes, toNodes, type Item, type PageText } from "../../lib/parse/pdf";
import { pdfPage, pdfTwin, PdfError } from "../../lib/server/pdf";
import { writeFile } from "../../lib/server/vault";

const LEFT = ["Left one starts the page and runs on", "to a second line with an exam-", "ple that wraps here at the end."];
const RIGHT = ["Right one follows the left column", "and ends the story on this page."];

async function make() {
  const doc = await PDFDocument.create();
  const reg = await doc.embedFont(StandardFonts.TimesRoman), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let n = 1; n <= 3; n++) {
    const p = doc.addPage([612, 792]);
    p.drawText("Arc Test Journal, Volume 7", { x: 72, y: 760, size: 9, font: reg });
    p.drawText(String(n), { x: 300, y: 30, size: 9, font: reg });
    p.drawText(`Section ${n} Heading`, { x: 72, y: 700, size: 16, font: bold });
    // Right column drawn first so content-stream order is wrong and only geometry gives the right order.
    RIGHT.forEach((t, i) => p.drawText(t, { x: 320, y: 660 - i * 13, size: 10, font: reg }));
    LEFT.forEach((t, i) => p.drawText(t, { x: 72, y: 660 - i * 13, size: 10, font: reg }));
    for (let i = 0; i < 4; i++) {
      p.drawText(`Filler left line ${i + 1} of page ${n} keeps the column long`, { x: 72, y: 600 - i * 13, size: 10, font: reg });
      p.drawText(`Filler right line ${i + 1} of page ${n} keeps it long`, { x: 320, y: 600 - i * 13, size: 10, font: reg });
    }
  }
  return doc.save();
}

export default async function check() {
  assert.equal(joinLines(["an exam-", "ple"]), "an example");
  assert.equal(joinLines(["well-", "Known"]), "well- Known"); // a capital after the hyphen is not a broken word
  assert.ok(isPdf(new TextEncoder().encode("\n\n%PDF-1.7 rest")));
  assert.ok(!isPdf(new TextEncoder().encode("<!doctype html><html></html>")));

  const bytes = await make();
  assert.ok(isPdf(bytes));
  const twin = await pdfTwin(bytes, "file://check.pdf");
  assert.equal(twin.source.kind, "pdf");
  assert.equal(twin.pdf?.pages, 3);
  const p2 = await pdfPage(twin.pdf!.id, 2);
  const texts = p2.nodes.map((n) => n.text);
  assert.ok(!texts.some((t) => /Arc Test Journal/.test(t)), `running header kept: ${texts.join(" | ")}`);
  assert.ok(!texts.some((t) => /^\d+$/.test(t)), "page number kept");
  assert.equal(p2.nodes[0].level !== null && p2.nodes[0].text, "Section 2 Heading");
  const body = texts.join(" ");
  assert.ok(body.includes("an example that wraps"), `hyphen not joined: ${body}`);
  assert.ok(body.indexOf("Left one") < body.indexOf("Filler left line 4") && body.indexOf("Filler left line 4") < body.indexOf("Right one"), `column order wrong: ${body}`);
  assert.ok(p2.nodes.every((n) => /^p002-n\d\d$/.test(n.id)) && new Set(p2.nodes.map((n) => n.id)).size === p2.nodes.length);
  assert.equal(p2.stage, "full"); // nothing on this page needs the model
  const again = await pdfPage(twin.pdf!.id, 2);
  assert.deepEqual(again.nodes.map((n) => n.id), p2.nodes.map((n) => n.id));

  // Full stage over quick: matching text keeps its id, a new equation gets an "f" id, malformed blocks are dropped.
  const quick = toNodes(4, [{ kind: "heading", text: "Results", level: 2 }, { kind: "paragraph", text: "The loss falls as the model grows larger over time." }]);
  const blocks = cleanBlocks({ blocks: [{ kind: "heading", text: "Results", level: 2 }, { kind: "equation", text: "Equation 1: x squared plus 2 x." }, { kind: "poem", text: "x" }, { kind: "paragraph", text: "" }, { kind: "paragraph", text: "The loss falls as the model grows larger over time, as shown." }] });
  assert.equal(blocks.length, 3);
  const merged = mergeNodes(4, quick, blocks);
  assert.deepEqual(merged.map((n) => n.id), ["p004-n01", "p004-f01", "p004-n02"]);

  await assert.rejects(pdfTwin(new TextEncoder().encode("<html>not a pdf</html>"), "x"), (e) => e instanceof PdfError && /not a PDF/.test(e.message));

  // Figures: a drawing above a "Figure 2:" caption gets its box from code; the card says "Figure 2" and the caption does not repeat it.
  const fig = await PDFDocument.create();
  const fp = fig.addPage([612, 792]);
  const ff = await fig.embedFont(StandardFonts.TimesRoman);
  fp.drawText("Some body text above the figure that runs across the column width.", { x: 72, y: 720, size: 10, font: ff });
  fp.drawRectangle({ x: 200, y: 450, width: 200, height: 200, color: rgb(0.2, 0.4, 0.8) });
  fp.drawText("Encoder", { x: 270, y: 660, size: 9, font: ff }); // a label just above the drawing belongs to it
  fp.drawText("Figure 2: (left) The block diagram.", { x: 220, y: 430, size: 9, font: ff });
  fp.drawText("Body text resumes below the caption and keeps going for a while longer.", { x: 72, y: 380, size: 10, font: ff });
  const ft = await pdfTwin(await fig.save(), "file://fig.pdf", { origin: "http://localhost:3000" });
  const fn = ft.nodes.find((n) => n.kind === "figure")!;
  assert.equal(fn.heading, "Figure 2");
  assert.equal(fn.text, "(left) The block diagram.");
  const [y0, x0, y1, x1] = ft.figures[fn.id].box_2d;
  // x: the rectangle (200..400 pt); top: above the rectangle's own top (179) because the "Encoder" label joins; bottom: the
  // rectangle's foot (432), clear of the caption (its top is at about 446).
  assert.ok(Math.abs(x0 - 327) <= 3 && Math.abs(x1 - 654) <= 3 && y0 > 140 && y0 < 175 && Math.abs(y1 - 432) <= 3, `box ${ft.figures[fn.id].box_2d}`);
  assert.ok(fn.image?.url.startsWith("http://localhost:3000/api/pdf/figure?id=") && fn.image.url.endsWith(`&box=${ft.figures[fn.id].box_2d.join(",")}`));
  assert.ok(!ft.nodes.some((n) => n.text === "Encoder"), "a label inside the figure was read as page text");

  // Model boxes: nested array accepted, out of range clamped, slivers and a box inside an earlier one dropped; a model label wins.
  assert.deepEqual(cleanBox([[100, 200, 400, 1200]]), [100, 200, 400, 1000]);
  assert.equal(cleanBox([100, 200, 110, 900]), undefined);
  assert.equal(cleanBox([0, 0, 1000, 1000]), undefined);
  const mb = cleanBlocks({ blocks: [{ kind: "figure", text: "A plot. Figure 3: Loss.", label: "Fig. 3", box_2d: [100, 100, 500, 900] }, { kind: "figure", text: "Inset.", box_2d: [150, 150, 450, 850] }] });
  assert.ok(mb[0].box && !mb[1].box);
  const mn = toNodes(5, mb);
  assert.equal(mn[0].heading, "Figure 3");
  assert.equal(mn[0].text, "A plot. Loss.");
  assert.equal(mn[1].heading, "Figure on page 5");

  // Equation boxes. One page: prose at y 700, the formula at 660 with its number "(1)" at the right margin, prose at 620 (PDF points,
  // 612 x 792). The formula is about 157..170 on the 0..1000 scale, rows 119 and 207 are the prose lines' edges.
  const it = (str: string, x: number, y: number, w: number, math = false): Item => ({ str, x, y, w, size: 10, bold: false, math });
  const page: PageText = {
    n: 4, width: 612, height: 792, images: 0,
    items: [
      it("The attention function maps a query and a set of key value pairs to an output where all are vectors", 72, 700, 468),
      it("Attention(Q, K, V ) = softmax( QK T / dk ) V", 200, 660, 300, true),
      it("(1)", 520, 660, 15),
      it("We compute the dot products of the query with all keys, divide each by the root, and apply a softmax", 72, 620, 468),
      it("pings provide reasonable preconditioning.", 72, 560, 200), // a short last line and a heading: neither is prose, neither is a formula
      { ...it("3.2. Identity Mapping by Shortcuts", 72, 540, 240), size: 12, bold: true },
    ],
  };
  const inside = (b: number[] | undefined, y: number, x0: number, x1: number) => !!b && b[0] <= y && b[2] >= y + 12 && b[1] <= x0 && b[3] >= x1;
  const tight = fitEquationBox([150, 320, 175, 880], page);
  assert.ok(inside(tight, 157, 327, 874) && tight![0] > 119 && tight![2] < 207, `tight ${tight}`); // formula and number kept, padded, prose not reached
  const tall = fitEquationBox([100, 100, 230, 900], page); // swallows the prose above and below: cut back to the formula
  assert.ok(inside(tall, 157, 327, 874) && tall![0] >= 119 && tall![2] <= 207, `tall ${tall}`);
  const clipped = fitEquationBox([150, 320, 175, 700], page); // the printed number is outside the model's box: taken in
  assert.ok(clipped![3] >= 874, `clipped ${clipped}`);
  assert.equal(fitEquationBox([100, 72, 120, 900], page), undefined, "a box holding only prose"); // the first prose line
  assert.equal(fitEquationBox([310, 72, 370, 500], page), undefined, "a box on a heading and a short line, not on the formula (ResNet's Equation 1)");
  assert.equal(fitEquationBox([150, 320, 175, 880], page, "2"), undefined, "the printed number is another equation's");
  assert.ok(fitEquationBox([150, 320, 175, 880], page, "1"));
  assert.equal(fitEquationBox([500, 100, 540, 800], page), undefined, "a box over bare paper");
  assert.ok(fitEquationBox([500, 100, 540, 800], { ...page, graphics: [[60, 360, 560, 400]] }), "a drawing (a scan, vector math) is under it");
  assert.ok(fitEquationBox([500, 100, 540, 800], { ...page, paths: 80 }), "a page drawn as vectors");
  assert.equal(fitEquationBox([1100, 0, 1300, 500], page), undefined, "outside the page");
  assert.equal(fitEquationBox([200, 0, 700, 1000], page), undefined, "half the page tall");
  assert.equal(fitEquationBox([150, 500, 175, 500], page), undefined, "zero width");
  assert.equal(fitEquationBox([150, 500, 150, 900], page), undefined, "zero height");
  assert.equal(fitEquationBox([150, 320, "x", 880], page), undefined, "not numbers");
  assert.deepEqual(fitEquationBox([[150, 320, 175, 880]], undefined), [144, 312, 181, 888], "no text lines (a scan): the box is kept, padded");
  assert.equal(fitEquationBox([2, 2, 9, 9], undefined), undefined, "a speck");
  // Through the model's output: a good box is kept as `box` (and the model's as `was`), a bad one leaves the words alone.
  const eb = fitEquations(cleanBlocks({ blocks: [{ kind: "equation", text: "Equation 1: x plus y.", box_2d: [150, 320, 175, 880] }, { kind: "equation", text: "Equation 2: y.", box_2d: [200, 0, 700, 1000] }, { kind: "equation", text: "Equation 3: z." }, { kind: "paragraph", text: "Words.", box_2d: [150, 320, 175, 880] }] }), page);
  assert.ok(eb[0].box && eb[0].was?.join() === "150,320,175,880" && !eb[1].box && eb[1].was && !eb[2].box && !eb[2].was && !eb[3].box);
  // An equation is not a figure: it has `image` and a box of its own, and the figure counts and the figure map stay as they were.
  const eqn = toNodes(2, eb.slice(0, 3));
  assert.deepEqual(Object.keys(equationsOf(eqn, eb)), [eqn[0].id]);
  const stored = (v: number | undefined, blocks: unknown[]) => writeFile(`.cache/pdf/${twin.pdf!.id}/p002.full.json`, JSON.stringify({ blocks, model: "test", ms: 1, ...(v ? { v } : {}) }));
  await stored(3, eb.slice(0, 3));
  const ep = await pdfPage(twin.pdf!.id, 2, "http://localhost:3000");
  const en = ep.nodes.find((n) => n.heading === "Equation" && n.image);
  assert.ok(en && en.kind === "section" && en.image!.url.startsWith("/api/pdf/figure?id=") && /&as=equation&size=353x29$/.test(en.image!.url) && en.image!.alt === en.text, `equation node ${JSON.stringify(en)}`);
  assert.equal(ep.nodes.filter((n) => n.image).length, 1);
  assert.equal(ep.nodes.filter((n) => n.kind === "figure").length, 0);
  assert.deepEqual(ep.figures, {});
  assert.deepEqual(Object.keys(ep.equations), [en!.id]);
  assert.equal(ep.stage, "full");
  await stored(2, eb.slice(0, 3));
  assert.equal((await pdfPage(twin.pdf!.id, 2)).stage, "quick", "a page read before equations had boxes is read again");
  await stored(2, [{ kind: "paragraph", text: "No math here, nothing to box." }]);
  assert.equal((await pdfPage(twin.pdf!.id, 2)).stage, "full", "a page with no equation is not read again");
  await writeFile(`.cache/pdf/${twin.pdf!.id}/p002.full.json`, "null"); // leave no stored pass behind: later checks read this page quick

  // A password-locked file: a Standard security handler whose U entry the empty password cannot match.
  const enc = await PDFDocument.create();
  enc.addPage();
  const ctx = enc.context;
  ctx.trailerInfo.Encrypt = ctx.register(ctx.obj({ Filter: "Standard", V: 1, R: 2, Length: 40, P: -44, O: PDFHexString.of("00".repeat(32)), U: PDFHexString.of("11".repeat(32)) }));
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of("ab".repeat(16)), PDFHexString.of("ab".repeat(16))]);
  await assert.rejects(pdfTwin(await enc.save({ useObjectStreams: false }), "x"), (e) => e instanceof PdfError && /password/.test(e.message));
}
