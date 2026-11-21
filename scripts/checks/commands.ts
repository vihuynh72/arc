// Requests that need no model (USABILITY-COMMANDS): headings and figures by name, outline numbers, find, help, orientation,
// broken links, filler, the page context a question is answered from, and the PDF's first page. Real headings from three
// documents: the MDPI paper (fixtures/lower, numbered "2.1."), Wikipedia's Photosynthesis (unnumbered, nested) and the
// arXiv PDF "Attention Is All You Need" (numbered "3.2", levels 1 and 2 from font sizes).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blocksOf } from "../../lib/blocks";
import { brokenLink, help, isQuestion, NOT_CAUGHT_LINE, resolveLocal, wordOffer, type Ctx } from "../../lib/intent";
import { byName, entriesOf, findText, findTopic, numbering, outlineCount, outlineNumber, type NodeLike, type Unit } from "../../lib/outline";
import { parseMarkdown } from "../../lib/parse/markdown";
import { tidyPage } from "../../lib/parse/pdf";
import { shortFirst, splitSentences } from "../../lib/client/reader";
import { questionContext } from "../../lib/client/voice";
import type { TwinNode } from "../../lib/types";

const mdpi = parseMarkdown(readFileSync("fixtures/lower/main.md", "utf8"), "https://www.mdpi.com/1424-8220/24/6/1935");

const mk = (rows: [string, number | null, string?][], pdf = false): NodeLike[] =>
  rows.map(([heading, level, kind], i) => ({ id: `n${String(i + 1).padStart(2, "0")}`, kind: kind ?? (level == null && !pdf ? "figure" : "section"), level, heading, ...(pdf ? { page: 1 } : {}) }));
// Wikipedia "Photosynthesis" (headings and levels as Arc's parser gives them, 2026-11)
const wiki = mk([
  ["Introduction", 2], ["Figure 1", null], ["Overview", 2], ["Photosynthetic membranes and organelles", 2], ["Light-dependent reactions", 2], ["Z scheme", 3], ["Water photolysis", 3],
  ["Light-independent reactions: Calvin cycle", 2], ["Carbon concentrating mechanisms: On land", 3], ["In water", 4], ["Order and kinetics", 2], ["Efficiency", 2], ["Evolution", 2],
  ["Symbiosis and the origin of chloroplasts", 3], ["Photosynthetic eukaryotic lineages", 3], ["Experimental history: Discovery", 2], ["Refinements", 3], ["Factors", 2],
]);
// arXiv 1706.03762 as the PDF parser gives it: the title (level 1), Abstract (level 2) and paragraphs (level null) under each
const arxiv = mk(
  [
    ["Attention Is All You Need", 1], ["Attention Is All You Need", null], ["Abstract", 2], ["Abstract", null], ["1 Introduction", 1], ["1 Introduction", null], ["2 Background", 1],
    ["3 Model Architecture", 1], ["3.1 Encoder and Decoder Stacks", 2], ["3.1 Encoder and Decoder Stacks", null], ["3.2 Attention", 2], ["3.2.1 Scaled Dot-Product Attention", 3],
    ["3.2.2 Multi-Head Attention", 3], ["3.2.3 Applications of Attention in our Model", 3], ["3.3 Position-wise Feed-Forward Networks", 2], ["4 Why Self-Attention", 1], ["5 Training", 1],
    ["5.2 Hardware and Schedule", 2], ["6 Results", 1], ["7 Conclusion", 1], ["References", 1],
  ],
  true,
);

const ctxFor = (nodes: NodeLike[], at = 0, extra: Partial<Ctx> = {}): Ctx => ({
  mode: "article", onKind: "section", index: at, total: nodes.length, canGoBack: false, label: nodes[at]?.heading, title: "T", now: 1e6, outline: entriesOf(nodes), ...extra,
});
const heading = (nodes: NodeLike[], u: string, c = ctxFor(nodes)) => {
  const r = resolveLocal(u, c);
  return r?.name === "goto" ? nodes.find((n) => n.id === r.args?.id)?.heading : r?.name === "none" ? `say: ${r.say}` : r ? r.name : null;
};

