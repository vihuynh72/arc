// Ring fitting: the light vision model's boxes are loose (narrow, a few percent off), so each stop's box is fitted, in code,
// to the picture's own marks. Pure pixel geometry, no network. Called by lib/server/tour.ts when a tour is built or served;
// checked offline by scripts/checks/ringfit.ts and measured by scripts/ring-eval.ts.
//
// The picture is cut into regions of one colour (a filled box, the inside of an outlined box, a glyph, a stroke network).
// A stop's box snaps to the one region that matches it best (a box that is too small grows to the shape it sits on, a loose
// one shrinks to it); with no matching shape it shrinks to the marks it mostly covers. The ring is kept only when the fit
// is clean; a box over empty paper, or one between two equally likely parts, loses its ring (the line is still spoken).
import type { Tour, TourStop } from "../types";

export type Box = [number, number, number, number]; // [ymin, xmin, ymax, xmax], 0 to 1000
type Rect = { y0: number; x0: number; y1: number; x1: number }; // pixels, inclusive
type Region = Rect & { n: number; ink: boolean; paper: boolean }; // ink: a dark mark; paper: paper-coloured (the inside of an outline)
export type Scene = { w: number; h: number; photo: boolean; regions: Region[]; inkMask: Uint8Array };
export type Fit = { box: Box; how: "shape" | "marks" | "empty" | "unsure" | "photo"; sure: boolean };

const SIDE = 800; // working size: long side in pixels
const MAX_INPUT = 40_000_000; // pixels sharp may decode
const TIME_MS = 3000;

/** Decode any image the app accepts into a small RGB grid; null when it is not a picture (or too big, or too slow). */
export async function pixels(image: Uint8Array): Promise<{ w: number; h: number; rgb: Uint8Array } | null> {
  if (image.byteLength < 8 || image.byteLength > 20_000_000) return null;
  try {
    const sharp = (await import("sharp")).default;
    const job = sharp(image, { limitInputPixels: MAX_INPUT, failOn: "error" })
      .timeout({ seconds: Math.ceil(TIME_MS / 1000) })
      .flatten({ background: "#fff" })
      .resize({ width: SIDE, height: SIDE, fit: "inside", withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const out = await Promise.race([job, new Promise<null>((r) => setTimeout(() => r(null), TIME_MS).unref?.())]);
    if (!out || out.info.channels !== 3) return null;
    return { w: out.info.width, h: out.info.height, rgb: new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.length) };
  } catch {
    return null;
  }
}

const diff = (p: Uint8Array, i: number, j: number) => Math.max(Math.abs(p[i] - p[j]), Math.abs(p[i + 1] - p[j + 1]), Math.abs(p[i + 2] - p[j + 2]));

/** Regions of one colour (4-connected, neighbours within a small colour step), the paper colour, and which pixels are ink. */
export function analyse(w: number, h: number, rgb: Uint8Array): Scene {
  const N = w * h;
  const parent = new Int32Array(N);
  for (let i = 0; i < N; i++) parent[i] = i;
  const find = (i: number) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const join = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra < rb ? rb : ra] = ra < rb ? ra : rb;
  };
  const STEP = 24;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x + 1 < w && diff(rgb, i * 3, i * 3 + 3) <= STEP) join(i, i + 1);
      if (y + 1 < h && diff(rgb, i * 3, (i + w) * 3) <= STEP) join(i, i + w);
    }
  // Paper: the region holding most of the border.
  const border = new Map<number, number>();
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) border.set(find(y * w + x), (border.get(find(y * w + x)) ?? 0) + 1);
  for (let y = 0; y < h; y++) for (const x of [0, w - 1]) border.set(find(y * w + x), (border.get(find(y * w + x)) ?? 0) + 1);
  const paper = [...border.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const pc = paper * 3;
  const inkMask = new Uint8Array(N);
  let paperish = 0;
  const byRoot = new Map<number, Region & { d: number }>();
  for (let i = 0; i < N; i++) {
    const r = find(i);
    const d = diff(rgb, i * 3, pc);
    if (d > 60) inkMask[i] = 1;
    if (d <= 30) paperish++;
    if (r === paper) continue;
    const y = (i / w) | 0, x = i - y * w;
    const g = byRoot.get(r);
    if (!g) byRoot.set(r, { y0: y, x0: x, y1: y, x1: x, n: 1, ink: false, paper: false, d });
    else {
      g.d += d;
      if (y < g.y0) g.y0 = y;
      if (y > g.y1) g.y1 = y;
      if (x < g.x0) g.x0 = x;
      if (x > g.x1) g.x1 = x;
      g.n++;
    }
  }
  const min = 3; // a glyph at the working size can be a dozen pixels
  const regions = [...byRoot.values()].filter((g) => g.n >= min).map(({ d, ...g }) => ({ ...g, ink: d / g.n > 60, paper: d / g.n <= 30 }));
  return { w, h, photo: paperish < 0.35 * N, regions, inkMask };
}

