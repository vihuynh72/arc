// Spoken spatial cues from box centers. Pure code: cues never come from the model.
import type { Box, TourStop } from "./types";

const center = (box: Box | [Box]) => {
  const [ymin, xmin, ymax, xmax] = (Array.isArray(box[0]) ? box[0] : box) as Box; // boxes sometimes arrive wrapped
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
  const dx = c.x - p.x;
  const dy = c.y - p.y;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const h = dx < 0 ? "to the left" : "to the right";
  const v = dy < 0 ? "up" : "down";
  const dir = ax > 60 && ay > 60 ? `${v} and ${h}` : ax >= ay ? h : v;
  const m = Math.max(ax, ay);
  return `Move ${m < 60 ? "a little " : m > 250 ? "far " : ""}${dir}.`;
}

/** The line the tour voice speaks at a stop. */
export const stopLine = (stops: TourStop[], i: number) =>
  `${cue(stops[i], stops[i - 1])} ${stops[i].label}. ${stops[i].says}`;
