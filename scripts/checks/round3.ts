// Round 3 of the simulated users: the word search only when asked for, results "more", repeat and how-much-left, "the next",
// "where am I" on a figure. Pure: lib/intent.ts and lib/outline.ts.
import assert from "node:assert";
import { distinctWords, figureWhere, isQuestion, resolveLocal, wordSearchAllowed, type Ctx } from "../../lib/intent";
import { findText, findTopic, sameWord, sentenceWith, type Entry, type Unit } from "../../lib/outline";

// A find starts reading at the sentence holding the words: in the demo paper's abstract that is the accuracy sentence, not the
// top of the paragraph and not the earlier sentence with "inaccurately".
const abstract = ["Lower extremity exercises are considered a low-cost method.", "Patients often tend to inaccurately report the number of exercises performed.", "A two-layer LSTM model was used with an average accuracy of 97.4%.", "The system is cost-effective."];
assert.equal(sentenceWith(abstract, "accurate"), 2);
assert.equal(sentenceWith(abstract, "exercises performed"), 1); // the sentence with both words beats the earlier one with one
assert.equal(sentenceWith(abstract, "bluetooth"), 0); // nothing holds it: from the top

// Questions in a learner's word order still read as questions, so an unsure decision step sends them to be answered (lib/client/command.ts).
for (const q of ["how much it cost, this system?", "what it means, quaternion?", "explain me this more simple please", "the sensors, they are five?"]) assert.ok(isQuestion(q), q);
for (const q of ["um", "blah blah what", "photosynthesis for bio 101"]) assert.ok(!isQuestion(q), q);

const outline: Entry[] = [
  { i: 0, id: "n01", label: "Abstract", level: 2, kind: "section" },
  { i: 1, id: "n02", label: "1. Introduction", level: 2, kind: "section", num: [1] },
  { i: 2, id: "n03", label: "2. Materials and Methods", level: 2, kind: "section", num: [2] },
  { i: 3, id: "n04", label: "Figure 1. The proposed system architecture of the wearable devices.", level: 0, kind: "other", figure: true },
  { i: 4, id: "n05", label: "3. Results", level: 2, kind: "section", num: [3] },
] as Entry[];
const art: Ctx = { mode: "article", onKind: "section", index: 2, total: 5, canGoBack: false, outline, now: 1, read: { total: 5000, left: 1400 }, rate: 1.25, counts: { sections: 4, figures: 1 } };
const unsure = { action: "none", act: false };

export default function check() {
  // A: the three sentences that hit the word search are placed by meaning
  assert.equal(resolveLocal("walk me through that picture bit by bit, please", art)?.name, "tour");
  assert.equal(resolveLocal("skip ahead a bit", art)?.name, "next");
  assert.deepEqual(distinctWords("go to where they talk about how accurate it is"), ["accurate"]);
  assert.ok(wordSearchAllowed("go to where they talk about how accurate it is", unsure));
  // ten ordinary requests the decision step may be unsure of: never the word search
  for (const u of [
    "explain me this more simple please", "what does this paragraph mean", "i want to hear the last part again", "let's move on to the next thing",
    "tell me more about this", "can you go a bit slower", "okay keep going", "could you say that again please", "is there a picture here", "what is this figure about",
  ])
    assert.equal(wordSearchAllowed(u, unsure), false, u);
  // a sure decision is never second-guessed by the word search
  assert.equal(wordSearchAllowed("where they talk about the belt", { action: "goto", act: true }), false);
  // five explicit finds: always allowed; the first four are the local find at once
  for (const u of ["find sampling rate", "search for bluetooth", "where does it mention the battery", "look for accuracy", "where they talk about the belt"])
    assert.ok(wordSearchAllowed(u, unsure), u);
  for (const u of ["find sampling rate", "search for bluetooth", "where does it mention the battery", "look for accuracy"]) assert.equal(resolveLocal(u, art)?.name, "find", u);
  // whole words by stem, from the word's start
  assert.ok(sameWord("accurate", "accuracy") && sameWord("accurate", "accurately") && sameWord("sampling", "sample"));
  assert.ok(!sameWord("accurate", "inaccurately") && !sameWord("rate", "rated") && !sameWord("data", "database"));
  const units: Unit[] = [
    { id: "a", b: 0, where: "Abstract", text: "The step counts were recorded inaccurately by the phone." },
    { id: "b", b: 0, where: "Results", text: "Accuracy reached 97.4% with the belt and Bluetooth." },
    { id: "c", b: 0, where: "Discussion", text: "The belt sends data over Bluetooth to the app; Bluetooth keeps the belt small." },
  ];
  assert.deepEqual(findTopic(units, "", ["accurate"]).list.map((u) => u.id), ["b"]);
  const two = findTopic(units, "", ["bluetooth", "belt", "battery"]);
  assert.deepEqual(two.list.map((u) => u.id), ["b", "c"]); // both hold two of the three words: page order
  assert.deepEqual(two.matched, ["bluetooth", "belt"]);
  assert.deepEqual(findText(units, "accurate").map((u) => u.id), ["b"]);

  // D: "more" in results reads the next three
  const res: Ctx = { mode: "results", onKind: "result", index: 0, total: 10, canGoBack: false, results: Array.from({ length: 10 }, (_, i) => `Result ${i + 1}: Paper ${i + 1} (openalex.org)`) };
  for (const u of ["more", "more results", "the others", "next ones", "the other results", "the rest", "read more"]) assert.equal(resolveLocal(u, res)?.name, "moreResults", u);
  assert.equal(resolveLocal("open the second one", res)?.name, "open");

  // E: the last sentence by name; how much is left, locally and exactly
  assert.deepEqual(resolveLocal("say that last sentence again", art), { name: "read", args: { sentence: true, page: true } });
  const left = "About 7 minutes left on this page, 1 section.";
  for (const u of ["how much is left", "how much more is there", "how much of the page is left", "how many sections are left", "how much longer is this", "could you tell me how much is left please", "is there much left", "how much of this page is still left to go"])
    assert.equal(resolveLocal(u, art)?.say, left, u);
  assert.match(resolveLocal("how much is left", { ...art, mode: "tour", stop: "stop 2 of 6: belt", tourStops: 6 })?.say ?? "", /Stop 2 of 6/);

  // F: "the next" means next
  for (const u of ["go the next one", "next one", "the next", "the next one"]) assert.equal(resolveLocal(u, art)?.name, "next", u);

  // H: "where am I" on a figure: the place, then the offer
  const onFig = { ...art, onKind: "figure" as const, index: 3, how: "voice" as const };
  assert.equal(resolveLocal("where am I", onFig)?.say, "Figure 1, in 2 Materials and Methods, section 2 of 3. Say tour to explore it.");
  assert.equal(figureWhere(outline, { ...onFig, how: "keys" }), "Figure 1, in 2 Materials and Methods, section 2 of 3. Press Enter to explore it.");
}
