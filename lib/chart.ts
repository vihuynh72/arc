// Chart tours: validation, statistics, interpolation, pitch and the spoken tour, all in code. Shared by server and client.
// Every number spoken here is computed from the points; nothing is copied from the model's prose.
import type { Box, Tour, TourStop } from "./types";

export type Chart = NonNullable<Tour["chart"]>;
type Axis = Chart["x"];
type Pt = Chart["series"][number]["points"][number];
type Series = Chart["series"][number];

type RawAxis = Partial<Omit<Axis, "ticks">> & { ticks?: unknown };
/** What the chart model returns (loosely typed: it is untrusted until `cleanChart`). */
export interface RawChart {
  chart_type?: string;
  title?: string;
  takeaway?: string;
  x_axis?: RawAxis;
  y_axis?: RawAxis;
  plot_area?: unknown;
  legend_area?: unknown;
  series?: { name?: string; color?: string; values?: unknown[]; points?: { x?: unknown; y?: unknown; label?: string; printed?: boolean; note?: string }[] }[];
  /** Bar charts: labels along the category axis, in axis order; series then carry `values`, one per category. */
  categories?: unknown[];
  stacked?: boolean;
  /** Stacked bars: the top of each stack (printed, or read off the axis), one per category. */
  totals?: unknown[];
  /** Pies: the bounding box of the whole circle. */
  pie_area?: unknown;
  notable?: string[];
  confidence?: string;
  unreadable?: string | null;
  /** Box plots: one per group. */
  boxes?: { label?: string; min?: unknown; q1?: unknown; median?: unknown; q3?: unknown; max?: unknown }[];
  /** Heat maps and matrices: one per readable cell. */
  cells?: { row?: string; col?: string; value?: unknown }[];
}

/** Kinds read from the picture. Pie, box and heat map get stops only (no pitch scrub): their x axis is not a line to follow. */
export const CHART_TYPES = ["line", "bar", "stacked_bar", "histogram", "scatter", "pie", "box", "heatmap"];
type BoxStat = { label: string; min: number; q1: number; median: number; q3: number; max: number };
type Cell = { row: string; col: string; value: number };
type Slice = { label: string; value: number; printed: boolean; note: string; box: Box };
type Bars = { categories: string[]; series: { name: string; color?: string; values: (number | null)[] }[]; stacked: boolean; totals: number[]; approx: boolean[]; pos: number[] };
export type CleanChart = Chart & { legend: Box | null; boxes?: BoxStat[]; cells?: Cell[]; slices?: Slice[]; bars?: Bars };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function cleanBox(b: unknown): Box | null {
  const flat = Array.isArray(b) && Array.isArray(b[0]) ? b[0] : b;
  if (!Array.isArray(flat) || flat.length !== 4 || !flat.every((v) => num(v) !== null)) return null;
  const [y0, x0, y1, x1] = flat.map((v: number) => Math.min(1000, Math.max(0, Math.round(v))));
  return y0 < y1 && x0 < x1 ? [y0, x0, y1, x1] : null;
}

const axis = (a: RawAxis | undefined): Axis => {
  const out: Axis = { label: (a?.label ?? "").trim(), unit: a?.unit?.trim() || null, min: num(a?.min), max: num(a?.max) };
  // A log axis needs positive limits; otherwise it is read as linear.
  if (a?.scale === "log" && (out.min === null || out.min > 0)) out.scale = "log";
  const t = Array.isArray(a?.ticks) ? a.ticks.map(num) : [];
  if (t.length === 2 && t[0] !== null && t[1] !== null && t[1] > t[0]) out.ticks = [t[0], t[1]];
  return out;
};

const isLog = (a: Axis) => a.scale === "log";
/** Where v sits along an axis from lo to hi, 0 to 1, honouring a log scale. */
function frac(a: Axis, v: number, lo: number, hi: number): number {
  if (isLog(a) && lo > 0 && v > 0) return (Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo));
  return (v - lo) / (hi - lo);
}
function unfrac(a: Axis, t: number, lo: number, hi: number): number {
  if (isLog(a) && lo > 0) return Math.pow(10, Math.log10(lo) + t * (Math.log10(hi) - Math.log10(lo)));
  return lo + t * (hi - lo);
}

/** Keep finite points inside the axis ranges (5% slack is clamped, wilder ones dropped), sorted by x; fewer than 3 is unreadable. */
function cleanPoints(raw: { x?: unknown; y?: unknown; label?: string; printed?: boolean }[] | undefined, x: Axis, y: Axis): Pt[] {
  const fit = (v: number, a: Axis) => {
    if (a.min === null || a.max === null || a.max <= a.min) return v;
    const t = frac(a, v, a.min, a.max);
    if (!Number.isFinite(t) || t < -0.05 || t > 1.05) return null;
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
    pts.push({ x: fx, y: fy, ...(p.label ? { label: p.label } : {}), ...(p.printed ? { printed: true } : {}) });
  }
  pts.sort((a, b) => a.x - b.x);
  return pts.length >= 3 ? pts : [];
}

