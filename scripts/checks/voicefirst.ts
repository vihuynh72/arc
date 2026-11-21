// Voice alone: the requests a student who only talks makes, said the way people say them (polite wrappers, filler, two clauses),
// the prompt wording for how the student has been acting, spoken search results and the spoken search query.
import assert from "node:assert/strict";
import { mumbled, NOT_CAUGHT_LINE, notUnderstood, polite, questionSource, resolveLocal, searchQuery, type Ctx } from "../../lib/intent";
import { cue, opening, OPENING, paused, PAUSED, resultsTail, tourOffer, tourStart } from "../../lib/keys";
import { entriesOf } from "../../lib/outline";
import { preferSource, resultLine, siteName, type Result } from "../../components/twin/Results";

// A chapter: title, two sections with paragraphs, a figure in the second section, a third section.
const nodes = [
  { id: "n0", kind: "section", level: 2, heading: "8.1 Overview of Photosynthesis" },
  { id: "n1", kind: "section", level: 3, heading: "Main Structures and Summary of Photosynthesis" },
  { id: "n2", kind: "section", level: 3, heading: "The Two Parts of Photosynthesis" },
  { id: "n3", kind: "figure", level: null, heading: "Figure 8.2", text: "Photosynthesis takes place in chloroplasts." },
  { id: "n4", kind: "section", level: 2, heading: "8.2 The Light-Dependent Reactions" },
];
const outline = entriesOf(nodes);
const blocks = [2, 4, 3, 0, 5];
const base: Ctx = { mode: "article", onKind: "section", index: 1, total: 5, canGoBack: false, label: "Main Structures", title: "Photosynthesis", now: 100_000, outline, blocks, para: { at: 2, of: 4 }, how: "voice", read: { total: 3000, left: 1200 }, rate: 1.25 };
const art = (o: Partial<Ctx> = {}): Ctx => ({ ...base, ...o });
const tour = art({ mode: "tour", onKind: "figure", label: "Figure 8.2", stop: "stop 2 of 6: the stroma", tourStops: 6 });
const res = art({ mode: "results", onKind: "result", index: 0, total: 6, results: ["Result 1: Photosynthesis review (doi.org)", "Result 2: 8.1 Overview of Photosynthesis - Biology 2e | OpenStax (openstax.org)", "Result 3: Photosynthesis (en.wikipedia.org)"] });
const land = art({ mode: "landing", onKind: null, index: -1, total: 0, outline: undefined });
const r = (u: string, c: Ctx = art()) => resolveLocal(u, c);
const name = (u: string, c: Ctx = art()) => r(u, c)?.name ?? null;