const toPx = (s: Scene, b: Box): Rect => ({ y0: (b[0] / 1000) * s.h, x0: (b[1] / 1000) * s.w, y1: (b[2] / 1000) * s.h, x1: (b[3] / 1000) * s.w });
const toBox = (s: Scene, r: Rect): Box => [
  Math.max(0, Math.floor((r.y0 / s.h) * 1000)),
  Math.max(0, Math.floor((r.x0 / s.w) * 1000)),
  Math.min(1000, Math.ceil(((r.y1 + 1) / s.h) * 1000)),
  Math.min(1000, Math.ceil(((r.x1 + 1) / s.w) * 1000)),
];
const area = (r: Rect) => Math.max(0, r.y1 - r.y0) * Math.max(0, r.x1 - r.x0);
const cut = (a: Rect, b: Rect): Rect => ({ y0: Math.max(a.y0, b.y0), x0: Math.max(a.x0, b.x0), y1: Math.min(a.y1, b.y1), x1: Math.min(a.x1, b.x1) });
const iou = (a: Rect, b: Rect) => {
  const i = area(cut(a, b));
  return i / (area(a) + area(b) - i || 1);
};
const grow = (r: Rect, k: number, s: Scene): Rect => {
  const dy = Math.max(2, (r.y1 - r.y0) * k, 0.02 * s.h), dx = Math.max(2, (r.x1 - r.x0) * k, 0.02 * s.w);
  return { y0: Math.max(0, r.y0 - dy), x0: Math.max(0, r.x0 - dx), y1: Math.min(s.h - 1, r.y1 + dy), x1: Math.min(s.w - 1, r.x1 + dx) };
};
const inkIn = (s: Scene, r: Rect) => {
  let n = 0;
  for (let y = Math.max(0, Math.round(r.y0)); y <= Math.min(s.h - 1, Math.round(r.y1)); y++)
    for (let x = Math.max(0, Math.round(r.x0)); x <= Math.min(s.w - 1, Math.round(r.x1)); x++) n += s.inkMask[y * s.w + x];
  return n;
};
/** A shape's inside region grows by its outline: on each side, an outline (lines of pixels mostly ink) starting within 3 px
 * (past the anti-aliased edge) and up to 8 px thick. `sides`: how many sides had an outline. */
function withOutline(s: Scene, r: Rect): Rect & { sides: number } {
  const frac = (q: Rect) => inkIn(s, q) / Math.max(1, (Math.round(q.y1) - Math.round(q.y0) + 1) * (Math.round(q.x1) - Math.round(q.x0) + 1));
  // The line k pixels out from one side, and the edge value it gives.
  const sides: [(k: number) => Rect, (k: number) => number, boolean][] = [
    [(k) => ({ y0: r.y0 - k, x0: r.x0, y1: r.y0 - k, x1: r.x1 }), (k) => r.y0 - k, r.y0 - 1 >= 0],
    [(k) => ({ y0: r.y1 + k, x0: r.x0, y1: r.y1 + k, x1: r.x1 }), (k) => r.y1 + k, r.y1 + 1 < s.h],
    [(k) => ({ y0: r.y0, x0: r.x0 - k, y1: r.y1, x1: r.x0 - k }), (k) => r.x0 - k, r.x0 - 1 >= 0],
    [(k) => ({ y0: r.y0, x0: r.x1 + k, y1: r.y1, x1: r.x1 + k }), (k) => r.x1 + k, r.x1 + 1 < s.w],
  ];
  const edge = sides.map(([at, value, ok]) => {
    if (!ok) return null;
    let first = 0;
    for (let k = 1; k <= 3 && !first; k++) if (frac(at(k)) > 0.6) first = k;
    if (!first) return null;
    let last = first;
    while (last - first < 8 && frac(at(last + 1)) > 0.6) last++;
    return value(last);
  });
  const o = { y0: edge[0] ?? r.y0, y1: edge[1] ?? r.y1, x0: edge[2] ?? r.x0, x1: edge[3] ?? r.x1 };
  const inside = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return { y0: inside(o.y0, 0, s.h - 1), y1: inside(o.y1, 0, s.h - 1), x0: inside(o.x0, 0, s.w - 1), x1: inside(o.x1, 0, s.w - 1), sides: edge.filter((v) => v !== null).length };
}

