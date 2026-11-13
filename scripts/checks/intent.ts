import assert from "node:assert";
import { HELP, LANDING_LINE, normalise, resolveLocal, type Ctx } from "../../lib/intent";

const base: Ctx = { mode: "article", onKind: "section", index: 2, total: 45, canGoBack: false, label: "Results", title: "Knee sensors", now: 100_000 };
const art = (o: Partial<Ctx> = {}): Ctx => ({ ...base, ...o });
const fig = art({ onKind: "figure", label: "Figure 2" });
const res = art({ mode: "results", onKind: "result", index: 2, total: 12 });
const tour = art({ mode: "tour", onKind: "figure", label: "Figure 1", stop: "stop 2 of 6: right thigh" });
const land = art({ mode: "landing", onKind: null, index: -1, total: 0 });
const vid = art({ mode: "video", onKind: "segment" });
const offer = { name: "tour", args: { id: "n9" }, at: 95_000 };
const r = (u: string, c: Ctx) => resolveLocal(u, c);
const name = (u: string, c: Ctx) => r(u, c)?.name ?? null;

export default function check() {
  // "I am blind" turns on voice first in every mode, at once; "reset display" turns it off with the rest
  for (const c of [land, base, tour, res]) assert.deepEqual(r("I'm blind.", c), { name: "display", args: { setting: "voice-first" } });
  assert.equal(r("i can't see the screen", land)?.args?.setting, "voice-first");
  assert.equal(r("turn off voice first", base)?.args?.setting, "voice-first-off");
  assert.equal(r("reset display", base)?.args?.setting, "reset");
  // normalising
  assert.equal(normalise("Um, please... NEXT!"), "next");
  assert.equal(normalise("hey arc, can you stop please"), "stop");
  assert.equal(normalise("necks"), "next");
  assert.equal(normalise("bak"), "back");
  assert.equal(normalise("okay"), "okay"); // alone it stays: it means yes

  // next and back, with counts and repeats
  for (const w of ["next", "Next.", "forward", "continue", "keep going", "skip", "nex", "necks", "go next", "next please", "um next"]) assert.equal(name(w, art()), "next", w);
  for (const w of ["back", "previous", "before", "bak", "Previous one"]) assert.equal(name(w, art()), "prev", w);
  assert.deepEqual(r("next next", art()), { name: "next", steps: 2 });
  assert.deepEqual(r("next next next", art()), { name: "next", steps: 3 });
  assert.deepEqual(r("next three", art()), { name: "next", steps: 3 });
  assert.deepEqual(r("skip two", art()), { name: "next", steps: 2 });
  assert.deepEqual(r("back two", art()), { name: "prev", steps: 2 });
  assert.deepEqual(r("go back two", art()), { name: "prev", steps: 2 });
  assert.deepEqual(r("next 5", art()), { name: "next", steps: 5 });
  assert.deepEqual(r("next 40", art()), { name: "next", steps: 10 }); // capped
  assert.deepEqual(r("back back", res), { name: "prev", steps: 2 });

  // again, more, stop
  for (const w of ["again", "repeat", "say that again", "what", "What?", "replay", "one more time", "Say that again."]) assert.equal(name(w, art()), "read", w);
  for (const w of ["more", "go on", "read it", "read this", "read more"]) assert.equal(name(w, art()), "continue", w);
  assert.equal(name("more", vid), "continue");
  assert.equal(name("more", res), "read"); // the snippet
  assert.equal(name("more", tour), "read");
  for (const w of ["stop", "quiet", "pause", "shh", "be quiet"]) assert.equal(name(w, art()), "stop", w);
  assert.equal(name("stop", tour), "stop");
  assert.equal(name("stop", land), "stop");

  // open, that one, this one
  assert.deepEqual(r("that one", res), { name: "open", args: { at: 2 } });
  assert.deepEqual(r("open it", res), { name: "open", args: { at: 2 } });
  assert.deepEqual(r("this one", res), { name: "open", args: { at: 2 } });
  assert.deepEqual(r("open", { ...res, index: -1 }), { name: "open", args: { at: 0 } });
  assert.equal(name("open", fig), "tour"); // on a figure, open means its tour
  assert.equal(r("open it", art()), null); // on a section: Snap decides
  assert.match(r("open", tour)?.say ?? "", /in the tour/);

  // tour, explore, this
  for (const w of ["tour", "tour this", "explore", "explore this", "this"]) assert.equal(name(w, fig), "tour", w);
  assert.equal(name("tour", art()), "tour"); // Reader picks the nearest figure
  assert.equal(r("this", art()), null); // "this" only means the tour on a figure
  assert.equal(r("explore this", res), null);

  // leave
  for (const w of ["leave", "exit", "done", "close", "out"]) assert.equal(name(w, tour), "leave", w);
  assert.equal(name("leave", res), "leave");
  assert.equal(r("leave", art()), null);

  // ordinals in results
  assert.deepEqual(r("first", res), { name: "goto", args: { at: 0 } });
  assert.deepEqual(r("the second one", res), { name: "goto", args: { at: 1 } });
  assert.deepEqual(r("third", res), { name: "goto", args: { at: 2 } });
  assert.deepEqual(r("number 4", res), { name: "goto", args: { at: 3 } });
  assert.deepEqual(r("last", res), { name: "goto", args: { at: 11 } });
  assert.deepEqual(r("open the second one", res), { name: "open", args: { at: 1 } });
  assert.deepEqual(r("open the first one", res), { name: "open", args: { at: 0 } });
  assert.deepEqual(r("open 3", res), { name: "open", args: { at: 2 } });
  assert.deepEqual(r("open the last one", res), { name: "open", args: { at: 11 } });
  assert.deepEqual(r("tenth", { ...res, total: 4 }), { name: "goto", args: { at: 3 } }); // clamped
  assert.deepEqual(r("first", art()), { name: "goto", args: { at: 0 } });
  assert.deepEqual(r("last", art()), { name: "goto", args: { at: 44 } });
  assert.equal(r("second", art()), null); // in an article an ordinal alone is unclear

  // yes and no, offers fresh and stale
  assert.deepEqual(r("yes", art({ pendingOffer: offer })), { name: "tour", args: { id: "n9" }, say: undefined });
  assert.equal(name("sure", art({ pendingOffer: offer })), "tour");
  assert.equal(name("ok", art({ pendingOffer: offer })), "tour");
  assert.equal(name("do it", art({ pendingOffer: offer })), "tour");
  assert.equal(name("yes", art({ pendingOffer: { ...offer, at: 70_000 } })), "none"); // 30 s old: stale
  assert.match(r("yes", art())?.say ?? "", /nothing waiting/);
  assert.deepEqual(r("no", art({ pendingOffer: offer })), { name: "none", say: "Okay." });
  assert.equal(r("never mind", art())?.say, "Okay.");
  assert.equal(r("cancel", tour)?.say, "Okay.");

  // speed
  assert.equal(name("faster", art()), "faster");
  assert.equal(name("slow down", art()), "slower");
  assert.deepEqual(r("normal speed", art()), { name: "slower", args: { normal: true } });
  assert.match(r("faster", tour)?.say ?? "", /while reading/);

  // where am i, help
  assert.equal(r("where am i", art())?.say, "Results, section 3 of 45, in Knee sensors.");
  assert.equal(r("where am i", fig)?.say, "Figure 2, figure 3 of 45, in Knee sensors.");
  assert.equal(r("where", tour)?.say, "Figure 1 tour, stop 2 of 6: right thigh.");
  assert.equal(r("where am i", res)?.say, "Search results, 3 of 12.");
  assert.match(r("where am i", land)?.say ?? "", /Nothing is open/);
  assert.equal(r("what can i do", art())?.say, HELP.article);
  assert.equal(r("help", res)?.say, HELP.results);
  assert.equal(r("options", tour)?.say, HELP.tour);
  assert.equal(r("help", land)?.say, HELP.landing);

  // start, end, go back
  for (const w of ["start", "top", "beginning", "start over", "go to the top"]) assert.deepEqual(r(w, art()), { name: "goto", args: { at: 0 } }, w);
  for (const w of ["end", "bottom", "go to the end"]) assert.deepEqual(r(w, art()), { name: "goto", args: { at: 44 } }, w);
  assert.equal(name("go back", art({ canGoBack: true })), "return");
  assert.equal(name("return", art({ canGoBack: true })), "return");
  assert.match(r("go back", art())?.say ?? "", /nowhere/);

  // figure and heading moves
  assert.equal(name("next figure", art()), "nextFigure");
  assert.equal(name("the next figure", art()), "nextFigure");
  assert.equal(name("previous figure", art()), "prevFigure");
  assert.equal(name("next section", art()), "nextHeading");
  assert.equal(name("previous heading", art()), "prevHeading");
  assert.match(r("next figure", tour)?.say ?? "", /leave first/);

  // the tour gets next/back/again
  assert.equal(name("next", tour), "next");
  assert.deepEqual(r("next two", tour), { name: "next", steps: 2 });
  assert.equal(name("back", tour), "prev");
  assert.equal(name("again", tour), "read");

  // real-voice mishearings, whole utterance only, and only where they make sense
  for (const w of ["text", "nest", "necks"]) assert.equal(name(w, art()), "next", w);
  assert.equal(name("pack", art()), "prev");
  for (const w of ["a game", "the game"]) assert.equal(name(w, art()), "read", w);
  for (const w of ["hoping", "opened"]) assert.deepEqual(r(w, res), { name: "open", args: { at: 2 } }, w);
  for (const w of ["moor", "mor"]) assert.equal(name(w, art()), "continue", w);
  for (const w of ["live", "leaf"]) assert.equal(name(w, tour), "leave", w);
  assert.equal(r("live", art()), null); // not in a tour: not a leave
  for (const w of ["tor", "to her", "two were", "store", "door"]) assert.equal(name(w, fig), "tour", w);
  assert.equal(r("store", art()), null); // not on a figure: not a tour
  assert.equal(r("tor", res), null);
  assert.deepEqual(r("to figure one", fig), { name: "tour", args: { figure: 1 } });
  assert.deepEqual(r("tor figure 2", fig), { name: "tour", args: { figure: 2 } });
  assert.deepEqual(r("the figure one", fig), { name: "tour", args: { figure: 1 } });
  assert.deepEqual(r("tour figure three", art()), { name: "tour", args: { figure: 3 } });
  assert.equal(r("to figure one", art()), null); // off a figure "to figure one" may be a go-to: Snap decides
  assert.equal(r("the text of the methods", art()), null);
  // an offer is accepted by the words it asked for
  for (const w of ["tour", "explore", "start", "go", "do it", "store"]) assert.deepEqual(r(w, art({ pendingOffer: offer })), { name: "tour", args: { id: "n9" }, say: undefined }, w);

  // landing: navigation words explain, nothing moves
  for (const w of ["next", "back", "again", "open it", "tour", "next next", "first", "go back"]) assert.deepEqual(r(w, land), { name: "none", say: LANDING_LINE }, w);
  // landing: the prepared examples the page links to open at once; elsewhere the same words go on to Snap
  for (const w of ["Open the paper.", "open a research paper", "example", "show me an example", "please open the paper"]) assert.match(String(r(w, land)?.args?.url), /mdpi\.com\/1424-8220\/24\/6\/1935$/, w);
  assert.match(String(r("open the video", land)?.args?.url), /youtube\.com\/watch\?v=EPvd-3712U8$/);
  assert.match(String(r("open the textbook", land)?.args?.url), /openstax\.org\/.+endocrine-pancreas$/);
  assert.equal(r("open the paper", land)?.name, "open");
  assert.equal(r("open the paper", base), null);

  // whole utterance only: longer sentences go on to Snap and Gemini
  for (const w of [
    "what comes next in the experiment",
    "what is this",
    "go back to the methods",
    "take me to the results",
    "find a paper about knee rehabilitation",
    "what does that mean",
    "next figure please explain what it shows",
    "stop the experiment results",
    "is this the last one in the list",
    "open the paper about knees",
    "explain this",
  ])
    assert.equal(r(w, art()), null, w);
  assert.equal(r("", art()), null);
  assert.equal(r("one", res), null);
}