export default function check() {
  // ---- outline numbers: the document's own, or made from levels; the count of numbered top sections ----
  const m = mdpi.nodes;
  assert.equal(outlineNumber(m, m.find((n) => n.heading === "2.1. Hardware")!.id), "2.1");
  assert.equal(outlineNumber(m, m.find((n) => n.heading === "2.2.3. Segment Algorithm")!.id), "2.2.3");
  assert.equal(outlineNumber(m, m.find((n) => n.heading === "Figure 3")!.id), "2.1", "a figure belongs to the heading above it");
  assert.equal(outlineNumber(m, m.find((n) => n.heading === "Abstract")!.id), "");
  assert.equal(outlineCount(m), 5); // 1 to 5; Abstract, Funding and the rest carry no number
  const wn = numbering(entriesOf(wiki));
  assert.deepEqual(wiki.filter((n) => n.level).map((n) => wn.get(n.id)), ["1", "2", "3", "4", "4.1", "4.2", "5", "5.1", "5.1.1", "6", "7", "8", "8.1", "8.2", "9", "9.1", "10"]);
  assert.equal(outlineCount(wiki), 10);
  // the PDF: number depth decides the level, so "Abstract" (level 2 by font) is not a subsection of the title
  const ae = entriesOf(arxiv);
  assert.equal(ae.find((e) => e.label === "Abstract" && e.kind === "section")!.level, ae.find((e) => e.label === "1 Introduction")!.level);
  assert.equal(ae.find((e) => e.label === "3.2.1 Scaled Dot-Product Attention")!.level, ae.find((e) => e.label === "1 Introduction")!.level + 2);
  assert.equal(outlineCount(arxiv), 7);

  // ---- "section 2.1", "section two point one", "section 5": against those numbers ----
  assert.equal(heading(m, "section 2.1"), "2.1. Hardware");
  assert.equal(heading(m, "section two point one"), "2.1. Hardware");
  assert.equal(heading(m, "section 5"), "5. Conclusions");
  assert.equal(heading(wiki, "section 5"), "Light-independent reactions: Calvin cycle");
  assert.equal(heading(wiki, "section 4.1"), "Z scheme");
  assert.equal(heading(wiki, "section five point one point one"), "In water");
  assert.equal(heading(arxiv, "section 3.2"), "3.2 Attention");
  assert.match(heading(m, "section 9") ?? "", /could not find section 9/);
  assert.match(heading(wiki, "contents") ?? "", /^say: 10 main sections: 1, Introduction; 2, Overview;.*Say more for the subsections/);
  const mc = ctxFor(m, m.findIndex((n) => n.heading === "3. Results"));
  assert.match(heading(m, "where am i", mc) ?? "", /^say: 3 Results, section 3 of 5\./);
  assert.match(heading(wiki, "where am i", ctxFor(wiki, 5)) ?? "", /^say: Z scheme, section 4\.1, inside Light-dependent reactions\./);

  // ---- headings by name, before any model ----
  assert.match(heading(m, "go to the hardware section") ?? "", /^say: Two sections fit: 2\.1 Hardware; 3\.1 Hardware\. Say first or second\./);
  const amb = resolveLocal("go to the hardware section", ctxFor(m));
  assert.equal(heading(m, "second", ctxFor(m, 0, { list: { entries: amb!.list!, at: 1e6 } })), "3.1. Hardware");
  assert.equal(heading(m, "go to conclusions"), "5. Conclusions");
  assert.equal(heading(m, "conclusions"), "5. Conclusions");
  assert.equal(heading(m, "results"), "3. Results");
  assert.equal(heading(m, "take me to the software part"), "2.2. Software");
  assert.equal(heading(m, "go to materials and methods"), "2. Materials and Methods");
  assert.equal(heading(wiki, "go to the efficiency section"), "Efficiency");
  assert.equal(heading(wiki, "water photolysis"), "Water photolysis");
  // A request that says "section" goes to the one heading named exactly; the bare word still asks which.
  assert.equal(heading(arxiv, "go to the Attention section"), "3.2 Attention");
  assert.equal(heading(arxiv, "go to the section called Attention"), "3.2 Attention");
  assert.match(heading(arxiv, "attention") ?? "", /^say: 6 sections fit: 3\.2 Attention; 3\.2\.1 Scaled Dot-Product Attention; 3\.2\.2 Multi-Head Attention; 3\.2\.3 Applications of Attention in our Model; and more\. Say first, second, third or fourth\./);
  assert.equal(heading(arxiv, "go to the hardware section"), "5.2 Hardware and Schedule");
  // no heading words: left to the decision model (with the model out, command.ts says the not-found line)
  assert.equal(heading(m, "go to the part about how accurate it is"), null);
  assert.equal(heading(wiki, "go to the methods"), null);
  assert.equal(byName(entriesOf(m), "the summary"), undefined);

  // ---- figures and tables by number and by caption words ----
  assert.equal(heading(m, "go to figure 8"), "Figure 8");
  assert.equal(heading(m, "figure three"), "Figure 3");
  assert.match(heading(m, "go to figure 30") ?? "", /There is no figure 30 on this page/);
  assert.equal(heading(mk([["Overview", 2], ["Figure 8.2", null], ["Figure 8.3", null]]), "go to figure 8.2"), "Figure 8.2");
  const figs = mdpi.nodes.filter((n) => n.kind === "figure");
  const cm = figs.find((n) => /confusion matrix/i.test(n.text));
  if (cm) assert.equal(heading(m, "the confusion matrix figure"), cm.heading);
  const units: Unit[] = mdpi.nodes.flatMap((n) => (n.kind === "figure" ? [{ id: n.id, b: -1, where: n.heading, text: `${n.heading}. ${n.text}` }] : blocksOf(n).map((b, k) => ({ id: n.id, block: b.id, b: k, where: n.heading, text: b.text }))));
  const t1 = resolveLocal("table 1", ctxFor(m, 0, { units }));
  assert.equal(t1?.name, "land");
  assert.match(units.find((u) => u.block === t1?.args?.block)?.text ?? "", /Table 1/);

  // ---- find words on the page ----
  const sr = findText(units, "sampling rate");
  assert.ok(sr.length >= 1, "sampling rate is in the paper");
  assert.ok(sr.every((u) => /sampling rate/i.test(u.text)));
  assert.deepEqual(resolveLocal("find sampling rate", ctxFor(m, 0, { units })), { name: "find", args: { query: "sampling rate" } });
  assert.deepEqual(resolveLocal("search this page for sampling rate", ctxFor(m, 0, { units })), { name: "find", args: { query: "sampling rate" } });
  assert.deepEqual(resolveLocal("where does it mention dynamic time warping", ctxFor(m, 0, { units })), { name: "find", args: { query: "dynamic time warping" } });
  assert.deepEqual(resolveLocal("next match", ctxFor(m)), { name: "findNext", args: { by: 1 } });
  assert.deepEqual(resolveLocal("previous match", ctxFor(m)), { name: "findNext", args: { by: -1 } });
  const stack = [{ id: "p3", b: 0, where: "3.1", text: "Encoder: The encoder is composed of a stack of N equals 6 identical layers." }];
  assert.equal(findText(stack, "stack of N identical layers").length, 1, "all words, any order, when the phrase is not there");
  assert.equal(findText(stack, "identical stacks").length, 1, "plural aside");
  assert.equal(findText(stack, "decoder").length, 0);
  // a bare word that is no command but is on the page: an offer to find it, once the decision step did not place it
  assert.equal(resolveLocal("bluetooth", ctxFor(m, 0, { units })), null, "the decision step decides first (a command in another language)");
  const bare = wordOffer("bluetooth", ctxFor(m, 0, { units }));
  assert.match(bare?.say ?? "", /^Bluetooth is on this page \d+ times\. Say yes to go to the first\.$/);
  assert.deepEqual(bare?.offer, { name: "find", args: { query: "bluetooth" } });
  assert.equal(heading(m, "hardware", ctxFor(m, 0, { units }))?.startsWith("say: Two sections fit"), true, "a heading's name beats a find");

  // ---- help, for the place ----
  const land: Ctx = { mode: "landing", onKind: null, index: -1, total: 0, canGoBack: false };
  for (const c of [land, ctxFor(m), ctxFor(m, 3, { onKind: "figure" }), ctxFor(m, 0, { mode: "tour" }), ctxFor(arxiv, 0, { paged: true }), ctxFor(m, 0, { mode: "video" }), ctxFor(m, 0, { mode: "results" })]) {
    const h = help(c);
    const n = h.split(/(?<=\.)\s+/).length;
    assert.ok(n >= 3 && n <= 6, `${c.mode}/${c.onKind}: ${n} sentences: ${h}`);
    for (const w of ["help", "what can you do", "how does this work", "Help?"]) assert.equal(resolveLocal(w, c)?.say, h, w);
    assert.equal(resolveLocal("more help", c)?.say, help(c, true));
  }
  assert.notEqual(help(ctxFor(m)), help(ctxFor(m, 3, { onKind: "figure" })));
  assert.match(help(ctxFor(arxiv, 0, { paged: true })), /page and a number/);

  // ---- orientation from state ----
  const pdf = ctxFor(arxiv, 10, { paged: true, page: 3, pages: 15, read: { total: 6000, left: 4500 }, rate: 1.25, counts: { sections: 20, figures: 0 }, next: "3.2.1 Scaled Dot-Product Attention" });
  assert.equal(resolveLocal("what page am I on", pdf)?.say, "Page 3 of 15.");
  assert.equal(resolveLocal("which page is this", pdf)?.say, "Page 3 of 15.");
  assert.equal(resolveLocal("how many pages", pdf)?.say, "15 pages. You are on page 3.");
  assert.equal(resolveLocal("how long is this", pdf)?.say, "15 pages, about 29 minutes of reading at this speed.");
  assert.equal(resolveLocal("how much is left", pdf)?.say, "About 22 minutes left in this document, from page 3 of 15.");
  assert.equal(resolveLocal("what comes next", pdf)?.say, "Next: 3.2.1 Scaled Dot-Product Attention.");
  assert.equal(resolveLocal("what section is this", pdf)?.say, "3.2 Attention, inside 3 Model Architecture.");
  assert.equal(resolveLocal("read the title", pdf)?.say, "The title is T.");
  assert.match(resolveLocal("what page am I on", ctxFor(m))?.say ?? "", /not split into numbered pages/);
  assert.match(resolveLocal("what page am i on", land)?.say ?? "", /Nothing is open/);

  // ---- broken links, filler, stop, speed, vague requests ----
  assert.equal(brokenLink("htp:/biology notes week 3"), "biology notes week 3");
  assert.equal(brokenLink("https://en.wikipedia.org/wiki/Mitosis"), undefined);
  assert.equal(brokenLink("www.biology notes"), "biology notes");
  assert.equal(brokenLink("note: buy milk"), undefined);
  const bl = resolveLocal("htp:/biology notes week 3", land);
  assert.equal(bl?.say, "That does not look like a link. Do you want me to search for biology notes week 3? Say yes.");
  assert.deepEqual(resolveLocal("yes", { ...land, pendingOffer: { ...bl!.offer!, at: 1e6 - 1000 }, now: 1e6 }), { name: "search", args: { query: "biology notes week 3" }, say: "Searching for biology notes week 3." });
  for (const w of ["um", "uh", "hmm", "um uh", "Uhh...", "er"]) assert.equal(resolveLocal(w, ctxFor(m))?.say, NOT_CAUGHT_LINE, w);
  for (const w of ["stop", "be quiet", "shut up", "pause", "stop it", "quiet please"]) assert.deepEqual(resolveLocal(w, ctxFor(m)), { name: "stop" }, w);
  assert.deepEqual(resolveLocal("slower", ctxFor(m)), { name: "slower" });
  assert.deepEqual(resolveLocal("much slower", ctxFor(m)), { name: "slower", steps: 3 });
  assert.deepEqual(resolveLocal("normal speed", ctxFor(m)), { name: "slower", args: { normal: true } });
  assert.deepEqual(resolveLocal("faster", ctxFor(m)), { name: "faster" });
  for (const w of ["go back to the other part", "back to where i was", "take me back"]) assert.deepEqual(resolveLocal(w, ctxFor(m)), { name: "return" }, w);
  assert.deepEqual(resolveLocal("that figure", ctxFor(m, 0, { lastFigure: "n04" })), { name: "goto", args: { id: "n04" } });
  assert.match(resolveLocal("that figure", ctxFor(m))?.say ?? "", /Which figure/);
  assert.deepEqual(resolveLocal("the other one", ctxFor(m, 0, { list: { entries: amb!.list!, at: 1e6 } })), { name: "goto", args: { id: amb!.list![0].id } });

  // ---- with no page open, a typed sentence is a search; a question goes to the models ----
  assert.deepEqual(resolveLocal("photosynthesis for bio 101", land), { name: "search", args: { query: "photosynthesis for bio 101" }, say: "Searching for photosynthesis for bio 101." });
  assert.deepEqual(resolveLocal("I want to study mitosis", land), { name: "search", args: { query: "mitosis" }, say: "Searching for mitosis." });
  assert.equal(resolveLocal("what is a photoautotroph", land), null);
  assert.equal(resolveLocal("photosynthesis for bio 101", { ...land, mode: "results", total: 6, index: 0 }), null); // in the results the decision step tells a new search from "go back to the paper"
  assert.equal(resolveLocal("make the text bigger", land), null);
  assert.ok(isQuestion("what does the belt unit contain") && !isQuestion("sampling rate"));
  // a question with a document open is not a find, and not a heading
  assert.equal(resolveLocal("what does the belt unit contain", ctxFor(m, 0, { units })), null);

  // ---- the page context a question is answered from (12,000 characters at most) ----
  const q = questionContext(mdpi, "what does the belt unit contain", m[0].id);
  assert.ok(q.length <= 12000, String(q.length));
  assert.match(q, /RELEVANT: 2\.1\. Hardware: The hardware devices are mainly composed of the following modules/, "2.1 Hardware is in the context");
  assert.match(q, /Microcontroller unit/);
  assert.ok(q.startsWith(`Title: ${mdpi.source.title}`));
  const qc = questionContext(mdpi, "what does the belt unit contain", m.find((n) => n.heading === "4. Discussion")!.id);
  assert.ok(qc.indexOf("THE SECTION THE STUDENT IS IN: 4. Discussion") < qc.indexOf("RELEVANT:"), "the cursor's section first");

  for (const [question, fact] of [
    ["how accurate was the activity recognition", /97\.4%/],
    ["what does the belt unit contain", /Lithium battery charging module/],
    ["what will the authors do next", /future research will implement/i],
  ] as const) {
    const c = questionContext(mdpi, question, m.find((n) => n.heading === "1. Introduction")!.id);
    assert.ok(c.length <= 12000 && fact.test(c), `${question}: ${fact}`);
  }
  // The telling word wins over the common ones ("future" over "study"), even with the room that recent reading takes:
  // this exact question got "I did not find that" in a live session.
  const next = questionContext(mdpi, "what do the authors say they will do next, after this study?", m[0].id, 12000, "x ".repeat(900));
  assert.match(next, /future research will implement/i);
  assert.ok(next.length <= 12000, String(next.length));
  // what was read aloud lately always goes with the question
  const heardIt = questionContext(mdpi, "give me the number", m[0].id, 6000, "A two-layer LSTM model was used with an average accuracy of 97.4%.");
  assert.match(heardIt, /READ ALOUD TO THE STUDENT IN THE LAST FEW MINUTES[^]*97\.4%/);

  // ---- a topic that is not a heading: the page's words, "accurate" reaching "accuracy" ----
  const acc = findTopic(units, "where they talk about how accurate it is");
  assert.deepEqual(acc.words, ["accurate"]);
  assert.equal(acc.list[0].id, m[0].id, "the abstract's 97.4% accuracy comes first");
  const bt = findTopic(units, "the part about Bluetooth and how the data is sent");
  assert.ok(bt.list.length >= 1 && bt.list.every((u) => /bluetooth/i.test(u.text)), String(bt.words));
  assert.ok(findTopic(units, "Bluetooth").list.length >= 2);

  // ---- the abstract sentence before a number is spoken whole (it was the harness's still-talking estimate that cut it) ----
  const abs = blocksOf(m[0]).flatMap((b) => shortFirst(splitSentences(b.text)).lines);
  assert.ok(abs.includes("A two-layer long short-term memory (LSTM) model was used for fitness activity recognition (FAR) with an average accuracy of 97.4%."));

  // ---- a PDF's first page: the permission notice after the title, authors and abstract; repeated titles dropped ----
  const p1: TwinNode[] = [
    { id: "p001-n01", kind: "section", order: 1001, level: null, page: 1, heading: "Page 1", text: "Provided proper attribution is provided, Google hereby grants permission to reproduce the tables and figures in this paper solely for use in journalistic or scholarly works." },
    { id: "p001-n02", kind: "section", order: 1002, level: 1, page: 1, heading: "Attention Is All You Need", text: "Attention Is All You Need" },
    { id: "p001-n03", kind: "section", order: 1003, level: 1, page: 1, heading: "Attention Is All You Need", text: "Attention Is All You Need" },
    { id: "p001-n04", kind: "section", order: 1004, level: null, page: 1, heading: "Attention Is All You Need", text: "Ashish Vaswani, Google Brain." },
    { id: "p001-n05", kind: "section", order: 1005, level: 2, page: 1, heading: "Abstract", text: "Abstract" },
    { id: "p001-n06", kind: "section", order: 1006, level: null, page: 1, heading: "Abstract", text: "The dominant sequence transduction models are based on complex recurrent networks." },
  ];
  const t = tidyPage(1, p1, "Attention Is All You Need");
  assert.deepEqual(t.map((n) => n.id), ["p001-n02", "p001-n04", "p001-n05", "p001-n06", "p001-n01"]);
  assert.deepEqual(t.map((n) => n.order), [1001, 1002, 1003, 1004, 1005]);
  const p2: TwinNode[] = [
    { id: "p002-n01", kind: "section", order: 2001, level: 1, page: 2, heading: "Attention Is All You Need", text: "Attention Is All You Need" },
    { id: "p002-n02", kind: "section", order: 2002, level: 1, page: 2, heading: "1 Introduction", text: "1 Introduction" },
  ];
  assert.deepEqual(tidyPage(2, p2, "Attention Is All You Need").map((n) => n.id), ["p002-n02"]);
  assert.equal(tidyPage(3, p2.slice(1), "Attention Is All You Need")[0].order, 2002, "nothing to move: untouched");
}