/** A wedge's box from its angles (0 = 12 o'clock, clockwise, in turns), shrunk toward its middle so neighbours overlap less. */
export function wedgeBox(pie: Box, a0: number, a1: number): Box {
  const [y0, x0, y1, x1] = pie;
  const cy = (y0 + y1) / 2, cx = (x0 + x1) / 2, ry = (y1 - y0) / 2, rx = (x1 - x0) / 2;
  const at = (t: number, r: number) => [cy - ry * r * Math.cos(2 * Math.PI * t), cx + rx * r * Math.sin(2 * Math.PI * t)];
  const pts = [[cy, cx]];
  for (let k = 0; k <= 16; k++) pts.push(at(a0 + ((a1 - a0) * k) / 16, 1));
  const [my, mx] = at((a0 + a1) / 2, 0.6);
  const ys = pts.map((p) => my + (p[0] - my) * 0.8);
  const xs = pts.map((p) => mx + (p[1] - mx) * 0.8);
  const b = [Math.min(...ys), Math.min(...xs), Math.max(...ys), Math.max(...xs)].map((v) => Math.min(1000, Math.max(0, Math.round(v))));
  return [b[0], b[1], Math.max(b[2], b[0] + 10), Math.max(b[3], b[1] + 10)];
}

function cleanBars(raw: RawChart, x: Axis, plot: Box): Bars | null {
  const cats = (raw.categories ?? []).map((c) => String(c ?? "").trim());
  if (cats.length < 2 || cats.some((c) => !c)) return null;
  const series = (raw.series ?? [])
    .filter((s) => s.name && Array.isArray(s.values) && s.values.length === cats.length)
    .slice(0, 12)
    .map((s) => ({ name: s.name!.trim(), ...(s.color ? { color: s.color } : {}), values: s.values!.map(num) }));
  if (!series.length || series.every((s) => s.values.every((v) => v === null))) return null;
  const stacked = !!raw.stacked || raw.chart_type === "stacked_bar";
  const approx = cats.map(() => false);
  const sums = cats.map((_, k) => series.reduce((a, s) => a + (s.values[k] ?? 0), 0));
  const totals = cats.map((_, k) => {
    const t = num(raw.totals?.[k]);
    // A segment's value is its height; when the heights do not add up to the stack's top (within 10%), say "roughly".
    if (stacked && t !== null && Math.abs(sums[k] - t) > Math.max(Math.abs(t) * 0.1, 1e-9)) approx[k] = true;
    return sums[k];
  });
  // Positions along the x axis: the printed axis when the categories are numbers on it (years), else equal columns.
  const nums = cats.map((c) => (/^-?\d+(\.\d+)?$/.test(c) ? Number(c) : NaN));
  const onAxis = x.min !== null && x.max !== null && nums.every((v, k) => Number.isFinite(v) && v >= x.min! && v <= x.max! && (!k || v > nums[k - 1]));
  void plot;
  return { categories: cats, series, stacked, totals, approx, pos: onAxis ? nums : cats.map((_, k) => k) };
}

/** Model output to chart data. Series without readable points stay listed by name with no points. */
export function cleanChart(raw: RawChart): CleanChart | null {
  const plot = cleanBox(raw.plot_area);
  if (!plot) return null;
  const x = axis(raw.x_axis);
  const y = axis(raw.y_axis);
  const type = CHART_TYPES.includes(raw.chart_type ?? "") ? raw.chart_type! : "other";
  const bars = !raw.unreadable && ["bar", "stacked_bar", "histogram", "other"].includes(type) ? cleanBars(raw, x, plot) : null;
  if (bars) {
    const xa: Axis = bars.pos[0] === 0 && bars.pos[1] === 1 ? { ...x, min: -0.5, max: bars.categories.length - 0.5 } : x;
    const pts = (vals: (number | null)[]) => vals.flatMap((v, k) => (v === null ? [] : [{ x: bars.pos[k], y: v, label: bars.categories[k] }]));
    const series: Series[] = bars.stacked
      ? [{ name: "Total", points: pts(bars.totals) }, ...bars.series.map((s) => ({ name: s.name, ...(s.color ? { color: s.color } : {}), points: pts(s.values) }))]
      : bars.series.map((s) => ({ name: s.name, ...(s.color ? { color: s.color } : {}), points: pts(s.values) }));
    return { type: bars.stacked ? "stacked_bar" : "bar", x: xa, y, plot, series, legend: cleanBox(raw.legend_area), categories: bars.categories, stacked: bars.stacked, bars };
  }
  const series: Series[] = (raw.series ?? [])
    .filter((s) => s.name)
    .slice(0, 6)
    .map((s) => ({ name: s.name!.trim(), ...(s.color ? { color: s.color } : {}), points: raw.unreadable ? [] : cleanPoints(s.points, x, y) }));
  const out: CleanChart = { type, x, y, plot, series, legend: cleanBox(raw.legend_area) };
  if (type === "pie" && !raw.unreadable) {
    // Slices in clockwise order from 12 o'clock. Printed percentages are kept as printed; estimated ones are rescaled to 100.
    const sl = (raw.series?.[0]?.points ?? [])
      .map((p) => ({ label: (p.label ?? "").trim(), v: num(p.y), printed: !!p.printed, note: (p.note ?? "").trim() }))
      .filter((p) => p.label && p.v !== null && p.v > 0);
    const total = sl.reduce((a, p) => a + p.v!, 0);
    const keep = sl.every((p) => p.printed) && total >= 90 && total <= 110;
    const pie = cleanBox(raw.pie_area) ?? plot;
    let at = 0;
    out.slices = sl.length >= 2
      ? sl.map((p) => {
          const share = p.v! / total;
          const box = wedgeBox(pie, at, at + share);
          at += share;
          return { label: p.label, value: keep ? p.v! : share * 100, printed: keep, note: p.note, box };
        })
      : [];
    out.series = out.slices.length ? [{ name: "Slices", points: out.slices.map((p, k) => ({ x: k, y: p.value, label: p.label })) }] : [];
  }
  if (type === "box" && !raw.unreadable) {
    out.boxes = (raw.boxes ?? []).flatMap((b) => {
      const v = [b.min, b.q1, b.median, b.q3, b.max].map(num);
      // Five numbers in order, else the group is not kept: a wrong quartile is worse than none.
      if (!b.label || v.some((n) => n === null) || v.some((n, k) => k && n! < v[k - 1]!)) return [];
      const [min, q1, median, q3, max] = v as number[];
      return [{ label: b.label.trim(), min, q1, median, q3, max }];
    });
  }
  if (type === "heatmap" && !raw.unreadable) {
    out.cells = (raw.cells ?? []).flatMap((c) => (c.row && c.col && num(c.value) !== null ? [{ row: c.row.trim(), col: c.col.trim(), value: num(c.value)! }] : []));
  }
  return out;
}

