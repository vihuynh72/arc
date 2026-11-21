// The act-at-release rule, the reading picked to submit, and the relay's WAV header.
import assert from "node:assert/strict";
import { bestReading, mayDispatch } from "../../lib/client/hearing";
import { resolveLocal, type Ctx } from "../../lib/intent";
import { keepAsks, pageNames, wav } from "../../lib/server/hearing";

export default function check() {
  // Nothing runs while the key is held, and nothing runs from a partial transcript, even a whole command word:
  // "Go" is the start of "go back", "Next" of "next section", "Move" of "move down".
  for (const released of [false, true]) assert.equal(mayDispatch("partial", released), false);
  assert.equal(mayDispatch("final", false), false); // a transcript sent before release (should not happen) is held too
  assert.equal(mayDispatch("final", true), true);
  // The fragments that must never be acted on from a partial. Some of them are real commands as a final transcript
  // ("skip", "what"): the grammar still knows them, the gate is what keeps a partial from running them.
  const ctx: Ctx = { mode: "article", onKind: "section", index: 2, total: 45, canGoBack: true, label: "Results", now: 1 };
  const frag = ["go", "move", "skip", "read", "what", "next", "stop", "back"];
  for (const f of frag) assert.equal(mayDispatch("partial", true), false, f);
  assert.equal(resolveLocal("go", ctx), null); // "go" alone is no command at all
  assert.equal(resolveLocal("move", ctx), null);
  assert.equal(resolveLocal("read", ctx)?.name, "continue"); // a whole "read" reads on; as a partial it is held by the gate above
  assert.equal(bestReading({ gemini: "tor", context: { text: "tour", alternatives: ["door"] } }).text, "tour");
  assert.equal(bestReading({ gemini: "tor", context: { text: " ", alternatives: [] } }).source, "gemini");
  assert.equal(bestReading({}).source, "none");
  const w = wav(Buffer.alloc(320));
  assert.equal(w.length, 364);
  assert.equal(w.toString("ascii", 0, 4), "RIFF");
  assert.equal(w.readUInt32LE(24), 16000);
  assert.deepEqual(pageNames("Title: X\nResults: Gait.\nFigure 1 (figure): Belt unit."), ["Results", "Figure 1"]);

  // A hosted copy keeps no visitor's voice or words; the owner's laptop keeps them for replay; the switch overrides both.
  const env = process.env as Record<string, string | undefined>;
  const was = { node: env.NODE_ENV, keep: env.ARC_KEEP_ASKS };
  for (const [node, keep, want] of [["production", undefined, false], ["development", undefined, true], ["production", "on", true], ["development", "off", false]] as const) {
    env.NODE_ENV = node;
    if (keep) env.ARC_KEEP_ASKS = keep;
    else delete env.ARC_KEEP_ASKS;
    assert.equal(keepAsks(), want, `keepAsks with NODE_ENV=${node} ARC_KEEP_ASKS=${keep}`);
  }
  if (was.node === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = was.node;
  if (was.keep === undefined) delete env.ARC_KEEP_ASKS;
  else env.ARC_KEEP_ASKS = was.keep;
}
