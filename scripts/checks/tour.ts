// Offline: prepared figures never touch the network or Gemini.
import assert from "node:assert";
import { chartSketch, getTour, quietChart, STILL_READING } from "../../lib/server/tour";

export default async function check() {
  const lower = await getTour("https://mdpi-res.com/sensors/sensors-24-01935/article_deploy/html/images/sensors-24-01935-g001-550.jpg");
  assert.equal(lower?.stops.length, 6);
  assert.equal(lower?.image, "/fixtures/lower/figure-1280.jpg");
  const full = await getTour("https://mdpi-res.com/sensors/sensors-24-01935/article_deploy/html/images/sensors-24-01935-g001.png");
  assert.equal(full?.image, "/fixtures/lower/figure-1280.jpg");
  const mars = await getTour("https://mdpi-res.com/aerospace/aerospace-09-00604/article_deploy/html/images/aerospace-09-00604-g001-550.jpg");
  assert.equal(mars?.image, "/fixtures/mars/figure-1280.jpg");
  assert.ok(mars && mars.stops.length >= 5);

  // A quick chart tour states no counts or values (the light model said "nine cycles" for ten).
  const q = quietChart({
    title: "Knee angle during squats",
    overview: "A line chart of knee angle over time. It shows nine repeating squat cycles.",
    stops: [
      { n: 1, label: "X axis", says: "The x axis measures time in seconds.", box_2d: [0, 0, 1, 1], confidence: "high" },
      { n: 2, label: "Peaks", says: "The highest point is about 95 degrees.", box_2d: [0, 0, 1, 1], confidence: "high" },
      { n: 3, label: "Legend", says: "Two series: left knee and right knee. Several cycles repeat.", box_2d: [0, 0, 1, 1], confidence: "high" },
    ],
    stage: "quick",
  });
  assert.equal(q.overview, `A line chart of knee angle over time. ${STILL_READING}`);
  assert.deepEqual(q.stops.map((s) => s.says), ["The x axis measures time in seconds.", "Series: left knee and right knee. Several cycles repeat."]);
  assert.deepEqual(q.stops.map((s) => s.n), [1, 2]);
  assert.equal(quietChart(q).overview, q.overview); // idempotent on a saved one

  // The quick chart tour is built from names, never just "A chart."; names with digits stay, values do not.
  const sk = chartSketch("Profits of energy companies", { chart_type: "stacked_bar", x_label: "Year", y_label: "Billion US $ (0-200)", series_names: ["Shell", "BP", "Top 1%"], plot_area: [100, 100, 900, 800] }, "x")!;
  assert.equal(sk.overview, `A stacked bar chart of Billion US $ by Year. ${STILL_READING}`);
  assert.deepEqual(sk.stops.map((s) => s.label), ["Title", "Horizontal axis", "Vertical axis", "Legend", "Plot area"]);
  assert.equal(sk.stops[3].says, "Series: Shell, BP, Top 1%.");
  assert.equal(quietChart(sk), sk);
  const bare = quietChart({ title: "Net wealth", overview: "It rises 30 times.", stops: [{ n: 1, label: "A", says: "Peak at 5.", box_2d: [0, 0, 1, 1], confidence: "low" }], stage: "quick" });
  assert.notEqual(bare.overview, `A chart. ${STILL_READING}`);
  for (const t of [sk, bare]) for (const x of [t.overview, ...t.stops.map((s) => s.says)]) assert.ok(x.split(/(?<=[.!?])\s+/).length <= 2, x);
}
