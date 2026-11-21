// Understanding natural requests, offline: what Arc does with a decision (routeDecision), a reply after an answer, a wish
// reduced to its subject, help that says how to leave, and the state the decision step and the question session are sent.
import assert from "node:assert";
import { decisionState, help, resolveLocal, routeDecision, searchQuery, type Ctx } from "../../lib/intent";
import { broad, classify } from "../../lib/client/narrow";
import { modelCommand, questionContext } from "../../lib/client/voice";
import type { Twin } from "../../lib/types";

export default function check() {
  const now = 1_000_000;
  const page: Ctx = { mode: "article", onKind: "section", index: 2, total: 9, canGoBack: false, label: "2.1 Hardware", now, how: "voice" };
  const thread: Ctx = { ...page, thread: { q: "what is a quaternion", a: "A quaternion is four numbers for a turn in space.", at: now - 5000 } };
  const d = (action: string, confidence = 0.9, act = true) => ({ action, confidence, act, query: "" });

  // A: a request to leave a tour is never the next stop; the local forms leave at once.
  const tour: Ctx = { ...page, mode: "tour", onKind: "figure", stop: "stop 2 of 6: thigh" };
  for (const u of ["That is enough", "that's enough", "get me out", "no more picture"]) assert.equal(resolveLocal(u, tour)?.name, "leave", u);
  assert.deepEqual(routeDecision("Leave it and take me back to the reading", tour, d("leave")), { to: "act", name: "leave" });
  // an unsure non-question in a tour: its help, never a move
  assert.equal(routeDecision("no more picture please", tour, d("none", 0.7, false)).to, "help");

  // G, F, 3: after an answer, a reply goes to the question session: never the word search, a web search or a move it did not ask.
  for (const [u, dd] of [["explain me this more simple please", d("question", 0.8, false)], ["no, I mean quaternion... more simple", d("find")], ["yes please, that would be lovely, a book chapter", d("search")], ["and the second one?", d("none", 0.5, false)]] as const)
    assert.equal(routeDecision(u, thread, dd).to, "question", u);
  assert.equal(resolveLocal("yes", thread), null, "a yes with no offer, after an answer: a reply");
  assert.deepEqual(routeDecision("next", thread, d("next")), { to: "act", name: "next" }, "a command still runs after an answer");
  assert.equal(decisionState(thread).arc_last_said, thread.thread!.a, "the decision step hears Arc's last answer");
  assert.equal(decisionState(page).arc_last_said, undefined);
  assert.equal(decisionState({ ...thread, now: now + 200_000 }).arc_last_said, undefined, "an old answer is no thread");
  // 3b: the word search only for an explicit find
  assert.equal(routeDecision("this is really interesting", page, d("none", 0.99, false)).to, "notUnderstood");
  assert.equal(routeDecision("where does it mention bluetooth", page, d("question", 0.5, false)).to, "find");

  // E, M: a wish is reduced to its subject; a whole subject is the narrowing path; nothing to study is the help line.
  const land: Ctx = { mode: "landing", onKind: null, index: -1, total: 0, canGoBack: false, how: "voice", now };
  for (const [u, q] of [
    ["I want to study biology, I have a quiz on Friday", "biology"],
    ["Hello dear, I'd like to learn a bit of biology today if that's all right", "biology"],
    ["I need to revise chemistry for my exam next week", "chemistry"],
    ["I have a test on Monday about the nervous system", "nervous system"],
    ["hi, I'm revising the cold war for my history exam", "cold war"],
  ]) {
    assert.equal(searchQuery(u), q, u);
    const r = resolveLocal(u, land);
    assert.equal(r?.name, "search", u);
  }
  assert.equal(broad("biology"), true);
  for (const u of ["hello", "I'm new here", "good morning"]) assert.equal(resolveLocal(u, land)?.say, help(land), u);
  // 5: the student's words, whole
  assert.equal(searchQuery("search for lstm exercise recognition"), "lstm exercise recognition");

  // B, I, C, N: results
  const res: Ctx = { mode: "results", onKind: "result", index: 0, total: 3, canGoBack: false, behind: "Wearable devices", results: ["Result 1: A (pubmed.ncbi.nlm.nih.gov)", "Result 2: B (openstax.org)", "Result 3: C (sciencedirect.com)"], how: "voice", now };
  assert.equal(resolveLocal("go back", res)?.name, "leave", "go back with a page behind the results: back to the page");
  assert.equal(resolveLocal("go back", { ...res, behind: undefined })?.name, "return");
  assert.equal(resolveLocal("More.", res)?.name, "moreResults");
  assert.equal(resolveLocal("go back to the list", page)?.name, "results");
  for (const u of ["read me the results", "did you find anything", "what did you find"]) assert.equal(resolveLocal(u, res)?.name, "results", u); // the list read out, never a search for those words

  // O: after a find, "next one" is the next match
  assert.equal(resolveLocal("next one", { ...page, findAt: now - 2000 })?.name, "findNext");
  assert.equal(resolveLocal("next one", page)?.name, "next");

  // P, K: every mode's help says how to leave it; a tour's two forms agree
  assert.match(help(tour), /that's enough to leave/i);
  assert.match(help({ ...tour, how: "both" }), /that's enough, or press Escape, to leave/i);
  assert.match(help({ ...tour, how: "keys" }), /Escape leaves the tour/);
  assert.match(help(res), /go back to return to your page/);

  // K: "I don't know" at a narrowing question searches the subject in general
  assert.equal(classify("I really don't know"), "skip");
  assert.equal(classify("not now"), "cancel");

  // 3, S: what the question session is sent: the paper's details always; a model search may use her earlier words, never page text
  const twin = { id: "t", source: { url: "https://x.org", kind: "page", title: "Paper", via: "direct" }, nodes: [
    { id: "d", kind: "section", level: 2, heading: "Details", text: "Authors: A. Kim and B. Lee. Published 2024 in Sensors." },
    { id: "n1", kind: "section", level: 2, heading: "Methods", text: "We used a belt unit." },
  ], counts: { sections: 2, figures: 0, segments: 0 } } as unknown as Twin;
  assert.match(questionContext(twin, "who wrote this", "n1", 12000), /DETAILS OF THIS DOCUMENT: Authors: A\. Kim/);
  assert.deepEqual(modelCommand("search", { query: "photosynthesis book chapter" }, twin, ["yes please, a book chapter", "photosynthesis for beginners"]), { query: "photosynthesis book chapter" });
  assert.equal(modelCommand("search", { query: "buy cheap watches" }, twin, ["yes please"]), null);
  assert.equal(modelCommand("open", { url: "https://evil.example" }, twin, ["yes"]), null, "a model-made open to an address not on the page is dropped");
}
