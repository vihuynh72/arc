// Chart tours: validation, statistics, interpolation, pitch and the spoken tour, all in code. Shared by server and client.
// Every number spoken here is computed from the points; nothing is copied from the model's prose.
import type { Box, Tour, TourStop } from "./types";

export type Chart = NonNullable<Tour["chart"]>;
type Axis = Chart["x"];
type Pt = Chart["series"][number]["points"][number];
type Series = Chart["series"][number];

/** What the chart model returns (loosely typed: it is untrusted until `cleanChart`). */
export interface RawChart {
  chart_type?: string;
  title?: string;
  takeaway?: string;
  x_axis?: Partial<Axis>;
  y_axis?: Partial<Axis>;
  plot_area?: unknown;
  legend_area?: unknown;
  series?: { name?: string; color?: string; points?: { x?: unknown; y?: unknown; label?: string }[] }[];
  notable?: string[];
  confidence?: string;
  unreadable?: string | null;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function cleanBox(b: unknown): Box | null {
  const flat = Array.isArray(b) && Array.isArray(b[0]) ? b[0] : b;
  if (!Array.isArray(flat) || flat.length !== 4 || !flat.every((v) => num(v) !== null)) return null;
  const [y0, x0, y1, x1] = flat.map((v: number) => Math.min(1000, Math.max(0, Math.round(v))));
  return y0 < y1 && x0 < x1 ? [y0, x0, y1, x1] : null;
}

const axis = (a: Partial<Axis> | undefined): Axis => ({
  label: (a?.label ?? "").trim(),
  unit: a?.unit?.trim() || null,
  min: num(a?.min),
  max: num(a?.max),
});

/** Keep finite points inside the axis ranges (5% slack is clamped, wilder ones dropped), sorted by x; fewer than 3 is unreadable. */
function cleanPoints(raw: { x?: unknown; y?: unknown; label?: string }[] | undefined, x: Axis, y: Axis): Pt[] {
  const fit = (v: number, a: Axis) => {
    if (a.min === null || a.max === null || a.max <= a.min) return v;
    const slack = (a.max - a.min) * 0.05;
    if (v < a.min - slack || v > a.max + slack) return null;
    return Math.min(a.max, Math.max(a.min, v));
  };
  const pts: Pt[] = [];
  for (const p of raw ?? []) {
    const px = num(p.x);
    const py = num(p.y);
    if (px === null || py === null) continue;
    const fx = fit(px, x);
    const fy = fit(py, y);
    if (fx === null || fy === null) continue;
    pts.push(p.label ? { x: fx, y: fy, label: p.label } : { x: fx, y: fy });
  }
  pts.sort((a, b) => a.x - b.x);
  return pts.length >= 3 ? pts : [];
}

/** Model output to chart data. Series without readable points stay listed by name with no points. */
export function cleanChart(raw: RawChart): (Chart & { legend: Box | null }) | null {
  const plot = cleanBox(raw.plot_area);
  if (!plot) return null;
  const x = axis(raw.x_axis);
  const y = axis(raw.y_axis);
  const series: Series[] = (raw.series ?? [])
    .filter((s) => s.name)
    .slice(0, 6)
    .map((s) => ({ name: s.name!.trim(), ...(s.color ? { color: s.color } : {}), points: raw.unreadable ? [] : cleanPoints(s.points, x, y) }));
  const type = ["line", "bar", "scatter", "pie"].includes(raw.chart_type ?? "") ? raw.chart_type! : "other";
  return { type, x, y, plot, series, legend: cleanBox(raw.legend_area) };
}

/** Linear interpolation of a series at x; clamps to the first and last point. */
export function valueAt(points: Pt[], x: number): number {
  if (!points.length) return NaN;
  if (x <= points[0].x) return points[0].y;
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1];
    const b = points[k];
    if (x <= b.x) return b.x === a.x ? b.y : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
  }
  return points[points.length - 1].y;
}

