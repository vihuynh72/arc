import assert from "node:assert";
import { readFileSync } from "node:fs";
import { boxDistance, correction, GUIDE, guideTick, keepGoing, LAST_PART, nextLine, towards } from "../../lib/cues";
import type { Box, Tour } from "../../lib/types";

export default function check() {
  const box: Box = [400, 400, 600, 600];
  // distance to the nearest point of the box, 0 inside
  assert.equal(boxDistance(box, 500, 500), 0);
  assert.equal(boxDistance(box, 400, 600), 0);
  assert.equal(boxDistance(box, 500, 100), 300);
  assert.equal(boxDistance(box, 100, 100), Math.hypot(300, 300));
  // closer: shorter interval, higher pitch, within the stated bounds
  let prev = guideTick(2000);
  assert.deepEqual(prev, { ms: GUIDE.slow, hz: GUIDE.low });
  for (const d of [500, 300, 150, 50, 0]) {
    const t = guideTick(d);
    assert.ok(t.ms < prev.ms && t.hz > prev.hz, `closer at ${d}`);
    assert.ok(t.ms >= GUIDE.fast && t.ms <= GUIDE.slow && t.hz >= GUIDE.low && t.hz <= GUIDE.high);
    prev = t;
  }
  assert.deepEqual(guideTick(0), { ms: GUIDE.fast, hz: GUIDE.high });
  assert.ok(towards(300, 250) && !towards(250, 300) && !towards(300, 300));
  // eight directions from points around the box, far enough that "a little" is not added
  const c = (y: number, x: number) => correction(box, y, x);
  assert.equal(c(500, 100), "Right.");
  assert.equal(c(500, 900), "Left.");
  assert.equal(c(100, 500), "Down.");
  assert.equal(c(900, 500), "Up.");
  assert.equal(c(100, 100), "Down and right.");
  assert.equal(c(100, 900), "Down and left.");
  assert.equal(c(900, 100), "Up and right.");
  assert.equal(c(900, 900), "Up and left.");
  // "a little" under 120; both axes only when both exceed 60
  assert.equal(c(500, 300), "Right a little.");
  assert.equal(c(500, 280), "Right.");
  assert.equal(c(330, 330), "Down and right a little.");
  assert.equal(c(350, 300), "Right a little.");
  // resting short of the box: direction and rough distance
  assert.equal(keepGoing(box, 500, 900), "Keep going left, about a quarter of the way across.");
  assert.equal(keepGoing(box, 500, 1000), "Keep going left, about halfway across.");
  assert.equal(keepGoing(box, 500, 690), "Keep going left, just a little more.");
  assert.equal(keepGoing([900, 0, 1000, 1000], 0, 500), "Keep going down, most of the way down.");
  // the way to the next stop, from the pointer or from the stop before it
  const { stops }: Tour = JSON.parse(readFileSync("fixtures/lower/tour-final.json", "utf8"));
  assert.equal(nextLine(stops, 1), "Next: right thigh. Move far down and to the left.");
  assert.equal(nextLine(stops, 1, { y: 586, x: 300 }), "Next: right thigh. Move to the right.");
  assert.equal(nextLine(stops, 1, { y: 586, x: 500 }), "Next: right thigh. You are on it.");
  assert.equal(nextLine(stops, stops.length), LAST_PART);
}
