// Checks that the harness's "heard" stream tells the truth: runs one real-mode session with --probe (which measures the
// page's actual audio energy) through five scenes and compares every heard start and end with the energy.
//   node scripts/blind/verify.mjs [--base http://localhost:3000] [--port 4490] [--only read3,cut,tour,typed,video]
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const PORT = Number(opt("port", 4490));
const BASE = opt("base", "http://localhost:3000");
const ONLY = opt("only", "read3,cut,tour,typed,video").split(",");
const PAGE = "https://openstax.org/books/biology-2e/pages/8-1-overview-of-photosynthesis";
const VIDEO = opt("video", "https://www.youtube.com/watch?v=EPvd-3712U8");
const H = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THR = -50; // dBFS: above this the page is making sound
const TOL = 150;

const child = spawn(process.execPath, [fileURLToPath(new URL("./session.mjs", import.meta.url)), "--port", String(PORT), "--base", BASE, "--name", "verify", "--probe", "--open", PAGE], { stdio: ["ignore", "pipe", "inherit"] });
let out = "";
child.stdout.on("data", (d) => (out += d));
for (let i = 0; i < 100 && !/referee token/.test(out); i++) await sleep(200);
const TOKEN = out.match(/referee token \(not for personas\): (\w+)/)?.[1];
if (!TOKEN) throw new Error(`session did not start: ${out}`);

const post = (p, b) => fetch(H + p, { method: "POST", body: JSON.stringify(b) }).then((r) => r.text());
const listen = (max = 20000) => fetch(`${H}/listen?max=${max}`).then((r) => r.text());
const truth = () => fetch(`${H}/truth?token=${TOKEN}&energy=1`).then((r) => r.json());

