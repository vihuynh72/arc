import assert from "node:assert";
import { readFileSync } from "node:fs";
import type { Tour } from "../../lib/types";

export default function check() {
  const tour: Tour = JSON.parse(readFileSync("fixtures/lower/tour-final.json", "utf8"));
  assert.equal(tour.stops.length, 6);
  for (const s of tour.stops) {
    assert.equal(s.box_2d.length, 4);
    assert.ok(s.box_2d.every((v) => v >= 0 && v <= 1000));
  }
}
