import assert from "node:assert";
import { readFileSync } from "node:fs";
import { hitStop, nearestHint } from "../../lib/cues";
import type { Tour } from "../../lib/types";

export default function check() {
  const { stops }: Tour = JSON.parse(readFileSync("fixtures/lower/tour-final.json", "utf8"));
  stops.forEach((s, i) => {
    const [y0, x0, y1, x1] = s.box_2d;
    assert.equal(hitStop(stops, (y0 + y1) / 2, (x0 + x1) / 2), i, `centre of ${s.label}`);
  });
  assert.equal(hitStop(stops, 50, 50), -1);
  assert.equal(hitStop(stops, 500, 400), -1);
  // overlap: the smaller box wins
  const nested = [stops[0], { ...stops[1], box_2d: [300, 800, 350, 850] as [number, number, number, number] }];
  assert.equal(hitStop(nested, 320, 820), 1);
  assert.equal(nearestHint(stops, 100, 500), "Belt is far down and to the right.");
  assert.equal(nearestHint(stops, 586, 400), "Right thigh is to the right.");
  assert.equal(nearestHint(stops, 586, 560), "Right thigh is a little to the right.");
  assert.equal(nearestHint([], 0, 0), "");
}
