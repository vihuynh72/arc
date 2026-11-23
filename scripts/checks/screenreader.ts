import assert from "node:assert";
import { applyCommand, paint, SR_OFF, SR_ON } from "../../lib/client/display";
import { resolveLocal, type Ctx } from "../../lib/intent";

// The experimental "use my screen reader" switch: narrow local phrases, one sentence back, nothing caught by accident.
const base: Ctx = { mode: "article", onKind: "section", index: 2, total: 45, canGoBack: false, label: "Results", title: "Knee sensors", now: 100_000 };
const land: Ctx = { ...base, mode: "landing", onKind: null, index: -1, total: 0 };
const set = (u: string, c: Ctx = base) => resolveLocal(u, c)?.args?.setting;

export default function check() {
  for (const c of [base, land]) {
    for (const w of ["use my screen reader", "Use my screen reader.", "screen reader mode"]) assert.equal(set(w, c), "sr-on", w);
    for (const w of ["use your own voice", "Arc voice", "stop using my screen reader"]) assert.equal(set(w, c), "sr-off", w);
  }
  // Ordinary sentences that mention screen readers go on to the models, not to this switch.
  for (const w of ["what does the paper say about screen readers", "does arc work with my screen reader", "how do screen readers read tables", "use my screen reader to read the abstract", "screen readers"])
    assert.notEqual(resolveLocal(w, base)?.name, "display", w);
  // On and off: one sentence each, and the choice is kept apart from the look.
  const [on, onLine] = applyCommand({ text: "150" }, "sr-on")!;
  assert.deepEqual(on, { text: "150", sr: "on" });
  assert.equal(onLine, SR_ON);
  assert.equal(applyCommand(on, "sr-off")![0].sr, undefined);
  assert.equal(applyCommand(on, "sr-off")![1], SR_OFF);
  // A profile or a display reset does not switch the student's screen reader off by surprise.
  assert.equal(applyCommand(on, "dyslexia")![0].sr, "on");
  assert.deepEqual(applyCommand(on, "reset")![0], { sr: "on" });
  // paint() sets data-sr (a minimal document stand-in: paint is plain code).
  const d = { dataset: {} as Record<string, string> };
  const g = globalThis as unknown as { document: unknown; window: unknown };
  const keep = [g.document, g.window];
  g.document = { documentElement: d };
  g.window = { matchMedia: () => ({ matches: false }) };
  try {
    paint({ sr: "on" });
    assert.equal(d.dataset.sr, "on");
    paint({});
    assert.equal(d.dataset.sr, "off");
  } finally {
    [g.document, g.window] = keep;
  }
}
