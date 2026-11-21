// Offline: the ring fitter (lib/server/ringFit.ts) on pictures drawn here. No network, no model.
import assert from "node:assert";
import { fitTour, straddlers, type Box } from "../../lib/server/ringFit";

// A connector's box that cuts through two parts loses its ring; a container that holds its parts whole keeps it; so do neighbours.
const [topBox, lowBox]: Box[] = [[230, 320, 390, 570], [520, 320, 680, 570]];
assert.deepEqual(straddlers([topBox, lowBox, [280, 440, 660, 780]]), [false, false, true]); // a curved arrow's extent across both
assert.deepEqual(straddlers([topBox, lowBox, [200, 300, 700, 600]]), [false, false, false]); // a column holding both
assert.deepEqual(straddlers([topBox, [300, 500, 460, 760]]), [false, false]); // two parts that overlap a little
assert.deepEqual(straddlers([]), []);
import type { Tour } from "../../lib/types";

const W = 400, H = 300;
/** A white picture with outlined (stroke) or filled rectangles, in pixels: [y0, x0, y1, x1]. */
async function picture(rects: { r: number[]; fill?: string }[], w = W, h = H): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const body = rects
    .map(({ r: [y0, x0, y1, x1], fill }) => `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="${fill ?? "#fff"}" stroke="#000" stroke-width="3"/>`)
    .join("");
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#fff"/>${body}</svg>`)).png().toBuffer();
}
const tour = (...boxes: Box[]): Tour => ({ title: "t", overview: "o", stops: boxes.map((b, k) => ({ n: k + 1, label: `p${k}`, says: "s", box_2d: b, confidence: "high" })) });
const rel = (y0: number, x0: number, y1: number, x1: number): Box => [(y0 / H) * 1000, (x0 / W) * 1000, (y1 / H) * 1000, (x1 / W) * 1000].map(Math.round) as Box;
const near = (a: number[], b: number[], tol = 15) => a.every((v, k) => Math.abs(v - b[k]) <= tol);

export default async function check() {
  const rect = rel(100, 100, 200, 300); // the drawn rectangle

  // A box inside a larger rectangle grows to it (outline included); the ring stays.
  const grown = await fitTour(tour(rel(120, 140, 180, 240)), await picture([{ r: [100, 100, 200, 300] }]));
  assert.ok(near(grown.stops[0].box_2d, rect), `grew to ${grown.stops[0].box_2d}`);
  assert.equal(grown.stops[0].confidence, "high");

  // A loose box shrinks to its content (a filled shape in a big box).
  const shrunk = await fitTour(tour(rel(60, 60, 240, 340)), await picture([{ r: [100, 100, 200, 300], fill: "#9cf" }]));
  assert.ok(near(shrunk.stops[0].box_2d, rect), `shrank to ${shrunk.stops[0].box_2d}`);

  // Two parts side by side with a gap are not merged: a box on the left one stays on the left one.
  const pair = await picture([{ r: [100, 40, 200, 180] }, { r: [100, 220, 200, 360] }]);
  const left = await fitTour(tour(rel(110, 50, 190, 200)), pair);
  assert.ok(near(left.stops[0].box_2d, rel(100, 40, 200, 180)), `left part: ${left.stops[0].box_2d}`);
  // A box straddling both is a guess between two parts: no ring.
  const both = await fitTour(tour(rel(110, 120, 190, 280)), pair);
  assert.notEqual(both.stops[0].confidence, "high");

  // A box over empty paper loses its ring and keeps its place.
  const empty = await fitTour(tour(rel(220, 320, 290, 390)), await picture([{ r: [100, 100, 200, 300] }]));
  assert.equal(empty.stops[0].confidence, "medium");
  assert.deepEqual(empty.stops[0].box_2d, rel(220, 320, 290, 390));

  // A 1-pixel box, an inverted box, a huge picture and bytes that are not a picture: the tour comes back as it was, no throw.
  const pic = await picture([{ r: [100, 100, 200, 300] }]);
  const tiny = await fitTour(tour([500, 500, 501, 501]), pic);
  assert.deepEqual(tiny.stops[0].box_2d, [500, 500, 501, 501]);
  const inverted: Box = [600, 600, 400, 400];
  assert.deepEqual((await fitTour(tour(inverted), pic)).stops[0].box_2d, inverted);
  const sharp = (await import("sharp")).default;
  const huge = await sharp({ create: { width: 9000, height: 9000, channels: 3, background: "#fff" } }).png().toBuffer(); // 81 Mpx, over the limit
  const t = tour(rel(120, 140, 180, 240));
  assert.equal(await fitTour(t, huge), t);
  assert.equal(await fitTour(t, Buffer.from("not a picture at all")), t);

  // Hand-fixed tours and chart data tours are never touched; a fitted tour is not fitted twice.
  const fixed: Tour = { ...t, stops: t.stops.map((s) => ({ ...s, confidence: "hand-fixed" })) };
  assert.equal(await fitTour(fixed, pic), fixed);
  assert.equal(await fitTour({ ...t, chart: { type: "bar", x: { label: "", unit: null, min: 0, max: 1 }, y: { label: "", unit: null, min: 0, max: 1 }, plot: [0, 0, 1000, 1000], series: [] } }, pic).then((x) => x.stops[0].box_2d), t.stops[0].box_2d);
  assert.equal(await fitTour(grown, pic), grown);
}