const PHRASES = ["next", "go back", "skip this section", "where am I", "repeat that"];
const modes = [];
const scenes = {
  // The same five phrases in text mode and in audio mode (the student's own Kokoro voice into the fake microphone): the
  // app must decide the same thing. Each phrase starts from the same place (Home), so state does not differ.
  async modes(say) {
    for (const text of PHRASES)
      for (const mode of ["text", "audio"]) {
        await post("/press", { key: "Escape" });
        await post("/press", { key: "Home" });
        await listen(15000);
        const before = (await fetch(`${H}/log?token=${TOKEN}`).then((r) => r.json())).commands.length;
        await post("/say", { text, mode });
        const heard = await listen(15000);
        const t = await truth();
        const cmds = (await fetch(`${H}/log?token=${TOKEN}`).then((r) => r.json())).commands.slice(before).map((c) => c.detail?.name + (c.detail?.args && Object.keys(c.detail.args).length ? JSON.stringify(c.detail.args) : ""));
        modes.push({ text, mode, decision: t.decisionLine.replace(/^Heard "[^"]*" · /, ""), heardAs: t.decisionLine.match(/^Heard "([^"]*)"/)?.[1] ?? "", cmds: cmds.join(" ") });
        say(`${mode} "${text}":\n${heard}`);
      }
  },
  async read3(say) {
    say(await listen(20000)); // the page's opening lines
    for (let k = 0; k < 3; k++) {
      await post("/press", { key: "ArrowDown" });
      say(await listen(30000));
    }
  },
  async cut(say) {
    await post("/press", { key: "ArrowDown" });
    await sleep(2500); // mid-sentence
    await post("/press", { key: "ArrowDown" });
    say(await listen(30000));
  },
  async tour(say) {
    await post("/say", { text: "go to figure 8.2" });
    say(await listen(20000));
    await post("/press", { key: "Enter" });
    say(await listen(40000));
    await post("/press", { key: "ArrowRight" });
    say(await listen(30000));
    await post("/press", { key: "Escape" });
    say(await listen(8000));
  },
  async typed(say) {
    await post("/type", { text: "what is a photoautotroph" });
    say(await listen(30000));
  },
  async video(say) {
    await post("/paste", { text: VIDEO });
    say(await listen(40000));
    await post("/press", { key: "p" });
    say(await listen(25000)); // the lecturer, until a description or the limit
    await post("/press", { key: "p" });
    say(await listen(15000));
  },
};

// Energy "on" spans for one frame: samples above THR, gaps under 350 ms merged (pauses between words).
function spans(energy, frame, a, b) {
  const s = [];
  for (const [t, db, f] of energy) {
    if (f !== frame || t < a || t > b || db < THR) continue;
    const last = s.at(-1);
    if (last && t - last[1] < 350) last[1] = t;
    else s.push([t, t]);
  }
  return s;
}

const report = [];
for (const name of ONLY) {
  const lines = [];
  const a = Date.now();
  await scenes[name]((t) => lines.push(t));
  await sleep(1200);
  const b = Date.now();
  const tr = await truth();
  const items = tr.items.filter((it) => it.start >= a - 500 && it.start <= b && (it.kind === "speech" || it.kind === "sound" || it.kind === "lecture"));
  const on = (fr) => tr.energy.filter(([t, db, f]) => f === fr && t >= a && t <= b && db >= THR);
  const page = on("page");
  const rows = [];
  for (const it of items) {
    const frame = it.kind === "lecture" ? "video" : "page";
    const e = (fr) => (fr === "page" ? page : on(fr));
    const end = it.end ?? b;
    // The window stops at the neighbouring items, so a chime just before or a line just after is not counted as this one.
    const k = items.indexOf(it);
    const lo = Math.max(it.start - 300, items[k - 1]?.end ?? -Infinity), hi = Math.min(end + 300, items[k + 1]?.start ?? Infinity);
    const inside = e(frame).filter(([t]) => t >= lo && t <= hi);
    // A heard item that overlaps the next one (chime then speech) is judged on its own start only.
    const first = inside[0]?.[0], last = inside.at(-1)?.[0];
    rows.push({
      what: it.kind === "speech" ? `${it.voice}${it.cut ? " (cut)" : ""}: ${it.text.slice(0, 50)}` : it.kind === "sound" ? `sound ${it.name}` : "lecture",
      startOff: first == null ? null : Math.round(first - it.start),
      endOff: last == null || it.kind === "sound" ? null : Math.round(last - end),
      energy: inside.length > 0,
    });
  }
  // Energy with no heard item around it (with TOL either side): sound the student hears that the stream missed.
  const orphan = spans(tr.energy, "page", a, b).filter(([s, e]) => !items.some((it) => it.kind !== "lecture" && s <= (it.end ?? b) + TOL && e >= it.start - TOL));
  report.push({ name, lines, rows, orphan: orphan.map(([s, e]) => ({ at: s - a, ms: e - s })) });
}
const log = await fetch(`${H}/log?token=${TOKEN}`).then((r) => r.json());
await post("/end", {});

for (const r of report) {
  console.log(`\n=== ${r.name} ===`);
  for (const l of r.lines) console.log(l.replace(/^/gm, "  | "));
  console.log("  heard item                                              start Δms  end Δms  energy");
  for (const x of r.rows) console.log(`  ${x.what.padEnd(56)} ${String(x.startOff ?? "-").padStart(8)} ${String(x.endOff ?? "-").padStart(8)}  ${x.energy ? "yes" : "NO"}`);
  console.log(`  energy with no heard item: ${r.orphan.length ? JSON.stringify(r.orphan) : "none"}`);
}
if (modes.length) {
  console.log("\nphrase                 mode   heard as               decision / commands");
  for (const m of modes) console.log(`${m.text.padEnd(22)} ${m.mode.padEnd(6)} ${m.heardAs.padEnd(22)} ${m.decision} | ${m.cmds}`);
  const same = PHRASES.filter((p) => { const [a, b] = modes.filter((m) => m.text === p); return a && b && a.decision === b.decision && a.cmds === b.cmds; });
  console.log(`same decision and commands in both modes: ${same.length}/${PHRASES.length}`);
}
const all = report.flatMap((r) => r.rows);
const st = (k) => {
  const v = all.map((x) => x[k]).filter((x) => x != null).map(Math.abs).sort((p, q) => p - q);
  return v.length ? `median ${v[Math.floor(v.length / 2)]} ms, max ${v.at(-1)} ms, within ${TOL} ms: ${v.filter((x) => x <= TOL).length}/${v.length}` : "n/a";
};
console.log(`\nstart offsets: ${st("startOff")}\nend offsets:   ${st("endOff")}`);
console.log(`heard items with no energy: ${all.filter((x) => !x.energy).length}/${all.length}; energy spans with no item: ${report.reduce((n, r) => n + r.orphan.length, 0)}`);
console.log(`clips the page asked /api/speak for: ${log.speakAsked}; Arc-voice lines heard: ${log.items.filter((i) => i.kind === "speech" && i.voice === "arc").length}`);
process.exit(0);
