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

/** "far up and to the right": both axes named when both differ by more than 60. */
function way(dx: number, dy: number): string {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const h = dx < 0 ? "to the left" : "to the right";
  const v = dy < 0 ? "up" : "down";
  const dir = ax > 60 && ay > 60 ? `${v} and ${h}` : ax >= ay ? h : v;
  const m = Math.max(ax, ay);
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
