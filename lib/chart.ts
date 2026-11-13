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
  /** Box plots: one per group. */
  boxes?: { label?: string; min?: unknown; q1?: unknown; median?: unknown; q3?: unknown; max?: unknown }[];
  /** Heat maps and matrices: one per readable cell. */
  cells?: { row?: string; col?: string; value?: unknown }[];
}

/** Kinds read from the picture. Pie, box and heat map get stops only (no pitch scrub): their x axis is not a line to follow. */
export const CHART_TYPES = ["line", "bar", "stacked_bar", "histogram", "scatter", "pie", "box", "heatmap"];
type BoxStat = { label: string; min: number; q1: number; median: number; q3: number; max: number };
type Cell = { row: string; col: string; value: number };
export type CleanChart = Chart & { legend: Box | null; boxes?: BoxStat[]; cells?: Cell[] };

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
export function cleanChart(raw: RawChart): CleanChart | null {
  const plot = cleanBox(raw.plot_area);
  if (!plot) return null;
  const x = axis(raw.x_axis);
  const y = axis(raw.y_axis);
  const series: Series[] = (raw.series ?? [])
    .filter((s) => s.name)
    .slice(0, 6)
    .map((s) => ({ name: s.name!.trim(), ...(s.color ? { color: s.color } : {}), points: raw.unreadable ? [] : cleanPoints(s.points, x, y) }));
  const type = CHART_TYPES.includes(raw.chart_type ?? "") ? raw.chart_type! : "other";
  const out: CleanChart = { type, x, y, plot, series, legend: cleanBox(raw.legend_area) };
  if (type === "pie" && !raw.unreadable) {
    // Slices: label and value (percent or raw), positive only; shares are recomputed in code so they sum to 100.
    const sl = (raw.series?.[0]?.points ?? []).map((p) => ({ label: (p.label ?? "").trim(), v: num(p.y) })).filter((p) => p.label && p.v !== null && p.v > 0);
    const total = sl.reduce((a, p) => a + p.v!, 0);
    out.series = sl.length >= 2 ? [{ name: "Slices", points: sl.map((p, k) => ({ x: k, y: (p.v! / total) * 100, label: p.label })) }] : [];
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

type Info = { title: string; takeaway: string; notable: string[]; unreadable: string | null; confidence: string };
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const STEP = "There is no curve to follow by pointer here: step through the stops with the arrow keys, largest first.";

/** Pearson r and the points far off the fitted line (residual over 2.5 standard deviations). */
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
  return { r, outliers: sd ? points.filter((_, k) => Math.abs(res[k]) > 2.5 * sd) : [] };
}

function scatterSays(c: Chart, s: Series): string {
  const { r, outliers } = relation(s.points);
  const a = Math.abs(r);
  const strength = a >= 0.7 ? "a strong" : a >= 0.4 ? "a moderate" : a >= 0.2 ? "a weak" : "almost no";
  const dir = a < 0.2 ? "" : r > 0 ? ": as one goes up, so does the other" : ": as one goes up, the other goes down";
  const xr = span(c, "x")[1] - span(c, "x")[0];
  const yr = span(c, "y")[1] - span(c, "y")[0];
  const out = outliers.length
    ? ` ${outliers.length === 1 ? "One point stands apart" : `${outliers.length} points stand apart`}: ${list(outliers.slice(0, 3).map((p) => `${p.label ?? `${noun(c.x, "x")} ${round(p.x, xr)}`} at about ${round(p.y, yr)}`))}.`
    : "";
  return `${s.points.length} points read, with ${strength} relationship${dir} (correlation about ${r.toFixed(1).replace(/^-/, "minus ")}).${out}`;
}

/** Bars ranked: "Highest: 2001 about 1,200; lowest: 1971 about 900." */
function barRank(c: Chart, s: Series): string {
  const yr = (span(c, "y")[1] - span(c, "y")[0]) / 10; // bars are often labelled: one step finer than curves
  const r = [...s.points].sort((a, b) => b.y - a.y);
  const name = (p: Pt) => p.label ?? round(p.x, 1);
  return `${s.points.length} bars. Highest: ${name(r[0])}, about ${round(r[0].y, yr)}${unitWord(c.y)}; lowest: ${name(r[r.length - 1])}, about ${round(r[r.length - 1].y, yr)}. From the left: ${s.points.map((p) => `${name(p)} ${round(p.y, yr)}`).join(", ")}.`;
}

/** Pie, box and heat map: stops only, largest or most important first; no chart data, so the client offers no scrub. */
function stopsTour(c: CleanChart, info: Info, source: string): Tour | null {
  const stops: Omit<TourStop, "n">[] = [];
  const add = (label: string, says: string, confidence = info.confidence === "low" ? "low" : "medium") => stops.push({ label, says, box_2d: c.plot, confidence });
  add("Main finding", info.takeaway || info.title, "high");
  let what = "";
  if (c.type === "pie") {
    const sl = [...(c.series[0]?.points ?? [])].sort((a, b) => b.y - a.y);
    if (!sl.length) return null;
    what = `A pie chart with ${sl.length} slices`;
    add("Slices", `${sl.length} slices, largest first: ${list(sl.map((p) => `${p.label} about ${Math.round(p.y)} percent`))}.`);
    sl.forEach((p, k) => add(p.label!, `About ${Math.round(p.y)} percent${k === 0 ? ", the largest slice" : k === sl.length - 1 ? ", the smallest slice" : ""}.`));
  } else if (c.type === "box") {
    const bx = [...(c.boxes ?? [])].sort((a, b) => b.median - a.median);
    if (!bx.length) return null;
    const lo = Math.min(...bx.map((b) => b.min));
    const yr = Math.max(...bx.map((b) => b.max)) - lo;
    const v = (n: number) => round(n, yr || 1);
    const u = unitWord(c.y);
    what = `A box plot of ${bx.length} groups`;
    add("Groups", `${bx.length} groups, highest median first: ${list(bx.map((b) => `${b.label} ${v(b.median)}`))}${u}.`);
    for (const b of bx) add(b.label, `Median about ${v(b.median)}${u}. The middle half runs from about ${v(b.q1)} to about ${v(b.q3)}; the whiskers reach from about ${v(b.min)} to about ${v(b.max)}.`);
  } else {
    const cells = c.cells ?? [];
    if (cells.length < 4) return null;
    const rows = [...new Set(cells.map((x) => x.row))];
    const cols = [...new Set(cells.map((x) => x.col))];
    const vals = cells.map((x) => x.value);
    const vr = Math.max(...vals) - Math.min(...vals) || 1;
    const by = [...cells].sort((a, b) => b.value - a.value);
    const cell = (x: Cell) => `${x.row}, ${x.col}: about ${round(x.value, vr)}`;
    what = `A heat map of ${rows.length} rows by ${cols.length} columns`;
    add("Rows and columns", `Rows: ${list(rows.slice(0, 12))}. Columns: ${list(cols.slice(0, 12))}.`);
    add("Highest cells", `Highest: ${by.slice(0, 3).map(cell).join("; ")}.`);
    add("Lowest cells", `Lowest: ${by.slice(-3).reverse().map(cell).join("; ")}.`);
    // A diagonal pattern: same labels on both axes and the diagonal clearly above the rest (a confusion matrix, a correlation matrix).
    const diag = cells.filter((x) => x.row === x.col);
    const off = cells.filter((x) => x.row !== x.col);
    if (diag.length >= 2 && off.length) {
      const m = (xs: Cell[]) => xs.reduce((a, x) => a + x.value, 0) / xs.length;
      const d = m(diag) - m(off);
      if (Math.abs(d) > vr * 0.25) add("Pattern", `Values are ${d > 0 ? "highest" : "lowest"} along the diagonal, where the row and column match: about ${round(m(diag), vr)} on average against ${round(m(off), vr)} elsewhere.`);
    }
    for (const r of rows.slice(0, 8)) {
      const rc = cells.filter((x) => x.row === r).sort((a, b) => b.value - a.value);
      if (rc.length >= 2) add(r, `Highest at ${rc[0].col}, about ${round(rc[0].value, vr)}; lowest at ${rc[rc.length - 1].col}, about ${round(rc[rc.length - 1].value, vr)}.`);
    }
  }
  const notes = info.notable.map((t) => t.trim()).filter(Boolean).slice(0, 3);
  if (notes.length) add("Also notable", notes.join(" "));
  return { title: info.title, overview: `${info.title}. ${what}. ${STEP}`, source, stops: stops.map((s, k) => ({ n: k + 1, ...s })) };
}

/** The whole chart tour, built in code so its sentences and boxes agree. */
export function chartTour(c: CleanChart, info: Info, source: string): Tour {
  if (["pie", "box", "heatmap"].includes(c.type)) {
    const t = info.unreadable ? null : stopsTour(c, info, source);
    if (t) return t;
    // Nothing readable: name what is drawn and say the values cannot be read; invent nothing.
    return {
      title: info.title,
      overview: `${info.title}. ${info.takeaway}`.trim(),
      source,
      stops: [
        { n: 1, label: "Main finding", says: info.takeaway || info.title, box_2d: [0, 0, 1000, 1000], confidence: "medium" },
        { n: 2, label: "Values", says: `The values cannot be read from this picture${info.unreadable ? `: ${info.unreadable.replace(/\.+$/, "")}` : ""}.`, box_2d: c.plot, confidence: "low" },
      ],
    };
  }
  const { legend, boxes: _b, cells: _c, ...chart } = c;
  void _b;
  void _c;
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
    const says = chart.type === "scatter" ? scatterSays(chart, s) : ["bar", "stacked_bar", "histogram"].includes(chart.type) ? barRank(chart, s) : seriesSays(chart, s);
    add(s.name, says, box[0] < box[2] ? box : chart.plot, info.confidence === "low" ? "low" : "high");
  }
  const cmp = chart.type === "scatter" ? "" : compare(chart);
  if (cmp) add("Comparison", cmp, chart.plot);
  const notes = info.notable.map((t) => t.trim()).filter(Boolean).slice(0, 3);
  if (notes.length) add("Also notable", notes.join(" "), chart.plot, "medium");

  const kind = chart.type === "other" ? "chart" : chart.type === "box" ? "box plot" : `${chart.type.replace("_", " ")} chart`;
  const overview = `${info.title}. A ${kind}${chart.series.length ? ` with ${chart.series.length} series` : ""}.`;
  return {
    title: info.title,
    overview,
    source,
    stops: stops.map((s, k) => ({ n: k + 1, ...s })),
    ...(readable.length ? { chart: { ...chart, series: readable } } : {}),
  };
}
