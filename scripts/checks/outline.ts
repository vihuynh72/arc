// Moving around headings by number and relation, orientation lines, lists and ordinals (lib/outline.ts through lib/intent.ts).
import assert from "node:assert/strict";
import { resolveLocal, type Ctx } from "../../lib/intent";
import { labelMatches, numOf, parseRef, type Entry } from "../../lib/outline";

const mk = (rows: [string, number][], numbered = true): Entry[] =>
  rows.map(([label, level], i) => {
    const n = numbered ? numOf(label) : undefined;
    return { i, id: `n${String(i + 1).padStart(2, "0")}`, label, level, kind: level ? "section" : "other", ...(n ? { num: n.num, pre: n.pre } : {}) };
  });

// A numbered paper: abstract, 1 Intro, 2 Methods (2.1 Hardware, 2.2 Software), 3 Results (3.1, 3.2 Attention), Appendix A (A.1 Proofs), Appendix B
const paper = mk([
  ["Abstract", 2], ["1 Introduction", 2], ["2. Materials and Methods", 2], ["2.1. Hardware", 3], ["2.2. Software", 3],
  ["3 Results", 2], ["3.1 Setup", 3], ["3.2 Attention", 3], ["Figure 1", 0], ["4 Discussion", 2], ["Appendix A: Extra", 2], ["A.1 Proofs", 3], ["Appendix B", 2],
]);
// Wikipedia style: no numbers, nested
const wiki = mk(
  [["Overview", 2], ["Light reactions", 2], ["Photosystems", 3], ["Electron transport", 3], ["Calvin cycle", 2], ["Evolution", 2], ["Origin", 3], ["C4 plants", 3]],
  false,
);
const base: Ctx = { mode: "article", onKind: "section", index: 0, total: 13, canGoBack: false, label: "x", now: 100_000 };
const at = (o: Entry[], id: string, extra: Partial<Ctx> = {}): Ctx => ({ ...base, outline: o, index: o.findIndex((e) => e.id === id), total: o.length, ...extra });
const to = (u: string, c: Ctx) => {
  const r = resolveLocal(u, c);
  return r?.name === "goto" ? (r.args?.id as string) : r?.name === "none" ? `say: ${r.say}` : (r?.name ?? null);
};
const label = (o: Entry[], id: string) => o.find((e) => e.id === id)?.label;
const go = (o: Entry[], u: string, c: Ctx) => {
  const t = to(u, c);
  return t?.startsWith("n") ? label(o, t) : t;
};

