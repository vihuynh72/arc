// Live check of POST /api/decide against a running dev server (needs the network and GEMINI_API_KEY there; not part of selfcheck).
// Run: node scripts/checks/decide-live.mjs [http://localhost:3000]
const BASE = process.argv[2] ?? "http://localhost:3000";
const PAGE = "https://www.mdpi.com/1424-8220/24/6/1935";
const load = await (await fetch(`${BASE}/api/load`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: PAGE }) })).json();
// The same labels components/Twin.tsx sends: figures as "heading: caption start", sections as the heading.
const items = load.nodes.map((n) => ({ id: n.id, label: n.kind === "figure" ? `${n.heading}: ${n.text.slice(0, 80)}` : n.heading }));
const results = [
  { id: "r01", label: "Result 1: Wearable IMU systems for knee rehabilitation (pubmed.ncbi.nlm.nih.gov)" },
  { id: "r02", label: "Result 2: Smart garments for lower limb exercise (mdpi.com)" },
  { id: "r03", label: "Result 3: Inertial sensors in physiotherapy, a review (sciencedirect.com)" },
];
const read = (cur, i) => ({ mode: "article", current_item: cur, position: `${i} of ${items.length}`, last_commands: "none", offer_pending: "none" });
const tour = { mode: "tour", current_item: "Figure 20: Inclination angles. (figure)", position: "35 of 45", last_commands: "tour", offer_pending: "none", tour_stop: "stop 2 of 6: right thigh" };
const res = { mode: "results", current_item: "none yet", position: "before the first of 3", last_commands: "search", offer_pending: "none" };
const sec = read("3. Results (section)", 22);
// [utterance, expected actions (|), expected targets (| ; null: needs none; "-": must not act; "?" prefix: ambiguous, so not acting is also right), items, state, inTour]
const cases = [
  ["take me to the results", "goto", "n22", items, sec],
  ["go to the discussion", "goto", "n38", items, sec],
  ["uh can you jump to where they describe the hardware", "goto", "?n05|n23", items, sec],
  ["where do they talk about dynamic time warping", "goto", "?n21|n34", items, sec],
  ["I want to hear the conclusions", "goto", "n39", items, sec],
  ["tour figure 20", "tour", "n35", items, sec],
  ["walk me through the chart of the inclination angles", "tour", "n35", items, sec],
  ["describe the confusion matrix figure", "tour|goto", "n33", items, sec],
  ["next", "next", null, items, sec],
  ["go back", "prev", null, items, sec],
  ["say that again", "read", null, items, sec],
  ["be quiet", "stop", null, items, sec],
  ["faster", "none|question|read|stop", "-", items, sec], // the local grammar (lib/intent.ts) owns this; the route has no speed action, so it must not act
  ["slower please", "none|question|read|stop", "-", items, sec],
  ["find me a paper on knee rehab wearables", "search", null, items, sec],
  ["search for studies about inertial sensors in physiotherapy", "search", null, items, sec],
  ["open the first one", "open", "r01", results, res],
  ["open the one from sciencedirect", "open", "r03", results, res],
  ["what does the belt unit contain", "question", null, items, sec],
  ["why did they use dynamic time warping", "question", null, items, sec],
  ["the the um", "none|question", "-", items, sec],
  ["skip this section", "nextHeading", null, items, sec],
  ["next stop please", "next", null, items, tour, true],
  ["back one", "prev|prevFigure", null, items, tour, true],
  ["say it again", "read", null, items, tour, true],
  ["make the text bigger", "display", "-", items, sec],
];
const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const rows = [];
let ok = 0;
for (const [u, ea, et, its, state, inTour] of cases) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/api/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ utterance: u, items: its, inTour: inTour === true, state }) });
  const ms = Date.now() - t0;
  const d = await r.json();
  if (!r.ok) { rows.push({ u, ok: false, line: `HTTP ${r.status} ${d.error}`, ms }); continue; }
  const aOk = ea.split("|").includes(d.action) || (et?.startsWith("?") && !d.act);
  const amb = et?.startsWith("?");
  const tNeeded = et !== null && et !== "-";
  const tOk = !tNeeded || (et.replace("?", "").split("|").includes(d.target) && d.act) || (amb && !d.act);
  const nonActing = et === "-" && !["display"].includes(ea); // expected not to act on anything
  const good = aOk && tOk && (nonActing ? !d.act : true);
  if (good) ok++;
  rows.push({ u, ok: good, ms, line: `exp ${ea}${tNeeded ? " > " + et : ""} | got ${d.action}${d.target ? " > " + d.target : ""} conf ${d.confidence.toFixed(2)} tconf ${d.targetConfidence.toFixed(2)} act ${d.act}` });
}
for (const r of rows) console.log(`${r.ok ? "ok" : "XX"} ${String(r.ms).padStart(5)} ms  "${r.u}"  ${r.line}`);
const ms = rows.map((r) => r.ms);
console.log(`\n${ok}/${cases.length} correct, median ${med(ms)} ms, worst ${Math.max(...ms)} ms (ms is the whole round trip to the route)`);
process.exit(ok === cases.length ? 0 : 1);