/** Fit one box to the picture. */
export function fitBox(s: Scene, box: Box): Fit {
  const b = toPx(s, box);
  if (s.photo) return { box, how: "photo", sure: true };
  if (area(b) < 4 || b.y1 <= b.y0 || b.x1 <= b.x0) return { box, how: "unsure", sure: false };
  const g = grow(b, 0.5, s);
  const near = s.regions.filter((r) => area(cut(r, g)) > 0);

  // Content: the whole marks mostly (70 %) inside the box that stay within the grown box (a word cut by the box is completed;
  // a stroke network or a neighbour is not pulled in).
  const all = inkIn(s, b);
  if (!all && !near.some((r) => !r.paper && area(cut(r, b)) > 0)) return { box, how: "empty", sure: false };
  let u: Rect | null = null;
  for (const r of near) {
    if (r.x0 < g.x0 || r.y0 < g.y0 || r.x1 > g.x1 || r.y1 > g.y1 || r.paper) continue;
    if (area(cut(r, b)) < 0.7 * Math.max(1, area(r))) continue;
    u = u ? { y0: Math.min(u.y0, r.y0), x0: Math.min(u.x0, r.x0), y1: Math.max(u.y1, r.y1), x1: Math.max(u.x1, r.x1) } : { ...r };
  }

  // A shape: a solid region (a fill, dark or light), or the inside of an outline closed on all four sides (not the gap between arrows), with its
  // outline, between a fifth and four times the box, matching it (IoU 0.4 or more).
  const shapes = near
    .filter((r) => r.n >= 0.3 * area(r) && area(r) <= 4 * area(b) && area(r) >= 0.2 * area(b)) // solid, not a stroke network
    .map((r) => ({ r: withOutline(s, r), paper: r.paper }))
    .filter((c) => !c.paper || c.r.sides === 4)
    // a box lying inside a shape counts as a match down to IoU 0.25 (too small grows to the shape it sits on)
    .map((c) => ({ r: c.r as Rect, score: iou(c.r, b) >= 0.25 && area(cut(c.r, b)) >= 0.9 * area(b) ? Math.max(0.4, iou(c.r, b)) : iou(c.r, b) }))
    .sort((p, q) => q.score - p.score);
  const best = shapes[0];
  if (best && best.score >= 0.4) {
    // Another shape about as good, or much of the box's ink outside this shape: the box spans several parts.
    const rival = shapes.slice(1).find((c) => c.score >= 0.8 * best.score && area(cut(c.r, best.r)) < 0.8 * Math.min(area(c.r), area(best.r)));
    const outside = all - inkIn(s, cut(b, best.r));
    const spread = all > 0 && outside > 0.35 * all;
    return { box: toBox(s, best.r), how: rival || spread ? "unsure" : "shape", sure: !rival && !spread };
  }
  // Marks: used when they hold most of the box's ink (not strokes merely passing through); sure when they match the box.
  if (!u || inkIn(s, cut(b, u)) < 0.5 * all) return { box, how: "unsure", sure: false };
  return { box: toBox(s, u), how: "marks", sure: iou(u, b) >= 0.5 };
}

/** The tight box around the ink pixels inside a rectangle; null when there are none. */
function inkBox(s: Scene, r: Rect): Rect | null {
  let o: Rect | null = null;
  for (let y = Math.max(0, Math.round(r.y0)); y <= Math.min(s.h - 1, Math.round(r.y1)); y++)
    for (let x = Math.max(0, Math.round(r.x0)); x <= Math.min(s.w - 1, Math.round(r.x1)); x++) {
      if (!s.inkMask[y * s.w + x]) continue;
      if (!o) o = { y0: y, x0: x, y1: y, x1: x };
      else {
        if (y < o.y0) o.y0 = y;
        if (y > o.y1) o.y1 = y;
        if (x < o.x0) o.x0 = x;
        if (x > o.x1) o.x1 = x;
      }
    }
  return o;
}