/** Pitch for a value: the series' min..max maps to 220..880 Hz on a log scale (two octaves), clamped. */
export function pitch(y: number, min: number, max: number): number {
  const t = max > min ? Math.min(1, Math.max(0, (y - min) / (max - min))) : 0.5;
  return 220 * Math.pow(4, t);
}

/** Number of peaks: rises and falls of at least `share` of the series' range (hysteresis, so noise is not counted). */
export function countPeaks(ys: number[], share = 0.3): number {
  if (ys.length < 3) return 0;
  const thr = (Math.max(...ys) - Math.min(...ys)) * share;
  if (thr <= 0) return 0;
  let peaks = 0;
  let lo = ys[0];
  let hi = ys[0];
  let up = true;
  for (const y of ys) {
    if (up) {
      if (y > hi) hi = y;
      else if (hi - y >= thr) {
        if (hi - lo >= thr) peaks++;
        up = false;
        lo = y;
      }
    } else if (y < lo) lo = y;
    else if (y - lo >= thr) {
      up = true;
      hi = y;
    }
  }
  return peaks;
}

export function stats(points: Pt[]) {
  let min = points[0];
  let max = points[0];
  for (const p of points) {
    if (p.y < min.y) min = p;
    if (p.y > max.y) max = p;
  }
  const mean = points.reduce((a, p) => a + p.y, 0) / points.length;
  return { min, max, start: points[0], end: points[points.length - 1], mean, peaks: countPeaks(points.map((p) => p.y)) };
}

/** Rounds to a step that suits the range: range 100 rounds to whole numbers, range 1 to hundredths. */
export function round(v: number, range: number): string {
  const step = range > 0 ? Math.pow(10, Math.floor(Math.log10(range / 20))) : 1;
  const r = Math.round(v / step) * step;
  const digits = Math.max(0, -Math.floor(Math.log10(step)));
  return (Object.is(r, -0) ? 0 : r).toFixed(digits).replace(/^-/, "minus ");
}

