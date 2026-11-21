// The cost table, measured: one command against a running Arc with a FRESH .cache (nothing cached) in hosted mode, e.g.
//   PORT=3310 NODE_ENV=production ARC_KOKORO=off ARC_FRAMES=remote ARC_LIMITS=off npx tsx server.ts   (in a clean copy)
//   node scripts/measure-costs.mjs 3310 page video pdf typed spoken commands read
// Each step prints the change in GET /api/budget (dollars and tokens by feature). Spends real money: about $0.40 in all
// (Nov 2026). Spoken steps replay recorded asks from .cache/asks (this laptop only).
import { readFileSync } from "node:fs";
const port = process.argv[2] ?? "3310";
const steps = process.argv.slice(3);
const ASKS = ".cache/asks/"; // run from the repo root
const base = `http://localhost:${port}`;
const twin = await (await fetch(`${base}/api/load`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://www.mdpi.com/1424-8220/24/6/1935", live: true }) })).json();
const first = (t) => t.split(/(?<=[.!?])\s+/)[0]?.slice(0, 240) ?? "";
const context = [`Title: ${twin.source.title}`, ...twin.nodes.map((n) => n.kind === "figure" ? `${n.heading} (figure): ${n.text.slice(0, 300)}` : `${n.heading}: ${first(n.text)}`)].join("\n").slice(0, 6000);
const items = twin.nodes.filter((n) => n.heading).slice(0, 60).map((n) => ({ id: n.id, label: n.heading }));
// A tool, not a browser: it names Arc's own origin, as the server's cross-site rule asks of every WebSocket (lib/server/limits.ts).
const ws = new WebSocket(`ws://localhost:${port}/ws/voice`, { headers: { origin: base } });
await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); ws.on("unexpected-response", (_q, res) => j(new Error(`HTTP ${res.statusCode}`))); });
const waiters = new Map(); const audio = new Map();
ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.type === "audio") audio.set(m.id, (audio.get(m.id) ?? 0) + Buffer.from(m.data, "base64").length);
  for (const w of [...(waiters.get(m.id) ?? [])]) w(m); });