const SURE = new Set(["high", "hand-fixed"]);
/** Fit every stop of a tour to the picture. Prepared (hand-fixed) stops and chart data tours are left alone; a stop whose fit
 * is not clean drops to "medium" (no ring). On any failure the tour comes back unchanged. */
export type Fitted = Tour & { fitted?: number }; // saved with the tour so a cached one is fitted once (lib/types.ts stays as is)
export const FIT = 2; // 2: a ring that cuts through other parts is hidden (straddlers)

/**
 * Rings that sprawl across other parts read as wrong: a connector's whole extent (a curved arrow) covers pieces of the parts it
 * joins. True for a box that cuts through two or more smaller boxes, covering between a fifth and nine tenths of each; a box
 * that holds another whole is a container (a column of a diagram) and stays.
 */
export function straddlers(boxes: Box[]): boolean[] {
  const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const share = (a: Box, b: Box) => {
    const h = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), w = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    return h > 0 && w > 0 && area(b) ? (h * w) / area(b) : 0; // how much of b lies under a
  };
  return boxes.map((a, i) => boxes.filter((b, k) => k !== i && area(b) < area(a) && share(a, b) > 0.2 && share(a, b) < 0.9).length >= 2);
}

export async function fitTour(tour: Fitted, image: Uint8Array | null): Promise<Fitted> {
  if (!image || tour.chart || (tour.fitted ?? 0) >= FIT || tour.stops.some((x) => x.confidence === "hand-fixed")) return tour;
  const px = await pixels(image);
  if (!px) return tour;
  try {
    const scene = analyse(px.w, px.h, px.rgb);
    const stops: TourStop[] = tour.stops.map((st) => {
      if (st.box_2d.join() === "0,0,1000,1000") return st; // the whole picture
      const f = fitBox(scene, st.box_2d as Box);
      return { ...st, box_2d: f.box, confidence: SURE.has(st.confidence) && !f.sure ? "medium" : st.confidence };
    });
    const ringed = stops.flatMap((st, i) => (SURE.has(st.confidence) && st.box_2d.join() !== "0,0,1000,1000" ? [i] : []));
    straddlers(ringed.map((i) => stops[i].box_2d as Box)).forEach((cuts, k) => cuts && (stops[ringed[k]] = { ...stops[ringed[k]], confidence: "medium" }));
    return { ...tour, stops, fitted: FIT };
  } catch {
    return tour;
  }
}

/** A zoomed crop around a box (the box grown by its own size, at least a fifth of the picture each way), as PNG, and the
 * window it covers on the 0 to 1000 scale; null when the picture cannot be read. */
export async function cropAround(image: Uint8Array, box: Box): Promise<{ png: Buffer; window: Box } | null> {
  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(image, { limitInputPixels: MAX_INPUT }).metadata();
    const [W, H] = [meta.width ?? 0, meta.height ?? 0];
    if (!W || !H) return null;
    const dy = Math.max(box[2] - box[0], 200), dx = Math.max(box[3] - box[1], 200);
    const win: Box = [Math.max(0, box[0] - dy), Math.max(0, box[1] - dx), Math.min(1000, box[2] + dy), Math.min(1000, box[3] + dx)];
    const [top, left] = [Math.floor((win[0] / 1000) * H), Math.floor((win[1] / 1000) * W)];
    const [height, width] = [Math.max(1, Math.ceil((win[2] / 1000) * H) - top), Math.max(1, Math.ceil((win[3] / 1000) * W) - left)];
    const png = await sharp(image, { limitInputPixels: MAX_INPUT })
      .timeout({ seconds: 3 })
      .flatten({ background: "#fff" })
      .extract({ top, left, width: Math.min(width, W - left), height: Math.min(height, H - top) })
      .resize({ width: 768, height: 768, fit: "inside" })
      .png()
      .toBuffer();
    return { png, window: win };
  } catch {
    return null;
  }
}

/** A box given on a crop's 0 to 1000 scale, back on the whole picture's. */
export const fromCrop = (win: Box, b: Box): Box => {
  const [h, w] = [win[2] - win[0], win[3] - win[1]];
  return [Math.round(win[0] + (b[0] * h) / 1000), Math.round(win[1] + (b[1] * w) / 1000), Math.round(win[0] + (b[2] * h) / 1000), Math.round(win[1] + (b[3] * w) / 1000)];
};
