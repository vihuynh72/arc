// Spoken spatial cues from box centers. Pure code: cues never come from the model.
import type { Box, TourStop } from "./types";

const flat = (box: Box | [Box]) => (Array.isArray(box[0]) ? box[0] : box) as Box; // boxes sometimes arrive wrapped

const center = (box: Box | [Box]) => {
  const [ymin, xmin, ymax, xmax] = flat(box);
  return { y: (ymin + ymax) / 2, x: (xmin + xmax) / 2 };
};

const third = (v: number, words: [string, string, string]) => words[v < 1000 / 3 ? 0 : v < 2000 / 3 ? 1 : 2];

/** "Start at the top right." for the first stop, else the move from the previous stop. */
export function cue(stop: TourStop, prev?: TourStop): string {
  const c = center(stop.box_2d);
  if (!prev) {
    const row = third(c.y, ["top", "middle", "bottom"]);
    const col = third(c.x, ["left", "center", "right"]);
    return row === "middle" && col === "center" ? "Start at the center." : `Start at the ${row} ${col === "center" ? "middle" : col}.`;
  }
  const p = center(prev.box_2d);
  return `Move ${way(c.x - p.x, c.y - p.y)}.`;
}

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

/** The line the tour voice speaks at a stop. */
export const stopLine = (stops: TourStop[], i: number) =>
  `${cue(stops[i], stops[i - 1])} ${stops[i].label}. ${stops[i].says}`;

/** Index of the smallest stop box containing the point (0 to 1000 scale), or -1. Every stop counts, whatever its confidence. */
export function hitStop(stops: TourStop[], y: number, x: number): number {
  let best = -1;
  let area = Infinity;
  stops.forEach((s, i) => {
    const [y0, x0, y1, x1] = flat(s.box_2d);
    if (y >= y0 && y <= y1 && x >= x0 && x <= x1 && (y1 - y0) * (x1 - x0) < area) {
      best = i;
      area = (y1 - y0) * (x1 - x0);
    }
  });
  return best;
}

/** "Belt is up and to the right." for the stop whose box centre is nearest the point. Empty when there are no stops. */
export function nearestHint(stops: TourStop[], y: number, x: number): string {
  let best: TourStop | undefined;
  let d = Infinity;
  for (const s of stops) {
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

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
