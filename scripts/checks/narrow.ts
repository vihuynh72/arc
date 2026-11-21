// Run by scripts/selfcheck.ts: narrowing a broad search (lib/client/narrow.ts). Only whole subjects ask first; code holds the
// limits (four questions, no repeat, short options, level asked once); answers pick by number, ordinal or words; skip and cancel words.
import assert from "node:assert/strict";
import { resolveLocal, type Ctx } from "../../lib/intent";
import { assembled, broad, classify, MAX_QUESTIONS, nextStep, pick, questionLine, type Ex } from "../../lib/client/narrow";

export default function check() {
  for (const q of ["biology", "help me with math", "chemistry", "chemistry stuff", "computer science", "physics basics"]) assert.ok(broad(q), q);
  for (const q of ["photosynthesis openstax", "krebs cycle for first year biology", "attention all you need paper", "https://openstax.org/books/x", "cell division", "biology 2e"]) assert.ok(!broad(q), q);

  const opts = ["cells", "genetics", "evolution", "ecology"];
  assert.equal(pick("the second one", opts), 1);
  assert.equal(pick("2", opts), 1);
  assert.equal(pick("number three", opts), 2);
  assert.equal(pick("fourth", opts), 3);
  assert.equal(pick("last", opts), 3);
  assert.equal(pick("genetics please", opts), 1);
  assert.equal(pick("Ecology.", opts), 3);
  assert.equal(pick("the one about how cells divide", opts), undefined, "a long answer is the student's own words");
  assert.equal(pick("fifth", opts), undefined);

  for (const s of ["just search", "I don't know", "anything", "skip", "whatever", "doesn't matter"]) assert.equal(classify(s), "skip", s);
  for (const s of ["again", "repeat the question", "what are the options"]) assert.equal(classify(s), "again", s);
  for (const s of ["cancel", "never mind", "stop"]) assert.equal(classify(s), "cancel", s);
  assert.equal(classify("where am I"), "where");
  assert.equal(classify("search for mitosis"), "new");
  assert.equal(classify("the one about how cells divide"), "answer");

  const ex: Ex = { request: "biology", asked: [] };
  const q = { specific: false, question: "Which part of biology", options: ["cells", "genetics", "evolution", "ecology"], kind: "part" };
  assert.deepEqual(nextStep(ex, q), { ask: { question: "Which part of biology", options: opts, kind: "part" } });
  assert.deepEqual(nextStep(ex, null), { search: "biology", said: "biology" }, "a failed step searches with what there is");
  assert.deepEqual(nextStep(ex, { specific: true, query: "cell division first year college", said: "cell division, first-year college" }), { search: "cell division first year college", said: "cell division, first-year college" });
  // Never the same question twice, nor the same kind; the level not when it is known.
  const once: Ex = { request: "biology", asked: [{ q: "Which part of biology", a: "stuff", kind: "part" }] };
  assert.ok("search" in nextStep(once, q), "the same question twice");
  assert.ok("search" in nextStep(once, { ...q, question: "What area of biology interests you" }), "the same kind twice");
  assert.ok("search" in nextStep({ request: "biology", asked: [], level: "first-year college" }, { ...q, kind: "level", question: "What level" }));
  // Options short enough to say in a breath; fewer than two: no question.
  const long = nextStep(ex, { ...q, options: ["cells", "a very long option that nobody could hold in mind at once", "genetics", "evolution", "ecology", "botany"] });
  assert.deepEqual("ask" in long && long.ask.options, ["cells", "genetics", "evolution", "ecology"]);
  assert.ok("search" in nextStep(ex, { ...q, options: ["cells"] }));
  // At most four questions, whatever the model says.
  const four: Ex = { request: "biology", asked: ["part", "level", "material", "other"].map((kind, i) => ({ q: `question ${i}`, a: "hmm stuff", kind })) };
  assert.equal(four.asked.length, MAX_QUESTIONS);
  assert.deepEqual(nextStep(four, { ...q, question: "Anything else", kind: "other" }), { search: "biology hmm", said: "biology, hmm" });
  // The fallback is built in code: the subject and the answer's content words, never the raw sentence.
  const raw: Ex = { request: "biology", asked: [{ q: "Which part of biology", a: "the one about how cells divide", kind: "part" }] };
  assert.deepEqual(nextStep(raw, null), { search: "biology cells divide", said: "biology, cells divide" });
  assert.equal(assembled({ request: "biology", asked: [{ q: "x", a: "something on cell division", kind: "part" }] }), "biology cell division");
  // Skip answers are not search words.
  assert.equal(assembled({ request: "chemistry", asked: [{ q: "x", a: "organic", kind: "part" }, { q: "y", a: "I don't know", kind: "level" }] }), "chemistry organic");

  // Worded for how the student acts: a talker is never told to press; a keyboard user hears the numbers.
  const a = { question: "Which part", options: ["cells", "genetics"], kind: "part" };
  assert.equal(questionLine(a, "voice", "Biology is a big subject."), "Biology is a big subject. Which part: cells or genetics? Or say something else.");
  assert.ok(!/press/i.test(questionLine(a, "voice")));
  assert.match(questionLine(a, "keys"), /1, cells\. 2, genetics\. Press a number/);

  // Back to the list a result was opened from; "go to results" stays a paper's Results section.
  const art = { mode: "article", onKind: "section", index: 2, total: 9, canGoBack: false } as Ctx;
  assert.equal(resolveLocal("go back to the results", art)?.name, "results");
  assert.equal(resolveLocal("back to my results", art)?.name, "results");
  assert.notEqual(resolveLocal("go to results", art)?.name, "results");
}
