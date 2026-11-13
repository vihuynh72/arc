import assert from "node:assert";
import { readFileSync } from "node:fs";
import { cue, stopLine } from "../../lib/cues";
import type { Tour, TourStop } from "../../lib/types";

export default function check() {
  const { stops }: Tour = JSON.parse(readFileSync("fixtures/lower/tour-final.json", "utf8"));
  assert.deepEqual(
    stops.map((s, i) => cue(s, stops[i - 1])),
    [
      "Start at the top right.",
      "Move far down and to the left.",
      "Move down.",
      "Move down.",
      "Move down.",
      "Move far up and to the right.",
    ],
  );
  assert.equal(stopLine(stops, 2), "Move down. right calf. " + stops[2].says);
  const at = (y: number, x: number): TourStop => ({ n: 0, label: "", says: "", confidence: "high", box_2d: [y, x, y, x] });
  assert.equal(cue(at(500, 500)), "Start at the center.");
  assert.equal(cue(at(900, 100)), "Start at the bottom left.");
  assert.equal(cue(at(100, 500)), "Start at the top middle.");
  assert.equal(cue(at(500, 530), at(500, 500)), "Move a little to the right.");
  assert.equal(cue(at(400, 500), at(500, 500)), "Move up.");
  assert.equal(cue(at(500, 100), at(500, 500)), "Move far to the left.");
}