ws.on("close", (c, r) => console.log("ws closed", c, String(r)));
const on = (id, pred, ms = 30000) => new Promise((res) => { const list = waiters.get(id) ?? []; waiters.set(id, list); const off = () => list.splice(list.indexOf(f), 1); const t = setTimeout(() => { off(); res({ type: "timeout" }); }, ms); const f = (m) => { if (pred(m)) { clearTimeout(t); off(); res(m); } }; list.push(f); });
ws.send(JSON.stringify({ type: "start", context, where: "Current item: Abstract" }));
await new Promise((r) => setTimeout(r, 2500)); // the question session opens
let n = 0;
async function typed(text) {
  const id = `t${++n}`; const t = Date.now();
  ws.send(JSON.stringify({ type: "ask_text", id, text }));
  const m = await on(id, (m) => m.type === "done" || m.type === "error" || m.type === "command");
  console.log(`typed "${text}" -> ${m.type} ${Date.now() - t} ms "${m.transcript ?? m.message ?? m.name}" audio ${((audio.get(id) ?? 0) / 48000).toFixed(1)} s`);
}
async function spoken(file, decideToo = true) {
  const id = `s${++n}`; const t = Date.now();
  const wav = readFileSync(ASKS + file); const pcm = wav.subarray(44);
  const heardP = on(id, (m) => m.type === "heard", 20000);
  ws.send(JSON.stringify({ type: "ask_start", id }));
  for (let i = 0; i < pcm.length; i += 3200) { ws.send(JSON.stringify({ type: "ask_audio", data: pcm.subarray(i, i + 3200).toString("base64") })); await new Promise((r) => setTimeout(r, 20)); }
  const doneP = on(id, (m) => m.type === "done" || m.type === "error", 30000);
  ws.send(JSON.stringify({ type: "ask_end", id }));
  const h = await heardP;
  let dec = "";
  if (decideToo && h.text) { const r = await fetch(`${base}/api/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ utterance: h.text, items, state: { mode: "reading" } }) }); const j = await r.json(); dec = r.ok ? `${j.action}${j.act ? " (act)" : ""}` : `HTTP ${r.status} ${j.say ?? j.error}`; }
  const d = await doneP;
  console.log(`spoken ${file.slice(0, 24)} heard "${h.text}" decide ${dec} -> ${d.type} ${Date.now() - t} ms "${(d.transcript ?? d.message ?? "").slice(0, 80)}" audio ${((audio.get(id) ?? 0) / 48000).toFixed(1)} s`);
}
async function read(seconds) {
  const lines = twin.nodes.filter((x) => x.kind !== "figure").flatMap((x) => x.text.split(/(?<=[.!?])\s+/)).filter((s) => s.length > 30).slice(0, 80);
  let total = 0, k = 0; const t0 = Date.now(); let firstMs = 0;
  while (total < seconds && k < lines.length) {
    const id = `r${++n}`; const t = Date.now();
    const firstAudio = on(id, (m) => m.type === "audio", 30000);
    ws.send(JSON.stringify({ type: "say", id, text: lines[k++] }));
    await firstAudio; if (!firstMs) firstMs = Date.now() - t;
    const m = await on(id, (m) => m.type === "done" || m.type === "error", 60000);
    const s = (audio.get(id) ?? 0) / 48000; total += s;
    if (m.type !== "done") console.log("line", k, m.type, m.message);
  }
  console.log(`read ${k} lines, ${total.toFixed(1)} s of audio in ${((Date.now() - t0) / 1000).toFixed(1)} s, first audio ${firstMs} ms`);
}
const COMMANDS = ["2026-11-20T07-29-10-575Z-v1.wav", "2026-11-20T07-22-47-985Z-v1.wav", "2026-11-20T07-40-09-835Z-v1.wav", "2026-11-20T07-49-50-090Z-v1.wav", "2026-11-13T20-32-46-217Z-v42.wav", "2026-11-20T07-41-38-297Z-v1.wav", "2026-11-20T08-00-36-454Z-v1.wav", "2026-11-13T20-34-31-668Z-chk-06-fast-babble5-71661.wav", "2026-11-20T07-31-30-195Z-v1.wav", "2026-11-13T20-33-45-643Z-chk-02-daniel-cut100-pink10-25637.wav"];
const budget = async () => (await fetch(`${base}/api/budget`)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function measured(name, fn) {
  const a = await budget();
  await fn();
  await sleep(9000); // a Live turn's usage arrives with turnComplete, after the audio
  const b = await budget();
  const feats = Object.entries(b.byFeature).map(([k, v]) => [k, v, a.byFeature[k] ?? { calls: 0, usd: 0, input: 0, output: 0, thinking: 0 }]).filter(([, v, w]) => v.calls !== w.calls);
  console.log(`== ${name}: $${(b.geminiUsd - a.geminiUsd).toFixed(4)} Gemini, Bright Data ${JSON.stringify(Object.fromEntries(["unlocker", "serp", "browserNav"].map((k) => [k, b.brightData[k] - a.brightData[k]])))}`);
  for (const [k, v, w] of feats) console.log(`   ${k}: ${v.calls - w.calls} calls, in ${v.input - w.input} out ${v.output - w.output} think ${v.thinking - w.thinking} tokens, $${(v.usd - w.usd).toFixed(4)}`);
}
async function settle(ms) { let last = -1; for (let t = 0; t < ms; t += 15000) { const u = (await budget()).geminiUsd; if (u === last) return; last = u; await sleep(15000); } }
const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
async function video(v = "fNk_zzaMoSs", seconds = 592) {
  await post("/api/load", { url: `https://www.youtube.com/watch?v=${v}` });
  await post("/api/video/shown", { id: v, duration: seconds });
  for (let k = 0; k < 60; k++) { const s = await (await fetch(`${base}/api/video/shown?id=${v}`)).json(); if (s.done) break; await sleep(10000); }
  await settle(120000); // pictures keep coming after the words are done
}
async function pdf() {
  const t = await post("/api/load", { url: "https://arxiv.org/pdf/1706.03762" });
  await settle(120000);
  await post("/api/pdf/page", { id: t.id.replace(/^pdf-/, ""), n: 4 });
  await settle(120000);
}
for (const s of steps) {
  if (s === "page") await measured("open the demo web page (22 figures, tours warmed in the background)", () => settle(300000));
  if (s === "video") await measured("open a 10-minute lecture (transcript, descriptions, pictures)", () => video());
  if (s === "pdf") await measured("a PDF (page 1 on open, then page 4 with equations)", () => pdf());
  if (s === "typed") await measured("a typed question", () => typed("What does the belt unit contain?"));
  if (s === "spoken") await measured("a spoken question", () => spoken("2026-11-13T20-34-51-290Z-chk-07-fast-babble5-91287.wav"));
  if (s === "commands") await measured("ten spoken commands", async () => { for (const f of COMMANDS) await spoken(f); });
  if (s === "read") await measured("a minute of reading (Gemini voice)", () => read(60));
}
ws.close();
process.exit(0);
