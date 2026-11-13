// Offline: the code-built chart tour, the scrub's interpolation and the pitch mapping.
import assert from "node:assert";
import { brief, chartTour, cleanChart, COULD_NOT_READ, countPeaks, pitch, pointLine, reading, relation, spoken, valueAt, xAtPointer } from "../../lib/chart";
import type { Tour } from "../../lib/types";

/** The owner's limit: every stop and overview at most two sentences of at most 15 words. */
const short = (t: Tour) => [t.overview, ...t.stops.map((s) => s.says)].forEach((x) => {
  const ss = x.split(/(?<=[.!?])\s+(?=[A-Z0-9"(])/);
  assert.ok(ss.length <= 2 && ss.every((s) => s.split(/\s+/).length <= 15), `too long: ${x}`);
});

export default function check() {
  const wave = (lift: number) => [0, 10, 20, 30, 40, 50, 60, 70, 80].map((x, k) => ({ x, y: (k % 4 === 2 ? 80 : k % 4 === 0 ? 10 : 45) + lift }));
  const c = cleanChart({
    chart_type: "line",
    x_axis: { label: "sample point #", unit: null, min: 0, max: 80 },
    y_axis: { label: "degree", unit: "degree", min: -20, max: 100 },
    plot_area: [100, 100, 800, 900],
    series: [
      { name: "Left thigh", color: "blue", points: wave(0) },
      { name: "Right thigh", color: "green", points: [...wave(5), { x: 500, y: 1 }] }, // x far outside the axis: dropped
    ],
  });
  assert.ok(c);
  assert.equal(c.series[1].points.length, 9);
  const t = chartTour(c, { title: "Squat", takeaway: "Two thighs move together.", notable: ["Ten cycles."], unreadable: null, confidence: "high" }, "x");
  assert.deepEqual(
    t.stops.map((s) => s.label),
    ["Main finding", "Horizontal axis", "Vertical axis", "Legend", "Left thigh", "Right thigh", "Comparison", "Also notable"],
  );
  assert.equal(t.stops[4].says, "Starts about 10 degrees, peaks about 80, 2 times. Highest about 80 at sample point 20; lowest about 10 at sample point 0.");
  assert.equal(t.stops[6].says, "Right thigh is above left thigh by about 5 degrees, never crossing.");
  assert.notDeepEqual(t.stops[4].box_2d, t.stops[5].box_2d); // series at different heights get different boxes
  assert.equal(countPeaks([0, 10, 0, 10, 0, 10, 0]), 3);
  assert.equal(countPeaks([0, 10, 9, 10, 0]), 1); // a 10% dip is not a new peak
  assert.equal(valueAt(c.series[0].points, 5), 27.5);
  assert.equal(valueAt(c.series[0].points, -5), 10);
  assert.equal(reading(t.chart!, 5, 1), "At sample point 5: right thigh about 33 degrees, left thigh about 28.");
  assert.equal(pointLine(t.chart!, 0, 2), "Sample point 20: about 80 degrees, the highest point.");
  assert.equal(pitch(-1, 0, 10), 220);
  assert.equal(pitch(10, 0, 10), 880);
  assert.equal(pitch(5, 0, 10), 440);
  // No axis numbers: the tour says so and carries no chart data to scrub.
  const blind = cleanChart({ plot_area: [0, 0, 1000, 1000], unreadable: "no axes", series: [{ name: "Red", points: wave(0) }] })!;
  const bt = chartTour(blind, { title: "Curves", takeaway: "Two curves.", notable: [], unreadable: "no axes", confidence: "low" }, "x");
  assert.equal(bt.chart, undefined);
  assert.ok(bt.stops.some((s) => s.label === "Values" && s.says.startsWith("No numbers are printed")));

  const info = { title: "T", takeaway: "K.", notable: [], unreadable: null, confidence: "high" };
  const P: [number, number, number, number] = [100, 100, 900, 900];
  // Bar: ranked, labels kept, still scrubbable.
  const bar = chartTour(cleanChart({ chart_type: "bar", x_axis: { label: "Year", min: 0, max: 2 }, y_axis: { label: "People", min: 0, max: 5000 }, plot_area: P, series: [{ name: "Population", points: [{ x: 0, y: 4161, label: "1861" }, { x: 1, y: 4863, label: "1911" }, { x: 2, y: 858, label: "2021" }] }] })!, info, "x");
  assert.ok(bar.chart);
  assert.match(bar.stops.find((s) => s.label === "Population")!.says, /^Highest: 1911, about 4860\. Lowest: 2021, about 860\./);
  // Scatter: direction, strength and the outlier, computed in code.
  const cloud = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((x) => ({ x, y: 2 * x + (x % 2 ? 0.3 : -0.3) }));
  cloud.push({ x: 5.5, y: 40 });
  const rel = relation(cloud);
  assert.equal(rel.outliers.length, 1);
  const sc = chartTour(cleanChart({ chart_type: "scatter", x_axis: { label: "x", min: 0, max: 11 }, y_axis: { label: "y", min: 0, max: 45 }, plot_area: P, series: [{ name: "Cloud", points: cloud }] })!, info, "x");
  assert.match(sc.stops.find((s) => s.label === "Cloud")!.says, /^Rises: about 1\.98 y per x, following the line (closely|loosely)\. One point stands apart/);
  assert.ok(!sc.stops.some((s) => s.label === "Comparison"));
  // Pie: shares recomputed to 100, largest first, no scrub.
  const pie = chartTour(cleanChart({ chart_type: "pie", plot_area: P, series: [{ name: "Slices", points: [{ x: 0, y: 10, label: "B" }, { x: 1, y: 30, label: "A" }, { x: 2, y: 10, label: "C" }] }] })!, info, "x");
  assert.equal(pie.chart, undefined);
  assert.deepEqual(pie.stops.map((s) => s.label), ["Main finding", "Slices", "A", "B", "C"]);
  assert.equal(pie.stops[2].says, "About 60 percent, the largest slice.");
  // Box: groups by median, a group with quartiles out of order is dropped.
  const box = chartTour(cleanChart({ chart_type: "box", y_axis: { label: "score", min: 0, max: 100 }, plot_area: P, series: [], boxes: [
    { label: "Low", min: 10, q1: 20, median: 30, q3: 40, max: 50 },
    { label: "High", min: 40, q1: 55, median: 70, q3: 80, max: 95 },
    { label: "Broken", min: 10, q1: 50, median: 30, q3: 40, max: 60 },
  ] })!, info, "x");
  assert.equal(box.chart, undefined);
  assert.deepEqual(box.stops.map((s) => s.label), ["Main finding", "Groups", "High", "Low"]);
  assert.equal(box.stops[2].says, "Median about 70; middle half 55 to 80. Whiskers from 40 to 95.");
  // Heat map: extremes, diagonal pattern, a stop per row.
  const cells = ["a", "b", "c"].flatMap((r) => ["a", "b", "c"].map((c) => ({ row: r, col: c, value: r === c ? 90 : 5 })));
  const hm = chartTour(cleanChart({ chart_type: "heatmap", plot_area: P, series: [], cells })!, info, "x");
  assert.equal(hm.chart, undefined);
  assert.ok(hm.stops.some((s) => s.label === "Pattern" && s.says.startsWith("Values are highest along the diagonal")));
  assert.equal(hm.stops.filter((s) => ["a", "b", "c"].includes(s.label)).length, 3);
  // Nothing readable on a pie: says so, invents nothing.
  const none = chartTour(cleanChart({ chart_type: "pie", plot_area: P, unreadable: "no labels", series: [{ name: "Slices", points: [] }] })!, { ...info, unreadable: "no labels" }, "x");
  assert.ok(none.stops.some((s) => s.label === "Values" && s.says.startsWith("No numbers are printed")));

  // Every built tour above keeps the owner's limit.
  [t, bt, bar, sc, pie, box, hm, none].forEach(short);
  assert.equal(brief("One two three four five six seven eight nine ten, eleven twelve thirteen fourteen fifteen sixteen. Second. Third."), "One two three four five six seven eight nine ten. Second.");

  // 1. Numbers by significant figures, said as a person would; a log axis maps boxes, pointer and pitch by log(value).
  assert.equal(spoken(316574), "317 thousand");
  assert.equal(spoken(13699), "13.7 thousand");
  assert.equal(spoken(2400000), "2.4 million");
  assert.equal(spoken(1e8), "100 million");
  assert.equal(spoken(-0.172), "minus 0.17");
  assert.equal(spoken(640, 1e8), "640"); // a linear range never turns a non-zero value into 0
  const yrs = [1962, 1970, 1980, 1990, 2000, 2010, 2021];
  const grow = (a: number, b: number) => yrs.map((x, k) => ({ x, y: a * Math.pow(b / a, k / 6) }));
  const logc = cleanChart({ chart_type: "line", x_axis: { label: "", min: 1960, max: 2030 }, y_axis: { label: "Net personal wealth", unit: "USD", min: 100, max: 1e8, scale: "log", ticks: [100, 1e7] }, plot_area: P,
    series: [{ name: "Top 1%", points: grow(400000, 15876721) }, { name: "50-90th percentile", points: grow(9800, 316574) }, { name: "Bottom half", points: grow(640, 13699) }] })!;
  const lt = chartTour(logc, info, "x");
  short(lt);
  const mid = lt.stops.find((s) => s.label === "50-90th percentile")!;
  assert.equal(mid.says, "Grows about 32 times, from 9800 to 317 thousand dollars. Highest about 317 thousand at x 2021; lowest about 9800 at x 1962.");
  assert.equal(lt.stops.find((s) => s.label === "Vertical axis")!.says, "Net personal wealth: 100 to 10 million dollars, on a log scale.");
  assert.ok(mid.box_2d[2] - mid.box_2d[0] > 150 && mid.box_2d[0] > 300); // a real band in the middle, not a strip at the bottom
  assert.equal(xAtPointer(lt.chart!, 500, 500), 1995);
  assert.equal(Math.round(pitch(1e4, 100, 1e6, true)), 440);

  // 2. Stacked bars: one stop per category (total and largest part), a column box each, a "Total" series for stepping.
  const st = cleanChart({ chart_type: "stacked_bar", title: "Profits", x_axis: { label: "Year", min: 2006, max: 2010 }, y_axis: { label: "Profit", unit: "billion US $", min: 0, max: 250, ticks: [0, 200] }, plot_area: P,
    categories: ["2007", "2008", "2009"], stacked: true, totals: [100, 150, 60],
    series: [{ name: "Shell", values: [30, 40, 10] }, { name: "Exxon", values: [50, 80, 20] }, { name: "BP", values: [20, 30, 10] }] })!;
  const stt = chartTour(st, { ...info, takeaway: "Profits fell overall." }, "x");
  short(stt);
  assert.deepEqual(stt.stops.map((s) => s.label), ["Main finding", "Horizontal axis", "Vertical axis", "Legend", "2007", "2008", "2009", "Comparison"]);
  assert.equal(stt.stops[4].says, "Total about 100 billion dollars. Largest: Exxon, about 50 billion.");
  assert.equal(stt.stops[6].says, "Total roughly 40 billion dollars. Largest: Exxon, roughly 20 billion."); // 40 against a printed 60
  assert.equal(stt.stops[3].says, "Stacked from the bottom: Shell, Exxon and BP.");
  assert.ok(stt.stops[4].box_2d[3] <= stt.stops[5].box_2d[1] && stt.stops[5].box_2d[3] <= stt.stops[6].box_2d[1]); // columns in axis order
  assert.equal(stt.chart!.series[0].name, "Total");
  assert.match(pointLine(stt.chart!, 0, 1), /^Year 2008: about 150 billion dollars, the highest point\. Exxon 80 billion/);
  assert.match(reading(stt.chart!, 2008.3, 0), /^At year 2008: total about 150 billion dollars, shell about 40 billion/);

  // 4. Printed pie labels are said as printed, without "about"; every wedge has its own box; extra printed figures are kept.
  const pp = chartTour(cleanChart({ chart_type: "pie", plot_area: P, pie_area: [100, 100, 900, 900], series: [{ name: "Slices", points: [
    { x: 0, y: 45, label: "Tubular", printed: true, note: "M: 2%" }, { x: 1, y: 6, label: "Tubulovillous", printed: true }, { x: 2, y: 1, label: "Villous", printed: true },
    { x: 3, y: 8, label: "Other", printed: true }, { x: 4, y: 2, label: "Carcinoma", printed: true }, { x: 5, y: 5, label: "Others", printed: true }, { x: 6, y: 35, label: "Hyperplastic", printed: true }] }] })!, info, "x");
  short(pp);
  assert.equal(pp.stops.find((s) => s.label === "Tubular")!.says, "45 percent, the largest slice. Also printed: M: 2%.");
  assert.equal(pp.stops.find((s) => s.label === "Hyperplastic")!.says, "35 percent.");
  const wedges = pp.stops.slice(2, 9).map((s) => s.box_2d.join());
  assert.equal(new Set(wedges).size, 7);

  // 3. No excuse: an unverified failure says it could not read the values and gives the quick description, never "no scale".
  const failed = cleanChart({ chart_type: "stacked_bar", plot_area: P, y_axis: { label: "Profit", min: 0, max: 200 }, series: [{ name: "Shell" }] })!;
  const ft = chartTour(failed, { ...info, quickSays: "A stacked bar chart of profit by year." }, "x");
  const v = ft.stops.find((s) => s.label === "Values")!.says;
  assert.equal(v, "I could not read the exact values of this chart. Here is what it shows: a stacked bar chart of profit by year.");
  assert.ok(v.startsWith(COULD_NOT_READ.slice(0, -1)));
  assert.ok(!/no scale/i.test(JSON.stringify(ft)));

  // 6. Overlapping series get distinct boxes, each at least a sixth of the plot wide.
  const xs = [0, 10, 20, 30, 40, 50, 60];
  const ov = chartTour(cleanChart({ chart_type: "line", x_axis: { label: "t", min: 0, max: 60 }, y_axis: { label: "v", min: 0, max: 100 }, plot_area: P,
    series: [{ name: "A", points: xs.map((x) => ({ x, y: x < 30 ? 50 : 90 })) }, { name: "B", points: xs.map((x) => ({ x, y: x < 30 ? 10 : 50 })) }, { name: "C", points: xs.map((x) => ({ x, y: 30 + (x % 20) })) }] })!, info, "x");
  const [ba, bb, bc] = ["A", "B", "C"].map((n) => ov.stops.find((s) => s.label === n)!.box_2d);
  assert.ok(new Set([ba.join(), bb.join(), bc.join()]).size === 3);
  for (const b of [ba, bb, bc]) assert.ok(b[3] - b[1] >= 800 / 6 - 1);
}
