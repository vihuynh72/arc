// Spoken spatial cues from box centers. Pure code: cues never come from the model.
import type { Box, TourStop } from "./types";

export const flat = (box: Box | [Box]) => (Array.isArray(box[0]) ? box[0] : box) as Box; // boxes sometimes arrive wrapped

const center = (box: Box | [Box]) => {
  const [ymin, xmin, ymax, xmax] = flat(box);
  return { y: (ymin + ymax) / 2, x: (xmin + xmax) / 2 };
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const third = (v: number, words: [string, string, string]) => words[v < 1000 / 3 ? 0 : v < 2000 / 3 ? 1 : 2];

/** The direction words every cue shares: both axes named when both differ by more than 60. */
function dirs(dx: number, dy: number, side: (h: string) => string) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const h = side(dx < 0 ? "left" : "right");
  const v = dy < 0 ? "up" : "down";
  return { dir: ax > 60 && ay > 60 ? `${v} and ${h}` : ax >= ay ? h : v, m: Math.max(ax, ay), across: ax >= ay, v };
}

/** "far up and to the right". */
function way(dx: number, dy: number): string {
  const { dir, m } = dirs(dx, dy, (h) => `to the ${h}`);
  return `${m < 60 ? "a little " : m > 250 ? "far " : ""}${dir}`;
}

/** A pie chart's slices say where they are as a clock position (lib/chart.ts), so the tour gives no "move left" or "move down" for it.
 * A pie tour saved before that has no clock words; it is known by its second stop, and says no direction at all. */
const CLOCK = /, at about \d+ o'clock\./;
export const isPie = (stops: TourStop[]) => stops.some((s) => CLOCK.test(s.says)) || (stops[1]?.label === "Slices" && /^Largest:/.test(stops[1].says));

/** A stop whose box Arc trusts (hand-fixed, or fitted cleanly: lib/server/ringFit.ts): only these get a ring, a pointer glide,
 * a place in words, and can be found by hand. The others are described, never pointed at. */
const TRUSTED = new Set(["hand-fixed", "high"]);
export const placed = (s: TourStop | undefined) => !!s && TRUSTED.has(s.confidence);

/** Where a part sits on the picture, from its box, as a reader of the picture would say it: "Top right", "Center", "Middle left",
 * "Across the bottom" (a wide part), "Down the left side" (a tall one). Empty for a box over most of the picture. */
export function place(box: Box | [Box]): string {
  const [y0, x0, y1, x1] = flat(box);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w > 700 && h > 700) return "";
  const c = center(box);
  const row = third(c.y, ["top", "middle", "bottom"]);
  const col = third(c.x, ["left", "center", "right"]);
  if (w > 600 && h < 400) return `Across the ${row}`;
  if (h > 600 && w < 400) return col === "center" ? "Down the middle" : `Down the ${col} side`;
  if (row === "middle") return col === "center" ? "Center" : `Middle ${col}`;
  return `${cap(row)} ${col}`;
}

/** "below it", "to its left": where a part is from the one before, for two parts in the same place on the picture. */
function relation(box: Box | [Box], prev: Box | [Box]): string {
  const c = center(box);
  const p = center(prev);
  const { dir, m } = dirs(c.x - p.x, c.y - p.y, (h) => `to its ${h}`);
  return m < 40 ? "" : dir.replace(/^up/, "above it").replace(/^down/, "below it").replace(" and to its", " and to the");
}

/** The line the tour voice speaks at a stop when Arc moves to it (the self-running tour, a key, a spoken "next"): where the part
 * is, then the part. Never an instruction: Arc moves, not the student. A part with no trusted place, and a pie (its slices say
 * their clock position), get no place words. */
export function stopLine(stops: TourStop[], i: number): string {
  const s = stops[i];
  const at = isPie(stops) || !placed(s) ? "" : place(s.box_2d);
  const p = stops[i - 1];
  const rel = at && placed(p) && place(p.box_2d) === at ? relation(s.box_2d, p.box_2d) : "";
  return `${at ? `${at}${rel ? `, ${rel}` : ""}: ` : ""}${s.label}. ${s.says}`;
}

