import assert from "node:assert";
import { readFileSync } from "node:fs";
import { place, placed, stopLine } from "../../lib/cues";
import type { Box, Tour, TourStop } from "../../lib/types";

export default function check() {
  const { stops }: Tour = JSON.parse(readFileSync("fixtures/lower/tour-final.json", "utf8"));
  // Arc moves to each stop: the line says where the part is, never an instruction.
  assert.deepEqual(
    stops.map((_, i) => stopLine(stops, i).split(":")[0]),
    ["Top right", "Center", "Bottom center", "Bottom center, below it", "Bottom center, below it", "Bottom right"],
  );
  assert.equal(stopLine(stops, 2), "Bottom center: right calf. " + stops[2].says);
  assert.ok(stops.every((_, i) => !/\b(move|start at)\b/i.test(stopLine(stops, i))), "no directions when Arc moves");
  const b = (y0: number, x0: number, y1: number, x1: number): Box => [y0, x0, y1, x1];
  // corners, centre, edges
  assert.equal(place(b(20, 20, 120, 120)), "Top left");
  assert.equal(place(b(880, 880, 980, 980)), "Bottom right");
  assert.equal(place(b(450, 450, 550, 550)), "Center");
  assert.equal(place(b(450, 0, 550, 100)), "Middle left");
  assert.equal(place(b(0, 450, 80, 550)), "Top center");
  // a wide part and a tall part
  assert.equal(place(b(900, 50, 980, 950)), "Across the bottom");
  assert.equal(place(b(50, 860, 950, 980)), "Down the right side");
  assert.equal(place(b(50, 450, 950, 550)), "Down the middle");
  // most of the picture: no place words; a wrapped box is read the same
  assert.equal(place(b(0, 0, 1000, 1000)), "");
  assert.equal(place([b(20, 20, 120, 120)] as unknown as Box), "Top left");
  // a part with no trusted place gets no place words, and relations only follow a placed part
  const at = (y: number, x: number, confidence = "high"): TourStop => ({ n: 0, label: "x", says: "y.", confidence, box_2d: [y - 20, x - 20, y + 20, x + 20] });
  assert.equal(stopLine([at(100, 100, "medium")], 0), "x. y.");
  assert.equal(stopLine([at(100, 100), at(250, 100)], 1), "Top left, below it: x. y.");
  assert.equal(stopLine([at(100, 250), at(100, 100)], 1), "Top left, to its left: x. y.");
  assert.equal(stopLine([at(100, 100, "low"), at(250, 100)], 1), "Top left: x. y.");
  assert.ok(placed(at(0, 0, "hand-fixed")) && !placed(at(0, 0, "medium")) && !placed(undefined));
  // A pie tour saved before clock positions existed still gets no place words.
  const old: TourStop[] = [{ n: 1, label: "Main finding", says: "x.", confidence: "high", box_2d: [0, 0, 1000, 1000] }, { n: 2, label: "Slices", says: "Largest: January, 18 percent.", confidence: "high", box_2d: [200, 200, 900, 800] }, { n: 3, label: "January", says: "18 percent.", confidence: "high", box_2d: [300, 500, 500, 600] }];
  assert.equal(stopLine(old, 2), "January. 18 percent.");
  assert.equal(stopLine(old, 0), "Main finding. x.");
}
