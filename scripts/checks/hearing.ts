// The act-at-release rule, the reading picked to submit, and the relay's WAV header.
import assert from "node:assert/strict";
import { actNow, bestReading } from "../../lib/client/hearing";
import { pageNames, wav } from "../../lib/server/hearing";

export default function check() {
  const now = 1000;
  assert.deepEqual(actNow({ gemini: { text: "Tour figure one.", at: 990 }, chrome: { text: "tour figure one", at: 995 } }, now)?.source, "gemini+chrome");
  assert.equal(actNow({ gemini: { text: "tour figure one", at: 0 } }, now), undefined); // one source, not a sure word
  assert.equal(actNow({ chrome: { text: "Next.", at: 900 } }, now), undefined); // sure word but not stable 350 ms
  assert.equal(actNow({ chrome: { text: "Next.", at: 600 } }, now)?.text, "next");
  assert.equal(actNow({ gemini: { text: "tour", at: 0 }, chrome: { text: "door", at: 0 } }, now), undefined);
  assert.equal(bestReading({ gemini: "tor", context: { text: "tour", alternatives: ["door"] } }).text, "tour");
  assert.equal(bestReading({ gemini: "tor", context: { text: " ", alternatives: [] } }).source, "gemini");
  assert.equal(bestReading({}).source, "none");
  const w = wav(Buffer.alloc(320));
  assert.equal(w.length, 364);
  assert.equal(w.toString("ascii", 0, 4), "RIFF");
  assert.equal(w.readUInt32LE(24), 16000);
  assert.deepEqual(pageNames("Title: X\nResults: Gait.\nFigure 1 (figure): Belt unit."), ["Results", "Figure 1"]);
}