/** Index of the smallest stop box containing the point (0 to 1000 scale), or -1. Every stop counts unless `ok` says otherwise. */
export function hitStop(stops: TourStop[], y: number, x: number, ok: (s: TourStop) => boolean = () => true): number {
  let best = -1;
  let area = Infinity;
  stops.forEach((s, i) => {
    const [y0, x0, y1, x1] = flat(s.box_2d);
    if (ok(s) && y >= y0 && y <= y1 && x >= x0 && x <= x1 && (y1 - y0) * (x1 - x0) < area) {
      best = i;
      area = (y1 - y0) * (x1 - x0);
    }
  });
  return best;
}

/** "Belt is up and to the right." for the stop (of those `ok` allows) whose box centre is nearest the point. Empty when there are no stops. */
export function nearestHint(stops: TourStop[], y: number, x: number, ok: (s: TourStop) => boolean = () => true): string {
  let best: TourStop | undefined;
  let d = Infinity;
  for (const s of stops.filter(ok)) {
    const c = center(s.box_2d);
    const e = Math.hypot(c.x - x, c.y - y);
    if (e < d) {
      best = s;
      d = e;
    }
  }
  if (!best) return "";
  const c = center(best.box_2d);
  return `${best.label.charAt(0).toUpperCase()}${best.label.slice(1)} is ${way(c.x - x, c.y - y)}.`;
}

// ---- guided seeking: talking a pointer onto the next stop ----


/** From the point to the nearest point of the box: (0, 0) inside it. */
function gap(box: Box | [Box], y: number, x: number) {
  const [y0, x0, y1, x1] = flat(box);
  return { dx: Math.min(Math.max(x, x0), x1) - x, dy: Math.min(Math.max(y, y0), y1) - y };
}

/** Distance from the point to the nearest point of the box, in picture units (0 to 1000); 0 inside. */
export function boxDistance(box: Box | [Box], y: number, x: number): number {
  const { dx, dy } = gap(box, y, x);
  return Math.hypot(dx, dy);
}

/** Guidance tick bounds: every 600 ms at 300 Hz when 600 or more away, every 120 ms at 900 Hz at the box edge. */
export const GUIDE = { reach: 600, slow: 600, fast: 120, low: 300, high: 900 };

/** How often and how high the guidance tick plays at this distance: closer is faster and higher. */
export function guideTick(d: number): { ms: number; hz: number } {
  const t = Math.min(1, Math.max(0, d) / GUIDE.reach);
  return { ms: Math.round(GUIDE.fast + (GUIDE.slow - GUIDE.fast) * t), hz: Math.round(GUIDE.high - (GUIDE.high - GUIDE.low) * t) };
}

/** True when the pointer got closer to the target since the last reading. */
export const towards = (before: number, now: number) => now < before - 1;

/** A one or two word course correction toward the box: "Left.", "Up a little.", "Down and right." */
export function correction(box: Box | [Box], y: number, x: number): string {
  const { dx, dy } = gap(box, y, x);
  const { dir, m } = dirs(dx, dy, (h) => h);
  return `${cap(dir)}${m < 120 ? " a little" : ""}.`;
}

/** After resting short of the box: "Keep going left, about halfway across." */
export function keepGoing(box: Box | [Box], y: number, x: number): string {
  const { dx, dy } = gap(box, y, x);
  const { dir, m, across, v } = dirs(dx, dy, (h) => h);
  const span = across ? "across" : v;
  const how = m < 120 ? "just a little more" : m < 350 ? `about a quarter of the way ${span}` : m < 650 ? `about halfway ${span}` : `most of the way ${span}`;
  return `Keep going ${dir}, ${how}.`;
}

export const LAST_PART = "That is the last part. Press Escape to leave, or move around to explore.";

/** "Next: right thigh. Move down and to the left." from the pointer (nearest edge of the box) or, without one, from the stop
 * before it (centre to centre, as the stop cues do). After the last stop, how to leave. */
export function nextLine(stops: TourStop[], k: number, from?: { y: number; x: number } | null): string {
  const t = stops[k];
  if (!t) return LAST_PART;
  if (from) {
    const { dx, dy } = gap(t.box_2d, from.y, from.x);
    return `Next: ${t.label}. ${dx || dy ? `Move ${way(dx, dy)}.` : "You are on it."}`;
  }
  const p = stops[k - 1] ? center(stops[k - 1].box_2d) : { y: 500, x: 500 };
  const c = center(t.box_2d);
  return `Next: ${t.label}. Move ${way(c.x - p.x, c.y - p.y)}.`;
}
