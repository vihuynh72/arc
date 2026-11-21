// Run by scripts/selfcheck.ts: the second voice's watchdog (lib/client/voice.ts), the status lines "say that again" skips
// (lib/keys.ts), and section requests resolved the same way typed or spoken, against the headings of arXiv 1706.03762.
import assert from "node:assert";
import { WATCH, watchStep } from "../../lib/client/voice";
import { isStatusLine, rateLine } from "../../lib/keys";
import { resolveLocal, type Ctx } from "../../lib/intent";
import { entriesOf } from "../../lib/outline";

const HEADS: [string, number, number][] = [
  ["Attention Is All You Need", 1, 1], ["Abstract", 2, 1], ["1 Introduction", 1, 2], ["2 Background", 1, 2], ["3 Model Architecture", 1, 2],
  ["3.1 Encoder and Decoder Stacks", 2, 3], ["3.2 Attention", 2, 3], ["3.2.1 Scaled Dot-Product Attention", 3, 4], ["3.2.2 Multi-Head Attention", 3, 4],
  ["3.2.3 Applications of Attention in our Model", 3, 5], ["3.3 Position-wise Feed-Forward Networks", 2, 5], ["4 Why Self-Attention", 1, 6], ["5 Training", 1, 7], ["7 Conclusion", 1, 10],
];

export default function check() {
  // A line: the tone after 1.2 s of nothing, the local voice after 3.5 s (sooner right after another fell back), given up after 9 s.
  assert.equal(watchStep(1000, true, false, false), "wait");
  assert.equal(watchStep(WATCH.TONE_MS, true, false, false), "tone");
  assert.equal(watchStep(2000, true, true, false), "wait");
  assert.equal(watchStep(WATCH.GIVE_UP_MS, true, true, false), "fallback");
  assert.equal(watchStep(WATCH.SOON_MS, true, false, false, true), "fallback");
  assert.equal(watchStep(5000, true, true, true), "wait", "the fallback is under way");
  assert.equal(watchStep(WATCH.DEAD_MS, true, true, true), "abandon");
  // An answer: its caller plays its own waiting sound; only a reply that never comes is abandoned.
  assert.equal(watchStep(10_000, false, false, false), "wait");
  assert.equal(watchStep(WATCH.ANSWER_MS, false, false, false), "abandon");

  for (const l of [rateLine("slower", 1.2), rateLine("faster", 2), "Speed 1.5.", "Paused. Say go on, or press Down, to keep reading.", "Back to the page. Figure 8.2.", "Tour this figure, button, Figure 8.2.", "Original page, link.", "Display, button. Opens its settings.", "Ask box. Type, or hold Space to talk.", "Top of page."])
    assert.ok(isStatusLine(l), l);
  for (const l of ["Explain the significance of photosynthesis to other living organisms.", "Photosynthesis has two stages: the light-dependent reactions.", "Slower growth was seen in the second group."])
    assert.ok(!isStatusLine(l), l);

  const nodes = HEADS.map(([heading, level, page], i) => ({ id: `h${i}`, kind: "section" as const, heading, level, page, text: "" }));
  const o = entriesOf(nodes);
  const c = { mode: "article", onKind: "section", index: 3, total: nodes.length, canGoBack: false, title: "Attention Is All You Need", outline: o, paged: true, pages: 15, pageOf: Object.fromEntries(nodes.map((n) => [n.id, n.page])) } as Ctx;
  const attention = nodes.find((n) => n.heading === "3.2 Attention")!.id;
  for (const u of ["go to section Attention", "go to the Attention section", "go to the section called Attention", "Go to the Attention section.", "Go to the section called Attention.", "go to the section named attention"])
    assert.deepEqual(resolveLocal(u, c), { name: "goto", args: { id: attention } }, u);
  assert.deepEqual(resolveLocal("go to the multi-head attention section", c), { name: "goto", args: { id: nodes.find((n) => n.heading.startsWith("3.2.2"))!.id } });
  for (const u of ["Which page does the Attention section start on?", "which page is the attention section on", "where is the attention section"]) {
    const r = resolveLocal(u, c);
    assert.equal(r?.say, "3.2 Attention starts on page 3 of 15. Say yes to go there.", u);
    assert.deepEqual(r?.offer, { name: "goto", args: { id: attention } });
  }
  // Sections known only for the pages read so far (no whole-document outline): the honest line; with one, a plain "not found".
  assert.equal(resolveLocal("which page does the results section start on", c)?.say, "I know the sections only for the pages I have read so far. Say page and a number to go further.");
  assert.match(resolveLocal("which page does the results section start on", { ...c, whole: true })?.say ?? "", /^I did not find a section called results\. Say contents/);
}
