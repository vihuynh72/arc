// Offline: the code-built chart tour, the scrub's interpolation and the pitch mapping.
import assert from "node:assert";
import { chartTour, cleanChart, countPeaks, pitch, pointLine, reading, relation, valueAt } from "../../lib/chart";

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
  assert.equal(t.stops[4].says, "Starts at about 10 degrees, rises to about 80 and falls back, about 2 times. Highest about 80 at sample point 20; lowest about 10 at sample point 0.");
  assert.equal(t.stops[6].says, "Right thigh is higher on average than left thigh, by about 5 degrees. The largest gap is about 5 degrees, at sample point 0, where right thigh is higher. They do not cross.");
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
  assert.ok(bt.stops.some((s) => s.label === "Values" && s.says.includes("cannot be read")));

  const info = { title: "T", takeaway: "K.", notable: [], unreadable: null, confidence: "high" };
  const P: [number, number, number, number] = [100, 100, 900, 900];
  // Bar: ranked, labels kept, still scrubbable.
  const bar = chartTour(cleanChart({ chart_type: "bar", x_axis: { label: "Year", min: 0, max: 2 }, y_axis: { label: "People", min: 0, max: 5000 }, plot_area: P, series: [{ name: "Population", points: [{ x: 0, y: 4161, label: "1861" }, { x: 1, y: 4863, label: "1911" }, { x: 2, y: 858, label: "2021" }] }] })!, info, "x");
  assert.ok(bar.chart);
  assert.match(bar.stops.find((s) => s.label === "Population")!.says, /^3 bars\. Highest: 1911, about 4860; lowest: 2021, about 860\./);
  // Scatter: direction, strength and the outlier, computed in code.
  const cloud = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((x) => ({ x, y: 2 * x + (x % 2 ? 0.3 : -0.3) }));
  cloud.push({ x: 5.5, y: 40 });
  const rel = relation(cloud);
  assert.equal(rel.outliers.length, 1);
  const sc = chartTour(cleanChart({ chart_type: "scatter", x_axis: { label: "x", min: 0, max: 11 }, y_axis: { label: "y", min: 0, max: 45 }, plot_area: P, series: [{ name: "Cloud", points: cloud }] })!, info, "x");
  assert.match(sc.stops.find((s) => s.label === "Cloud")!.says, /^11 points read, with a (moderate|strong) relationship: as one goes up, so does the other.*One point stands apart/);
  assert.ok(!sc.stops.some((s) => s.label === "Comparison"));
  // Pie: shares recomputed to 100, largest first, no scrub.
  const pie = chartTour(cleanChart({ chart_type: "pie", plot_area: P, series: [{ name: "Slices", points: [{ x: 0, y: 10, label: "B" }, { x: 1, y: 30, label: "A" }, { x: 2, y: 10, label: "C" }] }] })!, info, "x");
  assert.equal(pie.chart, undefined);
  assert.deepEqual(pie.stops.map((s) => s.label), ["Main finding", "Slices", "A", "B", "C"]);
  assert.equal(pie.stops[2].says, "About 60 percent, the largest slice.");
  assert.match(pie.overview, /largest first/);
  // Box: groups by median, a group with quartiles out of order is dropped.
  const box = chartTour(cleanChart({ chart_type: "box", y_axis: { label: "score", min: 0, max: 100 }, plot_area: P, series: [], boxes: [
    { label: "Low", min: 10, q1: 20, median: 30, q3: 40, max: 50 },
    { label: "High", min: 40, q1: 55, median: 70, q3: 80, max: 95 },
    { label: "Broken", min: 10, q1: 50, median: 30, q3: 40, max: 60 },
  ] })!, info, "x");
  assert.equal(box.chart, undefined);
  assert.deepEqual(box.stops.map((s) => s.label), ["Main finding", "Groups", "High", "Low"]);
  assert.equal(box.stops[2].says, "Median about 70. The middle half runs from about 55 to about 80; the whiskers reach from about 40 to about 95.");
  // Heat map: extremes, diagonal pattern, a stop per row.
  const cells = ["a", "b", "c"].flatMap((r) => ["a", "b", "c"].map((c) => ({ row: r, col: c, value: r === c ? 90 : 5 })));
  const hm = chartTour(cleanChart({ chart_type: "heatmap", plot_area: P, series: [], cells })!, info, "x");
  assert.equal(hm.chart, undefined);
  assert.ok(hm.stops.some((s) => s.label === "Pattern" && s.says.startsWith("Values are highest along the diagonal")));
  assert.equal(hm.stops.filter((s) => ["a", "b", "c"].includes(s.label)).length, 3);
  // Nothing readable on a pie: says so, invents nothing.
  const none = chartTour(cleanChart({ chart_type: "pie", plot_area: P, unreadable: "no labels", series: [{ name: "Slices", points: [] }] })!, { ...info, unreadable: "no labels" }, "x");
  assert.ok(none.stops.some((s) => s.label === "Values" && s.says.includes("cannot be read")));
}
