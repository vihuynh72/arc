// Offline: the code-built chart tour, the scrub's interpolation and the pitch mapping.
import assert from "node:assert";
import { chartTour, cleanChart, countPeaks, pitch, pointLine, reading, valueAt } from "../../lib/chart";

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
}