/** The axis title as a spoken noun: "sample point #" becomes "sample point". */
const noun = (a: Axis, fallback: string) => a.label.replace(/[#()[\]]/g, "").replace(/\s+/g, " ").trim().toLowerCase() || fallback;
const unitWord = (a: Axis) => {
  const u = a.unit ?? (/^deg/i.test(a.label) ? "degrees" : "");
  return u === "°" || /^deg/i.test(u) ? " degrees" : u ? ` ${u}` : "";
};

/** Value range of an axis: printed limits when present, else the data. */
function span(c: Chart, which: "x" | "y"): [number, number] {
  const a = c[which];
  const all = c.series.flatMap((s) => s.points.map((p) => p[which]));
  const lo = a.min ?? (all.length ? Math.min(...all) : 0);
  const hi = a.max ?? (all.length ? Math.max(...all) : 1);
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}

/** Pointer position (0 to 1000 across the figure) to the x value under it, or null outside the plot area. */
export function xAtPointer(c: Chart, px: number, py: number): number | null {
  const [y0, x0, y1, x1] = c.plot;
  if (px < x0 || px > x1 || py < y0 || py > y1) return null;
  const [lo, hi] = span(c, "x");
  return lo + ((px - x0) / (x1 - x0)) * (hi - lo);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const xLabel = (c: Chart, x: number, s?: Series) => {
  const p = s?.points.find((q) => q.x === x && q.label);
  return p?.label ?? round(x, span(c, "x")[1] - span(c, "x")[0]);
};

/** "At sample point 120: left thigh angle about 45 degrees, right thigh angle about 38." Active series first. */
export function reading(c: Chart, x: number, active = 0): string {
  const yr = span(c, "y")[1] - span(c, "y")[0];
  const order = [active, ...c.series.map((_, k) => k).filter((k) => k !== active)];
  const parts = order
    .map((k) => c.series[k])
    .filter((s) => s && s.points.length && x >= s.points[0].x && x <= s.points[s.points.length - 1].x)
    .map((s, j) => `${s.name.toLowerCase()} about ${round(valueAt(s.points, x), yr)}${j === 0 ? unitWord(c.y) : ""}`);
  const where = `At ${noun(c.x, "x")} ${xLabel(c, x)}`;
  return parts.length ? `${where}: ${parts.join(", ")}.` : `${where}: no values here.`;
}

/** One point of one series, for Shift+Arrow stepping: "Sample point 30: about 80 degrees, the highest point." */
export function pointLine(c: Chart, si: number, k: number): string {
  const s = c.series[si];
  const p = s.points[k];
  const st = stats(s.points);
  const yr = span(c, "y")[1] - span(c, "y")[0];
  const tag = p === st.max ? ", the highest point" : p === st.min ? ", the lowest point" : "";
  const end = k === 0 ? " First value." : k === s.points.length - 1 ? " Last value." : "";
  return `${cap(noun(c.x, "x"))} ${xLabel(c, p.x, s)}: about ${round(p.y, yr)}${unitWord(c.y)}${tag}.${end}`;
}

/** Index into chart.series for the stop the student is on; 0 when the stop is not a series stop. */
export const seriesOfStop = (c: Chart, stop?: TourStop) => Math.max(0, c.series.findIndex((s) => s.name === stop?.label));

function seriesSays(c: Chart, s: Series): string {
  if (!s.points.length) return "Its values cannot be read from the picture.";
  const st = stats(s.points);
  const yr = span(c, "y")[1] - span(c, "y")[0];
  const xr = span(c, "x")[1] - span(c, "x")[0];
  const u = unitWord(c.y);
  const xn = noun(c.x, "x");
  const v = (y: number) => round(y, yr);
  const at = (p: Pt) => `${xn} ${p.label ?? round(p.x, xr)}`;
  let shape: string;
  if (st.peaks >= 2) shape = `rises to about ${v(st.max.y)} and falls back, about ${st.peaks} times`;
  else if (st.peaks === 1) shape = `rises to about ${v(st.max.y)} at ${at(st.max)}, then falls to about ${v(st.end.y)}`;
  else if (st.end.y - st.start.y > yr * 0.1) shape = `rises to about ${v(st.end.y)} by the end`;
  else if (st.start.y - st.end.y > yr * 0.1) shape = `falls to about ${v(st.end.y)} by the end`;
  else shape = `stays near that level`;
  return `Starts at about ${v(st.start.y)}${u}, ${shape}. Highest about ${v(st.max.y)} at ${at(st.max)}; lowest about ${v(st.min.y)} at ${at(st.min)}.`;
}

/** Which series is higher on average, the largest gap and where, and how often they cross. Two series only (the first two). */
export function compare(c: Chart): string {
  const [a, b] = c.series.filter((s) => s.points.length);
  if (!a || !b) return "";
  const lo = Math.max(a.points[0].x, b.points[0].x);
  const hi = Math.min(a.points[a.points.length - 1].x, b.points[b.points.length - 1].x);
  if (hi <= lo) return `${cap(a.name)} and ${b.name} cover different stretches of the ${noun(c.x, "x")} axis.`;
  const yr = span(c, "y")[1] - span(c, "y")[0];
  const xr = span(c, "x")[1] - span(c, "x")[0];
  const n = 200;
  let sum = 0;
  let gap = 0;
  let gapX = lo;
  let crosses = 0;
  let sign = 0;
  for (let k = 0; k <= n; k++) {
    const x = lo + ((hi - lo) * k) / n;
    const d = valueAt(a.points, x) - valueAt(b.points, x);
    sum += d;
    if (Math.abs(d) > Math.abs(gap) + 1e-9) {
      gap = d;
      gapX = x;
    }
    if (Math.abs(d) > yr * 0.02) {
      const sg = Math.sign(d);
      if (sign && sg !== sign) crosses++;
      sign = sg;
    }
  }
  const mean = sum / (n + 1);
  const [up, down] = mean >= 0 ? [a, b] : [b, a];
  const u = unitWord(c.y);
  const first =
    Math.abs(mean) < yr * 0.02
      ? `${cap(a.name)} and ${b.name.toLowerCase()} are about the same on average.`
      : `${cap(up.name)} is higher on average than ${down.name.toLowerCase()}, by about ${round(Math.abs(mean), yr)}${u}.`;
  const big = `The largest gap is about ${round(Math.abs(gap), yr)}${u}, at ${noun(c.x, "x")} ${round(gapX, xr)}, where ${(gap > 0 ? a : b).name.toLowerCase()} is higher.`;
  const cross = crosses ? `They cross about ${crosses} times.` : "They do not cross.";
  return `${first} ${big} ${cross}`;
}

/** The whole chart tour, built in code so its sentences and boxes agree. */
export function chartTour(
  c: Chart & { legend: Box | null },
  info: { title: string; takeaway: string; notable: string[]; unreadable: string | null; confidence: string },
  source: string,
): Tour {
  const { legend, ...chart } = c;
  const readable = chart.series.filter((s) => s.points.length);
  const [py0, px0, py1, px1] = chart.plot;
  const stops: Omit<TourStop, "n">[] = [];
  const add = (label: string, says: string, box: Box, confidence = "high") => stops.push({ label, says, box_2d: box, confidence });
  add("Main finding", info.takeaway || info.title, [0, 0, 1000, 1000]);

  const range = (a: Axis, which: "x" | "y") => {
    if (a.min === null && a.max === null && !readable.length) return "No numbers are printed on it.";
    const [lo, hi] = span(chart, which);
    return `From about ${round(lo, hi - lo)} to about ${round(hi, hi - lo)}${which === "y" ? unitWord(a) : ""}.`;
  };
  if (chart.x.label || chart.x.min !== null)
    add("Horizontal axis", `${cap(noun(chart.x, "not labelled"))}. ${range(chart.x, "x")}`, [py1, px0, Math.min(1000, py1 + 110), px1]);
  if (chart.y.label || chart.y.min !== null)
    add("Vertical axis", `${cap(noun(chart.y, "not labelled"))}. ${range(chart.y, "y")}`, [py0, Math.max(0, px0 - 110), py1, px0]);
  if (chart.series.length) {
    const names = chart.series.map((s) => (s.color ? `${s.name} (${s.color})` : s.name));
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    add("Legend", `${chart.series.length === 1 ? "One series" : `${chart.series.length} series`}: ${list}.`, legend ?? chart.plot);
  }
  if (info.unreadable || !readable.length)
    add("Values", `The values cannot be read from this picture: ${(info.unreadable || "no scale is printed").replace(/\.+$/, "")}. Only the shapes can be compared.`, chart.plot, "low");

  // Each series gets the band of the plot its values occupy, so series at different heights get different boxes.
  const [ylo, yhi] = span(chart, "y");
  const toY = (v: number) => Math.round(py1 - ((v - ylo) / (yhi - ylo)) * (py1 - py0));
  for (const s of readable) {
    const st = stats(s.points);
    const box: Box = [Math.max(py0, toY(st.max.y) - 15), px0, Math.min(py1, toY(st.min.y) + 15), px1];
    add(s.name, seriesSays(chart, s), box[0] < box[2] ? box : chart.plot, info.confidence === "low" ? "low" : "high");
  }
  const cmp = compare(chart);
  if (cmp) add("Comparison", cmp, chart.plot);
  const notes = info.notable.map((t) => t.trim()).filter(Boolean).slice(0, 3);
  if (notes.length) add("Also notable", notes.join(" "), chart.plot, "medium");

  const kind = chart.type === "other" ? "chart" : `${chart.type} chart`;
  const overview = `${info.title}. A ${kind}${chart.series.length ? ` with ${chart.series.length} series` : ""}.`;
  return {
    title: info.title,
    overview,
    source,
    stops: stops.map((s, k) => ({ n: k + 1, ...s })),
    ...(readable.length ? { chart: { ...chart, series: readable } } : {}),
  };
}