export default function check() {
  // polite wrappers and filler come off before matching
  assert.equal(polite("could you read a little slower for me dear"), "read slower");
  assert.equal(polite("oh dear please stop"), "stop");
  assert.equal(polite("would you mind going back a bit please"), "going back a bit");

  // reading on: every way of asking reads on, never one part at a time
  for (const w of ["read", "Read it to me.", "start reading", "begin", "keep reading", "go on", "continue", "carry on", "Just keep reading, go on.", "read the whole thing", "read the whole chapter", "Could you read the whole page to me, please?", "please carry on reading", "keep going then"])
    assert.equal(name(w), "continue", w);
  for (const w of ["read it from the beginning", "start from the top", "Read from the start, please."]) assert.deepEqual(r(w), { name: "continue", args: { from: "top" } }, w);

  // speed, by meaning
  for (const w of ["You're going a bit fast for me, dear. Could you read a little slower?", "speak more slowly please", "slow down please", "too fast", "I can't keep up", "you're going a bit fast for me, dear, could you read a little slower?", "a little slower"])
    assert.equal(name(w), "slower", w);
  for (const w of ["speed up please", "could you go a bit faster", "you're a bit slow", "a little faster, dear"]) assert.equal(name(w), "faster", w);
  for (const w of ["louder please", "could you speak up", "it's too loud", "I can't hear you"]) assert.match(r(w)?.say ?? "", /volume/, w);

  // repeat: the last sentence; "that part" the block
  for (const w of ["say that again", "Pardon?", "what was that", "sorry, what?", "could you say that again please"]) assert.deepEqual(r(w), { name: "read", args: { sentence: true } }, w);
  for (const w of ["say that last sentence again", "repeat the last sentence", "could you repeat the last sentence please"]) assert.deepEqual(r(w), { name: "read", args: { sentence: true, page: true } }, w);
  for (const w of ["read that part again", "read the paragraph again", "read that again"]) assert.deepEqual(r(w), { name: "read" }, w);

  // back, skip, stop
  for (const w of ["go back a bit", "the bit before", "could you go back a bit please"]) assert.equal(name(w), "prev", w);
  for (const w of ["skip this", "move on", "next bit", "let's move on"]) assert.deepEqual(r(w), { name: "next", args: { skip: true } }, w);
  for (const w of ["stop", "Stop. Hold on, wait.", "hold on", "wait", "one moment", "be quiet", "that's enough", "hold on, wait", "just a moment please", "wait a second dear"]) assert.equal(name(w), "stop", w);

  // where and how much is left, in one answer, with numbers
  const wl = r("where are we, and how much is left?");
  assert.equal(wl?.name, "none");
  assert.match(wl?.say ?? "", /^Main Structures and Summary of Photosynthesis, .*Paragraph 2 of 4\. About 6 minutes left on this page, 2 sections\.$/);
  assert.match(r("how much is left?")?.say ?? "", /left on this page, 2 sections/);

  // help, in words for someone who only talks; never a key
  for (const w of ["What can I say to you?", "what can you do", "what are my options", "I'm lost", "I don't know what to do", "help"]) {
    const h = r(w)?.say ?? "";
    assert.match(h, /Say read/, w);
    assert.doesNotMatch(h, /\b(?:press|arrow|key|escape)\b/i, w);
  }
  for (const c of [land, res, tour, art({ onKind: "figure" }), art({ paged: true })]) assert.doesNotMatch(r("help", c)?.say ?? "", /\b(?:press|arrow|key)\b/i, c.mode);
  assert.match(r("help", art({ how: "keys" }))?.say ?? "", /Down arrow/);

  // a request outside what Arc does: one honest sentence and what it can do instead
  assert.equal(r("could you email this to my teacher?")?.say, "I can't send email. I can read this to you, explain it, or find things in it.");
  assert.match(r("can you print it please", land)?.say ?? "", /^I can't print\. I can find study pages/);
  assert.equal(r("read the text to me")?.name, "continue"); // "text" here is no message
  // a mumble is asked for again, never echoed
  assert.equal(r("MMM the ah thing humne in the WhatsApp")?.say, NOT_CAUGHT_LINE);
  assert.equal(r("um uh", land)?.say, NOT_CAUGHT_LINE);
  assert.equal(mumbled("the"), true);
  assert.equal(mumbled("what is a chloroplast"), false);
  assert.match(notUnderstood(art()), /^I'm not sure what you meant\. You can say read/);

  // pictures: answered from the page, with where the nearest one is
  const pic = r("Is there a picture here?");
  assert.equal(pic?.say, "Not in this section. The next picture is Figure 8.2, in The Two Parts of Photosynthesis, 5 paragraphs on. Say go to the picture.");
  assert.deepEqual(pic?.offer, { name: "goto", args: { id: "n3" } });
  assert.match(r("are there any pictures in this section?", art({ index: 2, para: { at: 1, of: 3 } }))?.say ?? "", /^Yes\. Figure 8\.2 is in this section, 2 paragraphs on\./);
  assert.match(r("is there a picture", art({ index: 3, onKind: "figure" }))?.say ?? "", /you are on it: Figure 8\.2/);
  assert.equal(r("any pictures?", art({ outline: entriesOf(nodes.filter((n) => n.kind !== "figure")) }))?.say, "There are no pictures on this page.");
  assert.deepEqual(r("go to the picture"), { name: "goto", args: { id: "n3" } });
  assert.deepEqual(r("go to the picture", art({ pendingOffer: { name: "goto", args: { id: "n3" }, at: 99_000 } })), { name: "goto", args: { id: "n3" } });
  assert.equal(name("take me to the next picture"), "nextFigure");
  assert.equal(name("go to the previous picture"), "prevFigure");
  for (const w of ["walk me through it", "describe the picture", "what's in the picture?", "start the picture tour", "tour"]) assert.equal(name(w, art({ index: 3, onKind: "figure" })), "tour", w);

  // in a tour, by voice
  for (const w of ["start", "begin", "next", "next one"]) assert.equal(name(w, tour), "next", w);
  for (const w of ["go on", "carry on"]) assert.equal(name(w, tour), "continue", w); // the self-running tour plays again from the next stop
  for (const w of ["back", "previous"]) assert.equal(name(w, tour), "prev", w);
  for (const w of ["again", "repeat"]) assert.equal(name(w, tour), "read", w);
  for (const w of ["leave", "that's enough", "That's enough, thank you."]) assert.equal(name(w, tour), "leave", w);
  assert.deepEqual(r("skip to the end", tour), { name: "goto", args: { at: "last" } });
  const atStart = art({ mode: "tour", onKind: "figure", stop: undefined, tourStops: 6 });
  assert.deepEqual(r("start the picture tour, first stop", atStart), { name: "goto", args: { at: 0 } });
  assert.equal(name("begin the tour without arrow keys", atStart), "next");
  assert.equal(name("start the tour", atStart), "next");
  assert.equal(r("how many are left?", tour)?.say, "Stop 2 of 6. 4 more after this one.");
  assert.match(r("how many are left", art({ mode: "tour", stop: undefined, tourStops: 6 }))?.say ?? "", /6 stops, and you have not started yet\. Say next to begin\./);
  assert.equal(r("What is in the first panel?", tour), null); // a question about the picture: the question path, with the tour as context

  // results by voice: more, open and a number, the source named
  assert.equal(name("more", res), "moreResults");
  assert.deepEqual(r("open two", res), { name: "open", args: { at: 1 } });
  assert.deepEqual(r("open the second one", res), { name: "open", args: { at: 1 } });
  assert.deepEqual(r("the OpenStax one", res), { name: "open", args: { at: 1 } });
  assert.deepEqual(r("open the OpenStax one my teacher uses", res), { name: "open", args: { at: 1 } });
  assert.deepEqual(r("the one from wikipedia", res), { name: "open", args: { at: 2 } });

  // the spoken search request, cleaned of small talk
  assert.equal(searchQuery("I'm looking for the chapter about photosynthesis, the OpenStax biology one my teacher uses"), "photosynthesis openstax biology");
  assert.equal(searchQuery("Oh dear, could you look again please? ... Biology 2e photosynthesis"), "biology 2e photosynthesis");
  assert.equal(searchQuery("find me something about the water cycle please"), "water cycle");
  assert.equal(searchQuery("well I was wondering whether you might know where my teacher said we could find the notes from last week on cell division"), undefined); // still long: a model picks the words
  assert.deepEqual(r("I'm looking for the chapter about photosynthesis, the OpenStax biology one my teacher uses", land), { name: "search", args: { query: "photosynthesis openstax biology" }, say: "Searching for photosynthesis openstax biology." });
  assert.equal(r("Oh dear, could you look again please? ... Biology 2e photosynthesis", land)?.args?.query, "biology 2e photosynthesis");

  // a lecture video by voice: the screen, ten seconds, play and pause; questions answered from all Arc knows of it
  const vid = art({ mode: "video", onKind: "segment", outline: undefined });
  for (const w of ["what is on the screen", "what's on screen", "What's on the screen right now?", "describe the screen", "what is she pointing at", "what is he pointing at", "what does it show"]) assert.equal(name(w, vid), "screen", w);
  assert.equal(r("what is on the screen", art()), null); // only on a video
  assert.deepEqual(r("back ten seconds", vid), { name: "seek", args: { by: -10 } });
  assert.deepEqual(r("could you skip ahead please", vid), { name: "seek", args: { by: 10 } });
  assert.equal(name("play", vid), "play");
  assert.equal(name("pause", vid), "stop");
  assert.equal(name("a bit slower please", vid), "slower");
  assert.match(r("help", vid)?.say ?? "", /back ten seconds/);
  assert.match(r("help", art({ mode: "video", how: "keys" }))?.say ?? "", /J and L go back and forward ten seconds/);
  assert.equal(questionSource("video", "LECTURE VIDEO: Sales. PICTURE AT 1:02: ticket sales by month", () => "page"), "LECTURE VIDEO: Sales. PICTURE AT 1:02: ticket sales by month");
  assert.equal(questionSource("video", "", () => "page"), "page");
  assert.equal(questionSource("article", "LECTURE VIDEO", () => "page"), "page");

  // prompt wording: one function, voice never names a key
  assert.equal(cue("voice", "Say next to begin.", "Press Right Arrow to begin."), "Say next to begin.");
  assert.equal(cue("keys", "Say next to begin.", "Press Right Arrow to begin."), "Press Right Arrow to begin.");
  assert.equal(cue("both", "Say next to begin.", "Press Right Arrow to begin."), "Say next to begin. Or press Right Arrow to begin.");
  assert.equal(opening("keys"), OPENING);
  assert.equal(paused("keys"), PAUSED);
  for (const line of [opening("voice"), paused("voice"), tourOffer("voice"), tourStart("voice"), tourStart("voice", "carry on"), resultsTail("voice", true), resultsTail("voice", false)])
    assert.doesNotMatch(line, /\b(?:press|arrow|enter|key)\b/i, line);
  for (const line of [opening("both"), paused("both"), tourStart("both"), resultsTail("both", true)]) assert.ok(line.indexOf("Say") >= 0 && line.indexOf("Say") < line.search(/press/i), line); // voice first

  // search results read aloud: number, title, site; the named source first, in the order read
  const results: Result[] = [
    { title: "Photosynthesis: a review", url: "https://doi.org/10.1/x", snippet: "" },
    { title: "8.1 Overview of Photosynthesis - Biology 2e | OpenStax", url: "https://openstax.org/books/biology-2e/pages/8-1-overview-of-photosynthesis", snippet: "" },
    { title: "Photosynthesis - Wikipedia", url: "https://en.wikipedia.org/wiki/Photosynthesis", snippet: "" },
    { title: "8.2 The Light-Dependent Reactions | OpenStax", url: "https://openstax.org/books/biology-2e/pages/8-2", snippet: "" },
  ];
  assert.equal(resultLine(results[1], 1), "One: 8.1 Overview of Photosynthesis, Biology 2e, OpenStax, a textbook chapter.");
  assert.equal(resultLine(results[2], 2), "Two: Photosynthesis, Wikipedia, an encyclopedia article.");
  // Papers that share a title are told apart by ear: who, when, and whether a free copy exists.
  const paper = { title: "Attention Is All You Need", url: "https://doi.org/10.48550/arxiv.1706.03762", snippet: "" };
  assert.equal(resultLine({ ...paper, open: true, by: "Ashish Vaswani and others", year: 2017 }, 1), "One: Attention Is All You Need, by Ashish Vaswani and others, 2017, free copy.");
  assert.equal(resultLine({ ...paper, open: false, by: "J. M. Bishop and others", year: 2025 }, 2), "Two: Attention Is All You Need, by J. M. Bishop and others, 2025, abstract only.");
  assert.equal(siteName("https://www.khanacademy.org/x"), "Khan Academy");
  const p = preferSource("photosynthesis openstax biology", results);
  assert.deepEqual(p.results.map((x) => x.url.slice(8, 16)), ["openstax", "openstax", "doi.org/", "en.wikip"]);
  assert.equal(p.has, true);
  assert.equal(preferSource("photosynthesis openstax", [results[0]]).has, false); // named, none yet: wait for the next batch
  assert.equal(preferSource("photosynthesis", results).named, false);
}