export default function check() {
  // numbering at the start of headings
  assert.deepEqual(numOf("3.2 Attention"), { num: ["3", "2"], pre: undefined });
  assert.deepEqual(numOf("2.1. Hardware")?.num, ["2", "1"]);
  assert.deepEqual(numOf("A.1 Proofs")?.num, ["A", "1"]);
  assert.deepEqual(numOf("Appendix B")?.num, ["B"]);
  assert.equal(numOf("Appendix B: Proofs")?.pre, "appendix");
  assert.deepEqual(numOf("1 Introduction")?.num, ["1"]);
  assert.equal(numOf("A Study of Gait"), undefined); // the article, not appendix A
  assert.equal(numOf("C4 plants"), undefined);
  assert.equal(numOf("C3: C4 photosynthesis research"), undefined);
  assert.deepEqual(numOf("A1. Proofs")?.num, ["A", "1"]);
  assert.equal(numOf("Abstract"), undefined);
  assert.equal(numOf("3D printing"), undefined);
  assert.equal(numOf("2020 report"), undefined);

  // spoken references
  for (const [u, text] of [["section 3.2", "3.2"], ["go to section 3.2", "3.2"], ["three point two", "3.2"], ["two point one", "2.1"], ["three dot two", "3.2"], ["section four", "4"], ["section A1", "A1"], ["section a.1", "A.1"], ["appendix B", "B"], ["chapter 4", "4"], ["3.2", "3.2"], ["Go to section three point two.", "3.2"]] as const)
    assert.equal(parseRef(u)?.text, text, u);
  for (const u of ["go to the summary", "section", "page 12", "3", "next section", "figure 2", "take me to methods"]) assert.equal(parseRef(u), undefined, u);
  assert.equal(parseRef("appendix b")?.pre, "appendix");

  // by number, in a numbered paper (typed or spoken forms)
  const c = at(paper, "n01");
  assert.equal(go(paper, "section 3", c), "3 Results");
  assert.equal(go(paper, "go to section 3.2", c), "3.2 Attention");
  assert.equal(go(paper, "three point two", c), "3.2 Attention");
  assert.equal(go(paper, "two point one", c), "2.1. Hardware");
  assert.equal(go(paper, "section four", c), "4 Discussion");
  assert.equal(go(paper, "section A1", c), "A.1 Proofs");
  assert.equal(go(paper, "appendix B", c), "Appendix B");
  assert.equal(go(paper, "appendix A", c), "Appendix A: Extra");
  assert.match(to("section 9", c) ?? "", /could not find section 9/);
  assert.match(to("appendix D", c) ?? "", /could not find appendix D/);
  assert.equal(to("where am i", at(paper, "n06")), "say: 3 Results, section 3 of 4."); // as the paper numbers them: Abstract and the appendices carry no plain number
  // subsection N is relative to the current top level section
  assert.equal(go(paper, "subsection 2", at(paper, "n03")), "2.2. Software");
  assert.equal(go(paper, "subsection 2", at(paper, "n07")), "3.2 Attention"); // from inside Results
  assert.match(to("subsection 5", at(paper, "n03")) ?? "", /no subsection 5/);

  // no numbers in the headings: by position
  const w = at(wiki, "n01");
  assert.equal(go(wiki, "section 3", w), "Calvin cycle");
  assert.equal(go(wiki, "section 2.2", w), "Electron transport");
  assert.equal(go(wiki, "two point one", w), "Photosystems");
  assert.equal(go(wiki, "subsection 2", at(wiki, "n03")), "Electron transport");
  assert.match(to("section 9", w) ?? "", /could not find section 9/);

  // two candidates: ask in one line, then "second" picks
  const twin = mk([["Intro", 2], ["Hardware design", 2], ["Hardware setup", 2]], false);
  assert.deepEqual(labelMatches(twin, "go to the hardware").map((e) => e.label), ["Hardware design", "Hardware setup"]);
  assert.deepEqual(labelMatches(twin, "hardware design"), []); // one exact name is not ambiguous
  assert.deepEqual(labelMatches(twin, "intro"), []); // one hit: Decision handles it
  const dup = mk([["1 Intro", 2], ["Appendix 1", 2]]);
  const ask = resolveLocal("section 1", at(dup, "n01"));
  assert.equal(ask?.name, "none");
  assert.match(ask?.say ?? "", /Two sections fit: 1 Intro; Appendix 1\. Say first or second\./);
  assert.equal(ask?.list?.length, 2);
  const after = at(dup, "n01", { list: { entries: ask!.list!, at: 100_000 } });
  assert.equal(go(dup, "second", after), "Appendix 1");
  assert.equal(go(dup, "the first one", after), "1 Intro");
  assert.equal(resolveLocal("second", { ...after, list: { entries: ask!.list!, at: 1 } }), null); // an old list is not used

  // by relation
  assert.equal(go(paper, "next section", at(paper, "n04")), "2.2. Software"); // from 2.1: the sibling
  assert.equal(go(paper, "next section", at(paper, "n05")), "3 Results"); // from 2.2: no sibling before 2 ends, so the next heading
  assert.equal(go(paper, "next section", at(paper, "n03")), "3 Results"); // 2 -> 3, same level
  assert.equal(go(paper, "previous section", at(paper, "n06")), "2. Materials and Methods");
  assert.equal(go(paper, "next subsection", at(paper, "n03")), "2.1. Hardware"); // from a section: its first subsection
  assert.equal(go(paper, "next subsection", at(paper, "n04")), "2.2. Software");
  assert.match(to("next subsection", at(paper, "n05")) ?? "", /last subsection/);
  assert.equal(go(paper, "previous subsection", at(paper, "n05")), "2.1. Hardware");
  assert.equal(go(paper, "first subsection", at(paper, "n03")), "2.1. Hardware");
  assert.equal(go(paper, "up", at(paper, "n08")), "3 Results");
  assert.equal(go(paper, "parent section", at(paper, "n05")), "2. Materials and Methods");
  assert.match(to("up", at(paper, "n06")) ?? "", /top level/);
  assert.match(to("next section", at(paper, "n13")) ?? "", /last section/);
  assert.equal(go(wiki, "next section", at(wiki, "n04")), "Calvin cycle"); // the last subsection of Light reactions: no sibling after, so the next heading
  assert.deepEqual(resolveLocal("top", c), { name: "goto", args: { at: 0 } }); // unchanged
  assert.equal(resolveLocal("move up", c)?.name, "prev"); // unchanged

  // orientation and lists
  assert.equal(to("where am i", at(paper, "n08", { para: { at: 2, of: 5 } })), "say: 3.2 Attention, inside 3 Results. Paragraph 2 of 5.");
  const cont = resolveLocal("what sections are there", c);
  assert.match(cont?.say ?? "", /^7 (?:main )?sections: Abstract|^\d+ (?:main )?sections: /);
  assert.equal(cont?.list?.length, 7);
  assert.equal(go(paper, "the third one", at(paper, "n01", { list: { entries: cont!.list!, at: 100_000 } })), "2. Materials and Methods");
  const inside = resolveLocal("what is in this section", at(paper, "n03"));
  assert.match(inside?.say ?? "", /^2 Materials and Methods has 2 subsections: 2\.1 Hardware; 2\.2 Software\.$/); // a heading's number is said without its dot
  assert.match(to("outline", w) ?? "", /4 (?:main )?sections: 1, Overview; 2, Light reactions/);

  // not on article pages, or without headings: the grammar is silent and Decision decides as before
  assert.equal(resolveLocal("section 3", { ...c, mode: "results" }), null);
  assert.equal(resolveLocal("section 3", { ...c, outline: undefined }), null);
  assert.equal(resolveLocal("go to the summary", c), null);
}