/** True when the cleaned chart carries any values to speak. */
export const hasValues = (c: CleanChart | null) =>
  !!c && (!!c.bars || c.series.some((s) => s.points.length) || !!c.boxes?.length || (c.cells?.length ?? 0) >= 4 || !!c.slices?.length);

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

/** Pitch for a value: the series' min..max maps to 220..880 Hz (two octaves), clamped. On a log axis the pitch follows log(value). */
export function pitch(y: number, min: number, max: number, log = false): number {
  const l = log && min > 0 && y > 0;
  const [v, lo, hi] = l ? [Math.log10(y), Math.log10(min), Math.log10(max)] : [y, min, max];
  const t = hi > lo ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : 0.5;
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

/** Rounds to a step that suits the range: range 100 rounds to whole numbers, range 1 to hundredths. For x positions (years). */
export function round(v: number, range: number): string {
  const step = range > 0 ? Math.pow(10, Math.floor(Math.log10(range / 20))) : 1;
  const r = Math.round(v / step) * step;
  const digits = Math.max(0, -Math.floor(Math.log10(step)));
  return (Object.is(r, -0) ? 0 : r).toFixed(digits).replace(/^-/, "minus ");
}

const SCALES: [number, string][] = [[1e12, "trillion"], [1e9, "billion"], [1e6, "million"], [1e3, "thousand"]];
/** A value as a person says it: 2 to 3 significant figures of the value itself (coarser only as far as a linear range allows),
 * never 0 for a non-zero value, large values in words: 316574 -> "317 thousand", 13699 -> "13.7 thousand", 1e8 -> "100 million". */
export function spoken(v: number, range: number | null = null): string {
  if (!Number.isFinite(v)) return "unknown";
  if (v === 0) return "0";
  const mag = Math.floor(Math.log10(Math.abs(v)));
  let step = Math.abs(v) < 1 ? Math.pow(10, mag - 1) : Math.pow(10, mag - 2);
  if (range && range > 0) step = Math.min(Math.pow(10, mag - 1), Math.max(step, Math.pow(10, Math.floor(Math.log10(range / 20)))));
  else if (Number.isInteger(v) && Math.abs(v) < 1000) step = 1;
  const digits = Math.max(0, -Math.floor(Math.log10(step)));
  const r = Number((Math.round(v / step) * step).toFixed(digits));
  const sign = r < 0 ? "minus " : "";
  const a = Math.abs(r);
  const sc = a >= 1e4 ? SCALES.find(([s]) => a >= s) : undefined;
  if (sc) return `${sign}${Number((a / sc[0]).toPrecision(3))} ${sc[1]}`;
  return `${sign}${Number(a.toFixed(digits))}`;
}

/** Spoken unit and multiplier of an axis: "billion US $" -> values times 1e9, said as dollars. */
function unitOf(a: Axis): { mult: number; word: string } {
  const u = a.unit ?? (/^deg/i.test(a.label) ? "degrees" : "");
  const mult = /\bbillions?\b|\bbn\b/i.test(u) ? 1e9 : /\bmillions?\b/i.test(u) ? 1e6 : /\bthousands?\b/i.test(u) ? 1e3 : 1;
  const word = /\$|usd|dollar/i.test(u) ? "dollars" : /%|percent/i.test(u) ? "percent" : u === "°" || /^deg/i.test(u) ? "degrees" : /^°c$/i.test(u) ? "degrees Celsius" : u.replace(/\b(billions?|millions?|thousands?|bn)\b/gi, "").trim();
  return { mult, word };
}
const unitWord = (a: Axis) => (unitOf(a).word ? ` ${unitOf(a).word}` : "");

/** The axis title as a spoken noun: "sample point #" becomes "sample point". */
const noun = (a: Axis, fallback: string) => a.label.replace(/\(.*?\)|[#[\]]/g, "").replace(/\s+/g, " ").trim().toLowerCase() || fallback;

/** Value range of an axis: printed limits when present, else the data. */
function span(c: Chart, which: "x" | "y"): [number, number] {
  const a = c[which];
  const all = c.series.flatMap((s) => s.points.map((p) => p[which]));
  const lo = a.min ?? (all.length ? Math.min(...all) : 0);
  const hi = a.max ?? (all.length ? Math.max(...all) : 1);
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}

/** A y value of chart c as spoken: units multiplied in, rounding by the value on a log axis, by the range on a linear one. */
const yv = (c: Chart, v: number, fine = 1) => {
  const { mult } = unitOf(c.y);
  const [lo, hi] = span(c, "y");
  return spoken(v * mult, isLog(c.y) ? null : ((hi - lo) * mult) / fine);
};

/** Pointer position (0 to 1000 across the figure) to the x value under it, or null outside the plot area. */
export function xAtPointer(c: Chart, px: number, py: number): number | null {
  const [y0, x0, y1, x1] = c.plot;
  if (px < x0 || px > x1 || py < y0 || py > y1) return null;
  const [lo, hi] = span(c, "x");
  return unfrac(c.x, (px - x0) / (x1 - x0), lo, hi);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const xLabel = (c: Chart, x: number, s?: Series) => {
  const p = (s ?? c.series[0])?.points.find((q) => q.x === x && q.label);
  return p?.label ?? round(x, span(c, "x")[1] - span(c, "x")[0]);
};
/** "about 45", or "45" when the value is printed on the chart. */
const about = (p: { printed?: boolean }, s: string) => (p.printed ? s : `about ${s}`);

/** "At sample point 120: left thigh angle about 45 degrees, right thigh angle about 38." Active series first. Bars snap to the nearest category. */
export function reading(c: Chart, x: number, active = 0): string {
  if (c.categories && c.series[0]?.points.length) x = c.series[0].points.reduce((b, p) => (Math.abs(p.x - x) < Math.abs(b.x - x) ? p : b)).x;
  const order = [active, ...c.series.map((_, k) => k).filter((k) => k !== active)];
  const parts = order
    .map((k) => c.series[k])
    .filter((s) => s && s.points.length && x >= s.points[0].x && x <= s.points[s.points.length - 1].x)
    .filter((s) => !c.categories || s.points.some((p) => p.x === x))
    .map((s, j) => `${s.name.toLowerCase()} about ${yv(c, valueAt(s.points, x))}${j === 0 ? unitWord(c.y) : ""}`);
  const where = `At ${noun(c.x, "x")} ${xLabel(c, x)}`;
  return parts.length ? `${where}: ${parts.slice(0, 7).join(", ")}.` : `${where}: no values here.`;
}

/** One point of one series, for Shift+Arrow stepping: "Sample point 30: about 80 degrees, the highest point." */
export function pointLine(c: Chart, si: number, k: number): string {
  const s = c.series[si];
  const p = s.points[k];
  const st = stats(s.points);
  const tag = p === st.max ? ", the highest point" : p === st.min ? ", the lowest point" : "";
  const end = k === 0 ? " First value." : k === s.points.length - 1 ? " Last value." : "";
  // A stacked chart's Total: the breakdown of that bar, largest first (the stop itself only gives the total and the largest part).
  const parts = c.stacked && si === 0 ? c.series.slice(1).flatMap((o) => o.points.filter((q) => q.x === p.x).map((q) => ({ n: o.name, y: q.y }))).sort((a, b) => b.y - a.y) : [];
  const more = parts.length ? ` ${parts.slice(0, 5).map((q) => `${q.n} ${yv(c, q.y)}`).join(", ")}.` : "";
  return `${cap(noun(c.x, "x"))} ${xLabel(c, p.x, s)}: ${about(p, yv(c, p.y))}${unitWord(c.y)}${tag}.${more}${end}`;
}

/** Index into chart.series for the stop the student is on; 0 when the stop is not a series stop. */
export const seriesOfStop = (c: Chart, stop?: TourStop) => Math.max(0, c.series.findIndex((s) => s.name === stop?.label));

const times = (r: number) => (r >= 10 ? Math.round(r) : Number(r.toPrecision(2)));
function seriesSays(c: Chart, s: Series): string {
  if (!s.points.length) return "Its values could not be read.";
  const st = stats(s.points);
  const [ylo, yhi] = span(c, "y");
  const xr = span(c, "x")[1] - span(c, "x")[0];
  const u = unitWord(c.y);
  const v = (y: number) => yv(c, y);
  const at = (p: Pt) => `${noun(c.x, "x")} ${p.label ?? round(p.x, xr)}`;
  const rel = (a: number, b: number) => (isLog(c.y) && a > 0 && b > 0 ? Math.log10(b / a) / Math.log10(yhi / ylo) : (b - a) / (yhi - ylo));
  let first: string;
  if (isLog(c.y) && st.start.y > 0 && st.end.y / st.start.y >= 1.5) first = `Grows about ${times(st.end.y / st.start.y)} times, from ${v(st.start.y)} to ${v(st.end.y)}${u}.`;
  else if (isLog(c.y) && st.start.y > 0 && st.start.y / st.end.y >= 1.5) first = `Shrinks about ${times(st.start.y / st.end.y)} times, from ${v(st.start.y)} to ${v(st.end.y)}${u}.`;
  else if (st.peaks >= 2) first = `Starts about ${v(st.start.y)}${u}, peaks about ${v(st.max.y)}, ${st.peaks} times.`;
  else if (st.peaks === 1) first = `Starts about ${v(st.start.y)}${u}, peaks about ${v(st.max.y)} at ${at(st.max)}.`;
  else if (rel(st.start.y, st.end.y) > 0.1) first = `Rises from about ${v(st.start.y)} to ${v(st.end.y)}${u}.`;
  else if (rel(st.start.y, st.end.y) < -0.1) first = `Falls from about ${v(st.start.y)} to ${v(st.end.y)}${u}.`;
  else first = `Stays near ${v(st.start.y)}${u}.`;
  const second = `Highest about ${v(st.max.y)} at ${at(st.max)}; lowest about ${v(st.min.y)} at ${at(st.min)}.`;
  return `${first} ${second}`;
}

const sameX = (a: Series, b: Series) => a.points.length === b.points.length && a.points.every((p, k) => p.x === b.points[k].x);
/** Which series is higher on average and how often they cross: one sentence. Two series only (the first two). */
export function compare(c: Chart): string {
  const [a, b] = c.series.filter((s) => s.points.length);
  if (!a || !b) return "";
  const lo = Math.max(a.points[0].x, b.points[0].x);
  const hi = Math.min(a.points[a.points.length - 1].x, b.points[b.points.length - 1].x);
  if (hi <= lo) return `${cap(a.name)} and ${b.name} cover different stretches.`;
  const log = isLog(c.y);
  const f = (v: number) => (log && v > 0 ? Math.log10(v) : v);
  const [ylo, yhi] = span(c, "y");
  const yr = f(yhi) - f(ylo);
  const n = 200;
  let sum = 0;
  let crosses = 0;
  let sign = 0;
  for (let k = 0; k <= n; k++) {
    const x = lo + ((hi - lo) * k) / n;
    const d = f(valueAt(a.points, x)) - f(valueAt(b.points, x));
    sum += d;
    if (Math.abs(d) > yr * 0.02) {
      const sg = Math.sign(d);
      if (sign && sg !== sign) crosses++;
      sign = sg;
    }
  }
  const mean = sum / (n + 1);
  const [up, down] = mean >= 0 ? [a, b] : [b, a];
  // A crossing count from points at different x positions is an artefact of sampling: say it only when both share x.
  const cross = !crosses ? "never crossing" : sameX(a, b) ? `crossing ${crosses === 1 ? "once" : `${crosses} times`}` : crosses === 1 ? "crossing once" : "crossing several times";
  if (Math.abs(mean) < yr * 0.02) return `${cap(a.name)} and ${b.name.toLowerCase()} are about equal, ${cross}.`;
  const by = log ? `about ${times(Math.pow(10, Math.abs(mean)))} times as high` : `by about ${yv(c, Math.abs(mean))}${unitWord(c.y)}`;
  return `${cap(up.name)} is above ${down.name.toLowerCase()} ${by}, ${cross}.`;
}

type Info = { title: string; takeaway: string; notable: string[]; unreadable: string | null; confidence: string; quickSays?: string };
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
/** Said when the values were not read and no second check agreed that none are printed. Never "no scale is printed". */
export const COULD_NOT_READ = "I could not read the exact values of this chart. Here is what it shows.";

/** Pearson r, the least-squares slope, and the points far off the fitted line (residual over 2.5 standard deviations). */
export function relation(points: Pt[]) {
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const p of points) {
    sxy += (p.x - mx) * (p.y - my);
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
  }
  const r = sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
  const slope = sxx ? sxy / sxx : 0;
  const res = points.map((p) => p.y - (my + slope * (p.x - mx)));
  const sd = Math.sqrt(res.reduce((a, e) => a + e * e, 0) / n);
  return { r, slope, outliers: sd ? points.filter((_, k) => Math.abs(res[k]) > 2.5 * sd) : [] };
}

function scatterSays(c: Chart, s: Series): string {
  const { r, slope, outliers } = relation(s.points);
  const a = Math.abs(r);
  const fit = a >= 0.7 ? "closely" : a >= 0.4 ? "loosely" : "only weakly";
  const yn = noun(c.y, "y");
  const xn = noun(c.x, "x");
  const xr = span(c, "x")[1] - span(c, "x")[0];
  const first = a < 0.2 ? "No clear trend: the points do not follow a line." : `${r > 0 ? "Rises" : "Falls"}: about ${spoken(Math.abs(slope))} ${yn} per ${xn}, following the line ${fit}.`;
  const out = outliers.length ? ` ${outliers.length === 1 ? "One point stands apart" : "A few points stand apart"}, at ${xn} ${list(outliers.slice(0, 2).map((p) => p.label ?? round(p.x, xr)))}.` : "";
  return `${first}${out}`;
}

/** Bars ranked: "Highest: 2001, about 1,200; lowest: 1971, about 900." The bar-by-bar list is left to Shift+Arrow. */
function barRank(c: Chart, s: Series): string {
  const r = [...s.points].sort((a, b) => b.y - a.y);
  const name = (p: Pt) => p.label ?? round(p.x, 1);
  return `Highest: ${name(r[0])}, ${about(r[0], yv(c, r[0].y, 10))}${unitWord(c.y)}. Lowest: ${name(r[r.length - 1])}, ${about(r[r.length - 1], yv(c, r[r.length - 1].y, 10))}.`;
}

const WORDS = 15;
/** One sentence cut to 15 words: at the last clause boundary before the limit, else at the 15th word. */
function shorten(s: string): string {
  const w = s.trim().split(/\s+/);
  if (w.length <= WORDS) return s.trim();
  const head = w.slice(0, WORDS).join(" ");
  const cut = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "), head.lastIndexOf(": "), head.lastIndexOf(" and "), head.lastIndexOf(" which "));
  const out = cut > head.length / 3 ? head.slice(0, cut) : head;
  // Never end on a dangling little word ("rose steadily to a.").
  return `${out.replace(/[\s,;:]+$/, "").replace(/(\s+(a|an|the|to|of|over|in|at|on|and|or|with|for|by|from|as|its|their))+$/i, "")}.`;
}
/** At most two sentences of at most 15 words each (the owner, listening: "two sentences max ... short, straight to point"). */
export function brief(t: string): string {
  const sentences = t.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+(?=[A-Z0-9"(])/).filter(Boolean);
  return sentences.slice(0, 2).map(shorten).join(" ");
}
export const briefTour = (t: Tour): Tour => ({ ...t, overview: brief(t.overview), stops: t.stops.map((s) => ({ ...s, says: brief(s.says) })) });

/** Direction words in a model's takeaway that the data contradicts: the takeaway is then replaced by a code-built one. */
function checkTakeaway(takeaway: string, dir: number | null, fallback: string): string {
  if (dir === null || !takeaway) return takeaway || fallback;
  const up = /\b(increas|rises|rising|rose|grow|grew|climb)/i.test(takeaway);
  const down = /\b(decreas|falls|falling|fell|declin|drop)/i.test(takeaway);
  if (up === down) return takeaway;
  return (up && dir < 0) || (down && dir > 0) ? fallback : takeaway;
}

/** Pie, box and heat map: stops only, largest or most important first; no chart data, so the client offers no scrub. */
function stopsTour(c: CleanChart, info: Info, source: string): Tour | null {
  const stops: Omit<TourStop, "n">[] = [];
  const add = (label: string, says: string, box: Box = c.plot, confidence = info.confidence === "low" ? "low" : "medium") => stops.push({ label, says, box_2d: box, confidence });
  let what = "";
  let takeaway = info.takeaway;
  const pct = (p: Slice) => (p.printed ? `${Number(p.value.toFixed(1))} percent` : `about ${Math.round(p.value)} percent`);
  if (c.type === "pie") {
    const sl = [...(c.slices ?? [])].sort((a, b) => b.value - a.value);
    if (!sl.length) return null;
    what = `A pie chart with ${sl.length} slices`;
    add("Main finding", takeaway || info.title, [0, 0, 1000, 1000], "high");
    add("Slices", `Largest: ${list(sl.slice(0, 2).map((p) => `${p.label}, ${pct(p)}`))}.`);
    sl.forEach((p, k) => add(p.label, `${cap(pct(p))}${k === 0 ? ", the largest slice" : k === sl.length - 1 ? ", the smallest slice" : ""}.${p.note ? ` Also printed: ${p.note.replace(/\.+$/, "")}.` : ""}`, p.box, p.printed ? "high" : "medium"));
  } else if (c.type === "box") {
    const inOrder = c.boxes ?? [];
    const bx = [...inOrder].sort((a, b) => b.median - a.median);
    if (!bx.length) return null;
    const lo = Math.min(...bx.map((b) => b.min));
    const yr = Math.max(...bx.map((b) => b.max)) - lo;
    const v = (n: number) => spoken(n, yr || 1);
    const u = unitWord(c.y);
    what = `A box plot of ${bx.length} groups`;
    const d = inOrder.length >= 2 ? Math.sign(inOrder[inOrder.length - 1].median - inOrder[0].median) : null;
    takeaway = checkTakeaway(takeaway, d, `Highest median: ${bx[0].label}, about ${v(bx[0].median)}${u}.`);
    add("Main finding", takeaway || info.title, [0, 0, 1000, 1000], "high");
    add("Groups", `Highest median: ${bx[0].label}, about ${v(bx[0].median)}${u}. Lowest: ${bx[bx.length - 1].label}, about ${v(bx[bx.length - 1].median)}.`);
    for (const b of bx) add(b.label, `Median about ${v(b.median)}${u}; middle half ${v(b.q1)} to ${v(b.q3)}. Whiskers from ${v(b.min)} to ${v(b.max)}.`);
  } else {
    const cells = c.cells ?? [];
    if (cells.length < 4) return null;
    add("Main finding", takeaway || info.title, [0, 0, 1000, 1000], "high");
    const rows = [...new Set(cells.map((x) => x.row))];
    const cols = [...new Set(cells.map((x) => x.col))];
    const vals = cells.map((x) => x.value);
    const vr = Math.max(...vals) - Math.min(...vals) || 1;
    const by = [...cells].sort((a, b) => b.value - a.value);
    const cell = (x: Cell) => `${x.row} with ${x.col}, about ${spoken(x.value, vr)}`;
    what = `A heat map of ${rows.length} rows by ${cols.length} columns`;
    add("Rows and columns", `Rows: ${list(rows.slice(0, 6))}. Columns: ${list(cols.slice(0, 6))}.`);
    const off = cells.filter((x) => x.row !== x.col);
    const top = (off.length ? [...off].sort((a, b) => b.value - a.value) : by)[0];
    add("Highest cell", `Highest: ${cell(top)}.`);
    add("Lowest cell", `Lowest: ${cell(by[by.length - 1])}.`);
    // A diagonal pattern: same labels on both axes and the diagonal clearly above the rest (a confusion matrix, a correlation matrix).
    const diag = cells.filter((x) => x.row === x.col);
    if (diag.length >= 2 && off.length) {
      const m = (xs: Cell[]) => xs.reduce((a, x) => a + x.value, 0) / xs.length;
      const d = m(diag) - m(off);
      if (Math.abs(d) > vr * 0.25) add("Pattern", `Values are ${d > 0 ? "highest" : "lowest"} along the diagonal, about ${spoken(m(diag), vr)}. Elsewhere about ${spoken(m(off), vr)}.`);
    }
    for (const r of rows.slice(0, 8)) {
      const rc = cells.filter((x) => x.row === r && x.col !== r).sort((a, b) => b.value - a.value);
      if (rc.length >= 2) add(r, `Highest with ${rc[0].col}, about ${spoken(rc[0].value, vr)}. Lowest with ${rc[rc.length - 1].col}, about ${spoken(rc[rc.length - 1].value, vr)}.`);
    }
  }
  const notes = info.notable.map((t) => t.trim()).filter(Boolean).slice(0, 2);
  if (notes.length) add("Also notable", notes.join(" "));
  return briefTour({ title: info.title, overview: `${info.title}. ${what}.`, source, stops: stops.map((s, k) => ({ n: k + 1, ...s })) });
}

/** Overlapping series boxes (over 60% of the smaller one): each series gets the stretch where it is farthest from the others. */
function distinctBoxes(c: Chart, rs: Series[], boxes: Box[], toY: (v: number) => number): Box[] {
  const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const inter = (a: Box, b: Box): Box => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  const overlaps = (i: number) => boxes.some((b, j) => j !== i && area(inter(boxes[i], b)) > 0.6 * Math.min(area(boxes[i]), area(b)));
  const [py0, px0, py1, px1] = c.plot;
  const [xlo, xhi] = span(c, "x");
  const w = Math.max((px1 - px0) / 6, 1);
  return boxes.map((b, i) => {
    if (!overlaps(i) || rs.length < 2) return b;
    const s = rs[i];
    // The highest series on average takes the stretch where it is farthest above the rest, the lowest where it is farthest
    // below, the others where their nearest neighbour is farthest: two similar series then get different stretches.
    const mean = (o: Series) => o.points.reduce((t, p) => t + toY(p.y), 0) / o.points.length;
    const rank = [...rs].sort((a, b) => mean(a) - mean(b)).indexOf(s);
    let best = -Infinity, bx = s.points[0].x;
    for (let k = 0; k <= 60; k++) {
      const x = s.points[0].x + ((s.points[s.points.length - 1].x - s.points[0].x) * k) / 60;
      const d = rs.filter((_, j) => j !== i).map((o) => toY(valueAt(o.points, x)) - toY(valueAt(s.points, x)));
      const gap = rank === 0 ? Math.min(...d) : rank === rs.length - 1 ? -Math.max(...d) : Math.min(...d.map(Math.abs));
      if (gap > best) [best, bx] = [gap, x];
    }
    const cx = px0 + frac(c.x, bx, xlo, xhi) * (px1 - px0);
    const l = Math.max(px0, Math.min(px1 - w, cx - w / 2));
    const ys = s.points.filter((p) => { const X = px0 + frac(c.x, p.x, xlo, xhi) * (px1 - px0); return X >= l && X <= l + w; }).map((p) => toY(p.y));
    ys.push(toY(valueAt(s.points, bx)));
    return [Math.max(py0, Math.min(...ys) - 20), Math.round(l), Math.min(py1, Math.max(...ys) + 20), Math.round(l + w)];
  });
}

/** Bar charts read per category (stacked or grouped): one stop per category, then the comparison. */
function barsTour(c: CleanChart, info: Info, source: string): Tour {
  const b = c.bars!;
  const [py0, px0, py1, px1] = c.plot;
  const [xlo, xhi] = span(c, "x");
  const stops: Omit<TourStop, "n">[] = [];
  const add = (label: string, says: string, box: Box, confidence = info.confidence === "low" ? "low" : "high") => stops.push({ label, says, box_2d: box, confidence });
  const u = unitWord(c.y);
  const n = b.categories.length;
  const timed = b.pos.every((p, k) => !k || p > b.pos[k - 1]) && b.pos[0] !== 0;
  const dir = timed ? Math.sign(b.totals[n - 1] - b.totals[0]) : null;
  const hiK = b.totals.indexOf(Math.max(...b.totals));
  const loK = b.totals.indexOf(Math.min(...b.totals));
  const fallback = `Highest total in ${b.categories[hiK]}, about ${yv(c, b.totals[hiK])}${u}.`;
  add("Main finding", b.stacked ? checkTakeaway(info.takeaway, dir, fallback) : info.takeaway || info.title, [0, 0, 1000, 1000]);
  add("Horizontal axis", `${cap(noun(c.x, "categories"))}: ${b.categories[0]} to ${b.categories[n - 1]}.`, [py1, px0, Math.min(1000, py1 + 110), px1]);
  add("Vertical axis", `${cap(noun(c.y, "value"))}: ${axisRange(c, "y")}.`, [py0, Math.max(0, px0 - 110), py1, px0]);
  add("Legend", `${b.stacked ? "Stacked from the bottom" : "Side by side"}: ${list(b.series.map((s) => s.name))}.`, c.legend ?? c.plot);
  // One column of the plot per category, at its place on the axis, so the pointer lands on each bar in turn.
  const at = (p: number) => px0 + frac(c.x, p, xlo, xhi) * (px1 - px0);
  const half = Math.max(4, (n > 1 ? Math.min(...b.pos.slice(1).map((p, k) => at(p) - at(b.pos[k]))) : px1 - px0) / 2);
  b.categories.forEach((cat, k) => {
    const parts = b.series.flatMap((s) => (s.values[k] === null ? [] : [{ n: s.name, v: s.values[k]! }])).sort((a2, b2) => b2.v - a2.v);
    const w = b.approx[k] ? "roughly" : "about";
    const says = b.stacked
      ? `Total ${w} ${yv(c, b.totals[k])}${u}. Largest: ${parts[0]?.n}, ${w} ${yv(c, parts[0]?.v ?? 0)}.`
      : `Highest: ${parts[0]?.n}, ${w} ${yv(c, parts[0]?.v ?? 0)}${u}.${parts.length > 1 ? ` Lowest: ${parts[parts.length - 1].n}, ${w} ${yv(c, parts[parts.length - 1].v)}.` : ""}`;
    add(cat, says, [py0, Math.max(0, Math.round(at(b.pos[k]) - half)), py1, Math.min(1000, Math.round(at(b.pos[k]) + half))], b.approx[k] ? "medium" : undefined);
  });
  if (b.stacked) {
    const sums = b.series.map((s) => ({ n: s.name, v: s.values.reduce<number>((a, v) => a + (v ?? 0), 0) })).sort((a, z) => z.v - a.v);
    const trend = timed ? ` From ${b.categories[0]} to ${b.categories[n - 1]}, the total ${dir! > 0 ? "rose" : dir! < 0 ? "fell" : "held"}.` : "";
    add("Comparison", `Highest total ${b.categories[hiK]}, lowest ${b.categories[loK]}. Biggest contributor overall: ${sums[0].n}.${trend}`, c.plot);
  }
  const { legend: _l, bars: _b, ...chart } = c;
  void _l;
  void _b;
  return briefTour({ title: info.title, overview: `${info.title}. A ${b.stacked ? "stacked" : "grouped"} bar chart of ${n} categories.`, source, stops: stops.map((s, k) => ({ n: k + 1, ...s })), chart });
}

/** "about 100 dollars to about 100 million": from the printed ticks when given, else the frame limits or the data. */
function axisRange(c: Chart, which: "x" | "y"): string {
  const a = c[which];
  const [lo, hi] = a.ticks ?? span(c, which);
  if (which === "x") return `${round(lo, hi - lo)} to ${round(hi, hi - lo)}`;
  return `${yv(c, lo)} to ${yv(c, hi)}${unitWord(a)}${isLog(a) ? ", on a log scale" : ""}`;
}

/** The whole chart tour, built in code so its sentences and boxes agree. `info.unreadable` is set only when a second check
 * agreed that no numbers are printed; otherwise a chart without values gets COULD_NOT_READ and the quick description. */
export function chartTour(c: CleanChart, info: Info, source: string): Tour {
  if (c.bars) return barsTour(c, info, source);
  const nothing = (): Omit<TourStop, "n"> => ({
    label: "Values",
    says: info.unreadable
      ? `No numbers are printed on this chart: only the shapes can be compared.`
      : info.quickSays ? `${COULD_NOT_READ.replace(/\.$/, ":")} ${info.quickSays.charAt(0).toLowerCase()}${info.quickSays.slice(1)}` : COULD_NOT_READ,
    box_2d: c.plot,
    confidence: "low",
  });
  if (["pie", "box", "heatmap"].includes(c.type)) {
    const t = info.unreadable ? null : stopsTour(c, info, source);
    if (t) return t;
    return {
      title: info.title,
      overview: brief(info.takeaway || info.title),
      source,
      stops: [{ n: 1, label: "Main finding", says: brief(info.takeaway || info.title), box_2d: [0, 0, 1000, 1000], confidence: "medium" }, { n: 2, ...nothing() }],
    };
  }
  const { legend, boxes: _b, cells: _c, slices: _s, bars: _r, ...chart } = c;
  void _b;
  void _c;
  void _s;
  void _r;
  const readable = chart.series.filter((s) => s.points.length);
  const [py0, px0, py1, px1] = chart.plot;
  const stops: Omit<TourStop, "n">[] = [];
  const add = (label: string, says: string, box: Box, confidence = "high") => stops.push({ label, says, box_2d: box, confidence });
  const one = readable.length === 1 && !["scatter"].includes(chart.type) ? readable[0] : null;
  const dir = one ? Math.sign(one.points[one.points.length - 1].y - one.points[0].y) : null;
  add("Main finding", checkTakeaway(info.takeaway, dir, one ? seriesSays(chart, one) : info.title) || info.title, [0, 0, 1000, 1000]);

  const range = (which: "x" | "y") => (chart[which].min === null && chart[which].max === null && !readable.length ? "no numbers printed" : axisRange(chart, which));
  if (chart.x.label || chart.x.min !== null) add("Horizontal axis", `${cap(noun(chart.x, "not labelled"))}: ${range("x")}.`, [py1, px0, Math.min(1000, py1 + 110), px1]);
  if (chart.y.label || chart.y.min !== null) add("Vertical axis", `${cap(noun(chart.y, "not labelled"))}: ${range("y")}.`, [py0, Math.max(0, px0 - 110), py1, px0]);
  if (chart.series.length > 1 || legend) {
    const names = chart.series.map((s) => s.name);
    add("Legend", `${chart.series.length === 1 ? "One series" : `${chart.series.length} series`}: ${list(names)}.`, legend ?? chart.plot);
  }
  if (!readable.length) stops.push(nothing());

  // Each series gets the band of the plot its values occupy (log-mapped on a log axis), so series at different heights get different boxes.
  const [ylo, yhi] = span(chart, "y");
  const toY = (v: number) => Math.round(py1 - frac(chart.y, v, ylo, yhi) * (py1 - py0));
  let boxes: Box[] = readable.map((s) => {
    const st = stats(s.points);
    const b: Box = [Math.max(py0, toY(st.max.y) - 15), px0, Math.min(py1, toY(st.min.y) + 15), px1];
    return b[0] < b[2] ? b : chart.plot;
  });
  if (chart.type === "line") boxes = distinctBoxes(chart, readable, boxes, toY);
  readable.forEach((s, k) => {
    const says = chart.type === "scatter" ? scatterSays(chart, s) : ["bar", "stacked_bar", "histogram"].includes(chart.type) ? barRank(chart, s) : seriesSays(chart, s);
    add(s.name, says, boxes[k], info.confidence === "low" ? "low" : "high");
  });
  const cmp = chart.type === "scatter" ? "" : compare(chart);
  if (cmp) add("Comparison", cmp, chart.plot);
  const notes = info.notable.map((t) => t.trim()).filter(Boolean).slice(0, 2);
  if (notes.length) add("Also notable", notes.join(" "), chart.plot, "medium");

  const kind = chart.type === "other" ? "chart" : `${chart.type.replace("_", " ")} chart`;
  const overview = `${info.title}. A ${kind}${chart.series.length > 1 ? ` with ${chart.series.length} series` : ""}.`;
  return briefTour({
    title: info.title,
    overview,
    source,
    stops: stops.map((s, k) => ({ n: k + 1, ...s })),
    ...(readable.length ? { chart: { ...chart, series: readable } } : {}),
  });
}
