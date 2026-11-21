// Blind-student harness: opens Arc in headless Chrome and serves a small HTTP API on 127.0.0.1 so an agent can use Arc
// only as a blind student would: by what comes out of the speakers (GET /listen) and by keys and voice (POST /press, /say).
// Sound is known from the app's own "arc:heard" events (lib/client/heard.ts). See scripts/blind/README.md.
//   node scripts/blind/session.mjs --port 4400 [--base http://localhost:3000] [--name ana] [--open <link>] [--fast] [--probe] [--model-down]
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const flag = (k) => argv.includes(`--${k}`);
const PORT = Number(opt("port", 4400));
const BASE = opt("base", "http://localhost:3000").replace(/\/$/, "");
const NAME = opt("name", `s${PORT}`).replace(/[^\w-]/g, "");
const OPEN = opt("open", "");
const FAST = flag("fast");
const PROBE = flag("probe"); // referee only: measure real audio energy (scripts/blind/verify.mjs)
// The models refused, as when the spending cap is reached: /api/decide answers with its budget refusal and the relay's
// question session with its recorded refusal (the shapes lib/server/decide route and lib/server/live.ts send). Pages, search
// and the reading voice are untouched.
const MODEL_DOWN = flag("model-down");
const DEPLETED = "Arc's voice and pictures are out of credit right now. Pages still load, but pictures and questions are off for now.";
const IDLE_MS = Number(opt("idle-min", 20)) * 60_000;
const REPLY_MS = 20_000; // after /say or /type, /listen waits this long for words before it gives up
const STUDENT_VOICE = opt("voice", "am_michael"); // the student's own voice for /say mode "audio": never Arc's (af_bella)
const TOKEN = randomBytes(9).toString("hex");
const LOGS = join(dirname(fileURLToPath(import.meta.url)), "logs");
mkdirSync(LOGS, { recursive: true });
const LOG = join(LOGS, `${NAME}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
const log = (o) => appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...o }) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- what was heard ----------
const SOUND_MS = { chime: 400, "listening-on": 400, "listening-off": 400, tick: 60, tone: 100, "wait-tone": 500 };
const items = []; // { kind: speech|sound|lecture|pause, start, end?, ... } in epoch ms, in start order
const open = []; // speech items still playing
let lecture = null; // the lecture item playing now
let paused = false;
let lastSound = 0; // when the last audible thing ended
let segs = []; // video segments {start, end, text}: what the lecturer says when
const actions = [];
const decisions = [];
let cursor = null;
const commands = [];

// Kokoro pads every clip with silence (about 0.43 s before, 0.57 s after, at 1x): a clip that starts playing is not yet a
// voice. Each clip's own padding is measured from its audio, and its speed from how long it took to play.
const pads = new Map(); // "voice|text" -> { lead, trail, dur } in seconds at 1x
const PAD = { lead: 0.43, trail: 0.57 };
let arcRate = 1.25;
const padOf = (buf) => padPcm(buf.subarray(buf.indexOf("data", 12) + 8), buf.readUInt32LE(24));
function padPcm(pcm, sr) {
  const n = pcm.length >> 1, win = Math.round(sr / 100);
  let first = -1, last = -1;
  for (let i = 0; i + win <= n; i += win) {
    let sq = 0;
    for (let j = i; j < i + win; j++) sq += pcm.readInt16LE(j * 2) ** 2;
    if (10 * Math.log10(sq / win / 32768 ** 2 + 1e-12) > -50) (first < 0 && (first = i)), (last = i + win);
  }
  return first < 0 ? null : { lead: first / sr, trail: (n - last) / sr, dur: n / sr };
}

function onHeard(e) {
  const t = e.epoch;
  log({ type: "heard", ...e });
  if (e.kind === "speech" && e.phase === "start") {
    const pad = pads.get(`${e.voice}|${e.text}`) ?? (FAST && e.voice === "arc" ? PAD : null);
    const it = { kind: "speech", voice: e.voice, text: e.text, start: t + (pad ? (pad.lead / (e.voice === "arc" ? arcRate : 1)) * 1000 : 0), raw: t, pad };
    items.push(it);
    open.push(it);
  } else if (e.kind === "speech" && open.some((o) => o.voice === e.voice && (o.text || e.text) === e.text && (o.pad ??= pads.get(`${e.voice}|${e.text}`)))) {
    const it = open.splice(open.findIndex((o) => o.voice === e.voice && (o.text || e.text) === e.text && o.pad), 1)[0];
    it.text ||= e.text;
    const p = it.pad; // known by now even when the clip's body was read after it started
    let rate = it.voice === "arc" ? arcRate : 1; // the second voice streams at 1x or plays at the tour speed: measured from its length
    if (e.phase === "end" && p.dur) rate = Math.min(2, Math.max(1, p.dur / ((t - it.raw) / 1000)));
    if (it.voice === "arc") arcRate = rate;
    it.start = it.raw + (p.lead / rate) * 1000;
    const voiced = it.raw + (((p.dur ?? 0) - p.trail) / rate) * 1000;
    it.end = e.phase === "end" ? t - (p.trail / rate) * 1000 : p.dur ? Math.min(t, voiced) : t;
    it.cut = e.phase === "cut" && it.end < voiced - 50;
    if (it.cut) it.frac = (it.end - it.start) / Math.max(1, voiced - it.start);
    if (it.end <= it.start) items.splice(items.indexOf(it), 1); // cut before its first word: nothing was heard
    else lastSound = Math.max(lastSound, it.end);
  } else if (e.kind === "speech") {
    // The matching start: the oldest open line of this voice with this text (an answer's text is known only at its end).
    let k = open.findIndex((o) => o.voice === e.voice && o.text === e.text);
    if (k < 0) k = open.findIndex((o) => o.voice === e.voice && !o.text);
    if (k < 0) return;
    const it = open.splice(k, 1)[0];
    Object.assign(it, { end: t, text: it.text || e.text, cut: e.phase === "cut", frac: e.frac });
    lastSound = Math.max(lastSound, t);
  } else if (e.kind === "sound") {
    const end = t + (SOUND_MS[e.name] ?? 200);
    items.push({ kind: "sound", name: e.name, hz: e.hz, start: t, end });
    lastSound = Math.max(lastSound, end);
  } else if (e.kind === "lecture") {
    if (e.state === "playing" && !lecture) items.push((lecture = { kind: "lecture", start: t, at: e.at }));
    else if (e.state === "paused" && lecture) {
      Object.assign(lecture, { end: t, atEnd: e.at });
      lecture = null;
      lastSound = Math.max(lastSound, t);
    }
  } else if (e.kind === "pause") {
    paused = e.on;
    items.push({ kind: "pause", on: e.on, start: t, end: t });
    if (e.on) lastSound = Math.max(lastSound, t);
  }
}
const audibleNow = (now = Date.now()) => (open.length > 0 && !paused) || !!lecture || lastSound > now;

// ---------- the transcript an agent reads ----------
const LABEL = { arc: "ARC", gemini: "ARC (second voice)" };
const words = (s) => s.split(/\s+/).filter(Boolean);
const part = (text, frac) => {
  const w = words(text);
  const n = Math.max(1, Math.round(w.length * Math.min(1, Math.max(0, frac ?? 1))));
  return n >= w.length ? text : `${w.slice(0, n).join(" ")}…`;
};
const est = (it, now) => ((now - it.start) / 1000) * arcRate / (0.6 + it.text.length / 15); // shortcut: assumes speed 1.25 for words-so-far
function lecturerWords(a, b) {
  if (!segs.length) return null;
  const out = [];
  for (const s of segs) {
    if (s.end <= a || s.start >= b || !s.text) continue;
    const w = words(s.text);
    const span = Math.max(0.1, s.end - s.start);
    const i = Math.max(0, Math.floor(((a - s.start) / span) * w.length));
    const j = Math.min(w.length, Math.ceil(((b - s.start) / span) * w.length));
    out.push(...w.slice(i, j));
  }
  return out.join(" ");
}
const pitch = (hz) => (hz.length < 2 ? "" : hz.at(-1) > hz[0] * 1.05 ? ", pitch rising" : hz.at(-1) < hz[0] * 0.95 ? ", pitch falling" : ", same pitch");

// The second voice answers something the student did: name it, so a reply that arrives late is not taken for the last action's.
function cause(it) {
  const a = actions.filter((x) => x.at <= (it.raw ?? it.start) && x.action !== "look").at(-1);
  if (!a) return "";
  const what = a.action === "say" ? `what you said: "${a.text}"` : a.action === "type" ? `what you typed: "${a.text}"` : a.action === "paste" ? `what you pasted: "${a.text}"` : a.action === "press" ? `your ${a.key === " " ? "Space" : a.key} key` : a.action;
  return `, answering ${what}`;
}

function render(t0, t1) {
  const rel = (t) => `[+${(Math.max(0, t - t0) / 1000).toFixed(1)}s]`;
  const lines = [];
  if (FAST) lines.push("(fast mode: Arc's reading voice is timed, not sounded: its words and lengths are right, its real delays are not)");
  const inWin = items.filter((it) => it.start < t1 && (it.end ?? Infinity) > t0 - 1 && !(it.kind !== "speech" && it.kind !== "lecture" && it.start < t0));
  let cover = t0;
  const gap = (t) => {
    if (t - cover >= 1000) lines.push(`${rel(cover)} (silence ${((t - cover) / 1000).toFixed(1)}s)`);
  };
  for (let k = 0; k < inWin.length; k++) {
    const it = inWin[k];
    gap(it.start);
    const end = it.end ?? t1;
    if (it.kind === "speech") {
      const before = (it.start < t0 ? " (continuing)" : "") + (it.voice === "gemini" ? cause(it) : "");
      if (it.end == null) lines.push(`${rel(it.start)} ${LABEL[it.voice]}${before} (still talking): ${it.text ? `"${part(it.text, Math.min(0.95, est(it, t1)))}"` : "(words not known until it finishes)"}`);
      else if (it.cut) lines.push(`${rel(it.start)} ${LABEL[it.voice]}${before}: "${part(it.text, it.frac)}" (cut off)`);
      else lines.push(`${rel(it.start)} ${LABEL[it.voice]}${before}: "${it.text}"`);
    } else if (it.kind === "lecture") {
      const a = it.at, b = it.atEnd ?? it.at + (end - it.start) / 1000;
      const w = lecturerWords(a, b);
      const still = it.end == null ? " (still playing)" : "";
      lines.push(`${rel(it.start)} LECTURER${still}: ${w ? `"…${w}…"` : `(talking for ${(b - a).toFixed(1)}s, words not known)`}`);
    } else if (it.kind === "pause") lines.push(`${rel(it.start)} (the voice pauses)`.replace("pauses", it.on ? "pauses" : "resumes"));
    else if (it.name === "tick" || it.name === "tone" || it.name === "wait-tone") {
      // A run of the same small sound is one line.
      const run = [it];
      while (inWin[k + 1]?.kind === "sound" && inWin[k + 1].name === it.name && inWin[k + 1].start - run.at(-1).start < 1600) run.push(inWin[++k]);
      const span = ((run.at(-1).start - it.start) / 1000).toFixed(1);
      const what = it.name === "tick" ? "soft tick" : it.name === "tone" ? "short tone" : "waiting tone";
      lines.push(`${rel(it.start)} (${run.length > 1 ? `${run.length} ${what}s over ${span}s${pitch(run.map((r) => r.hz ?? 0))}` : `a ${what}`})`);
      cover = Math.max(cover, run.at(-1).end);
      continue;
    } else lines.push(`${rel(it.start)} (${{ chime: "chime", "listening-on": "listening tone: Arc is listening", "listening-off": "listening tone: Arc stopped listening" }[it.name] ?? it.name})`);
    cover = Math.max(cover, Math.min(end, t1));
  }
  const talking = open.filter((o) => !paused);
  if (!audibleNow(t1)) gap(t1);
  if (talking.length || lecture) lines.push(`STILL TALKING when this returned${lecture ? " (the lecture is playing)" : ""}.`);
  else lines.push(lines.length && !(FAST && lines.length === 1) ? "Quiet now." : "Nothing at all.");
  return lines.join("\n");
}

// ---------- the page ----------
const server = createServer((req, res) => void handle(req, res).catch((e) => send(res, 500, `error: ${e.message}`)));
const browser = await (async () => {
  // Bind the port first: a second session on the same port must fail before it opens a browser.
  await new Promise((ok, fail) => {
    server.once("error", (e) => fail(e));
    server.listen(PORT, "127.0.0.1", ok);
  }).catch((e) => {
    console.error(e.code === "EADDRINUSE" ? `Port ${PORT} is already in use: another blind session (or something else) is running there. Pick another --port.` : e.message);
    process.exit(2);
  });
  return chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
})();

const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); // a fresh profile every session
await ctx.route("**/api/pointer**", (r) => (r.request().method() === "GET" ? r.fulfill({ json: { available: false } }) : r.fulfill({ status: 403, json: { moved: false } }))); // never the real OS pointer
// The page POSTs the text to /api/speak in a JSON body (never in the URL); a GET with ?text= is still read, for old callers.
const SPEAK = /\/api\/speak(\?|$)/;
const speakText = (req) => {
  try {
    return (req.method() === "POST" ? JSON.parse(req.postData() ?? "{}") : Object.fromEntries(new URL(req.url()).searchParams)).text ?? "";
  } catch {
    return "";
  }
};
if (FAST)
  await ctx.route(SPEAK, (r) => {
    const text = speakText(r.request());
    const dur = 0.6 + text.length / 15; // measured: Kokoro at 1x is about 15 characters a second plus 0.6 s
    // Its padding and length are known, as in real mode: without `dur` a line cut by a key was reported as heard to the end.
    if (text) pads.set(`arc|${text}`, { lead: Math.min(PAD.lead, dur * 0.25), trail: Math.min(PAD.trail, dur * 0.25), dur });
    r.fulfill({ status: 200, headers: { "content-type": "audio/wav" }, body: silentWav(dur) }).catch(() => {});
  });
// Real mode: each clip passes through here so its padding is known before it plays (a page-consumed body cannot be read later).
else
  await ctx.route(SPEAK, async (r) => {
    const res = await r.fetch().catch(() => null);
    if (!res) return r.abort().catch(() => {});
    const b = await res.body().catch(() => null);
    const text = speakText(r.request());
    const p = res.status() === 200 && b && b.length > 44 ? padOf(b) : null;
    if (text && p) pads.set(`arc|${text}`, p);
    await r.fulfill({ response: res, body: b ?? undefined }).catch(() => {});
  });
if (MODEL_DOWN)
  await ctx.route("**/api/decide", (r) =>
    r.request().method() !== "POST" ? r.fulfill({ status: 204 }) : r.fulfill({ json: { action: "question", confidence: 0, target: null, targetConfidence: 0, setting: null, settingConfidence: 0, query: "", ms: 0, act: false, budget: "depleted", say: DEPLETED } }),
  );
await ctx.exposeBinding("__blindEmit", (_src, e) => {
  if (e.type === "heard") {
    try {
      onHeard(e);
    } catch (err) {
      log({ type: "harness-error", text: String(err) }); // never silently lose what was heard
    }
  }
  else if (e.type === "cursor") (cursor = e.detail), log(e);
  else if (e.type === "command") commands.push(e), log(e);
  else if (e.type === "energy") for (const x of e.samples) energy.push([...x, e.frame]);
});
const energy = []; // [epoch, dBFS] samples, --probe only
await ctx.addInitScript(pageInit, { probe: PROBE, down: MODEL_DOWN, line: DEPLETED });
const page = await ctx.newPage();
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" || m.type() === "warning") log({ type: "console", level: m.type(), text: t.slice(0, 400) });
  if (t.includes("[arc-timing]") && /decision|dispatched|dropped|no speech|no transcript|heard|revis|answer|asking again/.test(t)) decisions.push({ at: Date.now(), text: t }), log({ type: "decision", text: t });
});
// The second voice's audio comes over the relay socket: collected per line, its padding measured once the line is done.
page.on("websocket", (ws) => {
  if (!ws.url().includes("/ws/voice")) return;
  const said = new Map(), pcm = new Map();
  let mic = null; // referee: what the microphone really sent for the open ask
  ws.on("framesent", (f) => {
    try {
      const m = JSON.parse(f.payload);
      if (m.type === "say") said.set(m.id, m.text.trim());
      if (m.type === "ask_start") mic = { id: m.id, n: 0, sq: 0 };
      if (m.type === "ask_audio" && mic) {
        const b = Buffer.from(m.data, "base64");
        for (let i = 0; i + 1 < b.length; i += 2) mic.sq += b.readInt16LE(i) ** 2;
        mic.n += b.length >> 1;
      }
      if (m.type === "ask_end" && mic) log({ type: "mic", id: mic.id, ms: Math.round(mic.n / 16), db: Math.round(10 * Math.log10(mic.sq / Math.max(1, mic.n) / 32768 ** 2 + 1e-12)) }), (mic = null);
      if (m.type === "ask_text") log({ type: "relay-sent", ask_text: m.text });
    } catch {}
  });
  ws.on("framereceived", (f) => {
    try {
      const m = JSON.parse(f.payload);
      if (m.type === "heard" || m.type === "error" || m.type === "command") log({ type: "relay", ...m });
      if (m.type === "audio") pcm.set(m.id, [...(pcm.get(m.id) ?? []), Buffer.from(m.data, "base64")]);
      if (m.type === "done" && pcm.has(m.id)) {
        const p = padPcm(Buffer.concat(pcm.get(m.id)), 24000);
        const text = said.get(m.id) ?? m.transcript ?? ""; // a line is heard by its own text, an answer by its transcript
        if (p && text) pads.set(`gemini|${text}`, p);
        pcm.delete(m.id);
      }
    } catch {}
  });
});
let speakAsked = 0; // clips the page asked for (prefetches included), for the referee: more are asked for than heard
page.on("request", (r) => void (SPEAK.test(r.url()) && speakAsked++));
page.on("response", async (r) => {
  if (!/\/api\/(load|ingest|video|preview)/.test(r.url()) || !(r.headers()["content-type"] ?? "").includes("json")) return;
  const j = await r.json().catch(() => null);
  const nodes = j?.nodes ?? j?.twin?.nodes;
  if (!Array.isArray(nodes)) return;
  const got = nodes.filter((n) => n.kind === "segment" && n.start != null).map((n) => ({ start: n.start, end: n.end ?? n.start + 10, text: n.text ?? "" }));
  if (got.length) segs = [...new Map([...segs, ...got].map((s) => [s.start, s])).values()].sort((a, b) => a.start - b.start);
});
// A reload or navigation (a dev hot reload too) silences everything at once, with no end event from the old page.
page.on("framenavigated", (f) => {
  if (f !== page.mainFrame()) return;
  const t = Date.now();
  for (const it of open.splice(0)) Object.assign(it, { end: Math.max(it.start, t), cut: true, frac: it.text ? Math.min(0.95, est(it, t)) : undefined });
  if (lecture) Object.assign(lecture, { end: t }), (lecture = null);
  paused = false;
  lastSound = Math.min(lastSound, t);
  log({ type: "navigated", url: f.url() });
});
const startUrl = OPEN ? `${BASE}/?url=${encodeURIComponent(OPEN)}` : `${BASE}/`;
await page.goto(startUrl, { waitUntil: "domcontentloaded" });
const started = Date.now();
let lastListen = Date.now();
let lastSeen = Date.now();
log({ type: "start", base: BASE, url: startUrl, fast: FAST, probe: PROBE, port: PORT, modelDown: MODEL_DOWN });
console.log(`blind session "${NAME}" on http://127.0.0.1:${PORT}  (Arc: ${startUrl}${FAST ? ", fast mode" : ""})`);
console.log(`referee token (not for personas): ${TOKEN}`);
console.log(`log: ${LOG}`);

// ---------- the student's hands and voice ----------
const KEYS = { space: " ", Space: " ", esc: "Escape", Esc: "Escape", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" };
const act = (o) => (actions.push({ at: Date.now(), ...o }), log({ type: "action", ...o }));
let acted = 0; // when the last action finished: a listen waits for something heard after it (not the Space chime during a /say)

async function say(text, mode) {
  if (mode === "audio") {
    const r = await fetch(`${BASE}/api/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, voice: STUDENT_VOICE }) });
    if (!r.ok) throw new Error(`could not make the student's voice (${r.status})`);
    const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
    await page.keyboard.down(" ");
    await sleep(300);
    await page.evaluate((b) => window.__blindMic.wav(b), b64);
    await sleep(350);
    await page.keyboard.up(" ");
    return;
  }
  // Text: the key is held as long as the words would take, the microphone hears speech-loud noise, and the words enter
  // where Live's final transcript does (the WebSocket's "heard"). Gemini is asked only if the app hands the ask to it.
  const ms = Math.min(4000, Math.max(700, words(text).length * 280));
  await page.evaluate((t) => (window.__blindText = { text: t }), text);
  await page.keyboard.down(" ");
  await sleep(300);
  await page.evaluate((m) => window.__blindMic.noise(m), ms);
  await sleep(300);
  await page.keyboard.up(" ");
}

async function look() {
  return page.evaluate(() => {
    const H = innerHeight;
    const where = (r) => ((r.top + r.bottom) / 2 < H / 3 ? "top" : (r.top + r.bottom) / 2 < (2 * H) / 3 ? "middle" : "bottom");
    const seen = (el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < H && r.width > 0 && getComputedStyle(el).visibility !== "hidden" ? r : null;
    };
    const out = [];
    const cur = document.querySelector('#content [aria-current="true"]');
    const rc = cur && seen(cur);
    out.push(rc ? `Highlighted block (${where(rc)} of the screen): "${cur.textContent.replace(/\s+/g, " ").trim().slice(0, 240)}"` : "No highlighted block in view.");
    const big = [...document.querySelectorAll("h1, h2, h3")].filter((h) => seen(h) && parseFloat(getComputedStyle(h).fontSize) >= 22);
    for (const h of big.slice(0, 3)) out.push(`Large heading (${where(seen(h))}): "${h.textContent.trim().slice(0, 80)}"`);
    for (const [sel, what] of [[".arc-pointer[data-on='true']", "a moving pointer"], [".arc-ring[data-on='true']", "a bright band around the text"]]) {
      const el = document.querySelector(sel);
      const r = el && seen(el);
      if (r) out.push(`You can see ${what}, ${where(r)} of the screen.`);
    }
    const tour = document.querySelector("[data-tour] img, section[aria-label^='Figure tour'] img");
    if (tour && seen(tour)) {
      const ring = tour.parentElement?.querySelector("div[aria-hidden='true']");
      const on = ring && getComputedStyle(ring).opacity === "1";
      const t = ring && parseFloat(ring.style.top), l = ring && parseFloat(ring.style.left);
      out.push(`A large picture fills much of the screen${on ? `; a bright ring sits on its ${t < 33 ? "upper" : t < 66 ? "middle" : "lower"} ${l < 33 ? "left" : l < 66 ? "centre" : "right"} part` : ""}.`);
    }
    if (document.querySelector("iframe[src*='youtube']")) out.push("A video picture is on the screen.");
    return out.join("\n");
  });
}

let mouseAt = { x: 640, y: 400 };
async function mouse(to) {
  let p;
  if (typeof to === "object" && to) p = { x: mouseAt.x + Number(to.dx || 0), y: mouseAt.y + Number(to.dy || 0) };
  else {
    const sel = to === "the picture" ? "section[aria-label^='Figure tour'] img, [data-tour] img, #content figure img" : '#content [aria-current="true"]';
    const r = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }, sel);
    if (!r) return `There is no ${to === "the picture" ? "picture" : "highlighted block"} to move to.`;
    p = r;
  }
  await page.mouse.move(p.x, p.y, { steps: Math.max(4, Math.round(Math.hypot(p.x - mouseAt.x, p.y - mouseAt.y) / 12)) }); // page pointer events only, never the OS pointer
  mouseAt = p;
  return "moved";
}

async function truth() {
  const t = await page.evaluate(() => {
    const cur = document.querySelector('#content [aria-current="true"]');
    const tour = document.querySelector("section[aria-label^='Figure tour']");
    return {
      title: document.title,
      url: location.href,
      mode: tour ? "tour" : document.querySelector("iframe[src*='youtube']") ? "video" : document.querySelector("#content") ? "reading" : "landing",
      highlighted: cur ? cur.textContent.replace(/\s+/g, " ").trim().slice(0, 160) : null,
      tourStop: tour?.querySelector("p strong")?.textContent ?? null,
      decisionLine: document.querySelector(".decision")?.textContent ?? "",
    };
  });
  return { ...t, cursor, lastCommands: commands.slice(-5).map((c) => c.detail), lastDecisions: decisions.slice(-3).map((d) => d.text) };
}

// ---------- summary and lifecycle ----------
function summary() {
  const end = Date.now();
  const spans = items.filter((it) => it.kind !== "pause").map((it) => [it.start, it.end ?? end]).sort((a, b) => a[0] - b[0]);
  let covered = 0, longest = 0, at = started, cur = null;
  for (const [a, b] of spans) {
    if (!cur || a > cur[1]) {
      if (cur) covered += cur[1] - cur[0];
      longest = Math.max(longest, a - at);
      cur = [a, b];
    } else cur[1] = Math.max(cur[1], b);
    at = Math.max(at, cur[1]);
  }
  if (cur) covered += cur[1] - cur[0];
  longest = Math.max(longest, end - at);
  const speech = items.filter((it) => it.kind === "speech");
  const count = new Map();
  for (const s of speech) if (s.text) count.set(s.text, (count.get(s.text) ?? 0) + 1);
  const interrupts = speech.filter((s) => s.cut && actions.some((a) => a.at <= s.end && s.end - a.at < 1500)).length;
  return {
    name: NAME,
    seconds: Math.round((end - started) / 100) / 10,
    actions: actions.length,
    speechSeconds: Math.round(speech.reduce((n, s) => n + ((s.end ?? end) - s.start), 0) / 100) / 10,
    silenceSeconds: Math.round((end - started - covered) / 100) / 10,
    longestSilenceSeconds: Math.round(longest / 100) / 10,
    interruptions: interrupts,
    heardMoreThanOnce: [...count].filter(([, n]) => n > 1).map(([text, n]) => ({ text, n })),
    didNotCatch: [...new Set(speech.map((s) => s.text).filter((t) => /did not catch|didn't catch|not sure|heard nothing|did not hear|could not|couldn't|try again|say that again|not available|out of credit|are off/i.test(t)))],
  };
}
let ended = false;
async function end(why) {
  if (ended) return;
  ended = true;
  const s = summary();
  log({ type: "summary", why, ...s });
  console.log(JSON.stringify(s, null, 2));
  server.close();
  await browser.close().catch(() => {});
  setTimeout(() => process.exit(0), 100);
  return s;
}
process.on("SIGINT", () => void end("signal"));
process.on("SIGTERM", () => void end("signal"));
setInterval(() => Date.now() - lastSeen > IDLE_MS && void end("idle"), 30_000).unref();

// ---------- the API ----------
function send(res, code, body) {
  const json = typeof body !== "string";
  res.writeHead(code, { "content-type": json ? "application/json" : "text/plain; charset=utf-8" });
  res.end(json ? JSON.stringify(body, null, 2) : body + "\n");
}
const body = (req) => new Promise((ok) => {
  let s = "";
  req.on("data", (c) => (s += c));
  req.on("end", () => {
    try {
      ok(s ? JSON.parse(s) : {});
    } catch {
      ok({});
    }
  });
});

async function handle(req, res) {
  lastSeen = Date.now();
  res.on("finish", () => req.method === "POST" && (acted = Date.now()));
  const u = new URL(req.url, "http://x");
  const route = `${req.method} ${u.pathname}`;
  const referee = u.searchParams.get("token") === TOKEN;
  if (route === "GET /listen") {
    const max = Math.min(120_000, Math.max(200, Number(u.searchParams.get("max")) || 6000));
    const t0 = Math.min(lastListen, Date.now()); // everything since the last listen, so nothing heard between calls is lost
    const call = Date.now();
    const busyAtCall = audibleNow();
    // After speaking or typing, tones (listening, waiting) are not the reply: wait for words or the lecture, up to REPLY_MS.
    const last = actions.filter((a) => a.action !== "look").at(-1);
    const asked = last && (last.action === "say" || last.action === "type") && last.at >= t0 - 50;
    const replied = () => items.some((it) => it.start >= last.at && ((it.kind === "speech" && it.text !== "One moment.") || it.kind === "lecture"));
    const limit = asked ? Math.max(max, REPLY_MS) : max;
    let gaveUp = false;
    for (;;) {
      await sleep(50);
      const now = Date.now();
      const waiting = asked && !replied();
      if (now - call >= (waiting ? limit : max)) {
        gaveUp = waiting;
        break;
      }
      if (waiting) continue;
      const heardSome = busyAtCall || items.some((it) => it.start >= Math.max(t0, acted) && it.kind !== "pause");
      if (heardSome && !audibleNow(now) && now - lastSound >= 700) break;
    }
    // A second-voice line whose words are known only when it ends: wait for it (up to 20 s more), so its words are heard.
    for (const until = Date.now() + 20_000; open.some((o) => o.voice === "gemini" && !o.text) && Date.now() < until; ) await sleep(50);
    const t1 = Date.now();
    const text = render(t0, t1).replace(/\n(Quiet now\.|Nothing at all\.)$/, (m, q) => (gaveUp ? `\nNo reply in ${Math.round((t1 - last.at) / 1000)} s after you ${last.action === "say" ? "spoke" : "typed"}: I stopped waiting. ${q}` : m));
    lastListen = t1;
    log({ type: "listen", max, text });
    return send(res, 200, text);
  }
  if (req.method === "POST" && ["/press", "/say", "/type", "/paste", "/mouse", "/end"].includes(u.pathname)) {
    const b = await body(req);
    if (u.pathname === "/press") {
      const key = KEYS[b.key] ?? String(b.key ?? "");
      if (!key) return send(res, 400, "say which key, e.g. {\"key\": \"ArrowDown\"}");
      act({ action: "press", key, holdMs: b.holdMs });
      if (b.holdMs) {
        await page.keyboard.down(key);
        await sleep(Math.min(20_000, Number(b.holdMs)));
        await page.keyboard.up(key);
      } else await page.keyboard.press(key);
      return send(res, 200, `pressed ${key}${b.holdMs ? ` for ${b.holdMs} ms` : ""}`);
    }
    if (u.pathname === "/say") {
      const mode = b.mode === "audio" ? "audio" : "text";
      if (!String(b.text ?? "").trim()) return send(res, 400, "say what? {\"text\": \"next\"}");
      act({ action: "say", text: b.text, mode });
      await say(String(b.text), mode);
      return send(res, 200, "you held Space, said it, and let go");
    }
    if (u.pathname === "/type" || u.pathname === "/paste") {
      act({ action: u.pathname.slice(1), text: b.text });
      await page.keyboard.press("/"); // the app's own key for the ask box
      await sleep(150);
      if (u.pathname === "/type") await page.keyboard.type(String(b.text ?? ""), { delay: 25 });
      else await page.keyboard.insertText(String(b.text ?? ""));
      await page.keyboard.press("Enter");
      return send(res, 200, u.pathname === "/type" ? "typed it and pressed Enter" : "pasted it and pressed Enter");
    }
    if (u.pathname === "/mouse") {
      act({ action: "mouse", to: b.to });
      return send(res, 200, await mouse(b.to));
    }
    if (u.pathname === "/end") {
      act({ action: "end" });
      const s = summary();
      send(res, 200, s);
      return void end("asked");
    }
  }
  if (route === "GET /look") return act({ action: "look" }), send(res, 200, await look());
  if (route === "GET /truth" || route === "GET /log") {
    if (!referee) return send(res, 403, "referee only");
    if (route === "GET /log") return send(res, 200, { items, actions, commands, decisions, segs: segs.length, speakAsked });
    return send(res, 200, { ...(await truth()), ...(u.searchParams.has("energy") ? { energy, items } : {}), summary: summary() });
  }
  send(res, 404, "endpoints: POST /press /say /type /paste /end, GET /listen; extras: GET /look, POST /mouse");
}

function silentWav(seconds) {
  const rate = 8000, n = Math.round(seconds * rate), h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + n * 2, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(n * 2, 40);
  return Buffer.concat([h, Buffer.alloc(n * 2)]);
}

// Runs in the page before the app: forwards arc:heard (and the cursor and commands, for the referee), gives the app a
// microphone the harness can speak into, and lets a /say in text mode hand its words over where Live's transcript arrives.
function pageInit({ probe, down, line }) {
  const emit = (o) => void window.__blindEmit?.(o)?.catch?.(() => {});
  const ep = (t) => performance.timeOrigin + t;
  addEventListener("arc:heard", (e) => emit({ type: "heard", ...e.detail, epoch: ep(e.detail.t) }));
  addEventListener("arc:cursor", (e) => emit({ type: "cursor", detail: e.detail, epoch: ep(performance.now()) }));
  addEventListener("arc:command", (e) => emit({ type: "command", detail: JSON.parse(JSON.stringify(e.detail ?? null)), epoch: ep(performance.now()) }));

  // The microphone: a Web Audio stream the harness feeds (a fixed fake-capture file cannot change between utterances).
  let mc, md;
  const mic = () => {
    if (!mc) {
      mc = new AudioContext({ sampleRate: 48000 });
      md = mc.createMediaStreamDestination();
    }
    void mc.resume();
    return mc;
  };
  navigator.mediaDevices.getUserMedia = async (c) => {
    if (!c?.audio) throw new DOMException("no camera here", "NotFoundError");
    mic();
    return md.stream;
  };
  const playInto = (buf) => new Promise((ok) => {
    const s = mc.createBufferSource();
    s.buffer = buf;
    s.connect(md);
    s.onended = () => ok(buf.duration);
    s.start();
  });
  window.__blindMic = {
    async wav(b64) {
      const c = mic();
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      return playInto(await c.decodeAudioData(bytes.buffer));
    },
    noise(ms) {
      const c = mic(), n = Math.round((ms / 1000) * c.sampleRate), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
      // Speech-loud (about -25 dBFS), not speech, as phrases: 400 ms of sound, 250 ms of near silence, as people pause between
      // words. The microphone's speech gate (lib/client/audio.ts) counts frames 10 dB over the quietest fifth of the ask: a
      // steady noise longer than a short sentence was taken for the room itself, and "I did not hear anything" followed.
      for (let i = 0, y = 0; i < n; i++) {
        const t = (i / c.sampleRate) % 0.65;
        y = 0.7 * y + 0.3 * (Math.random() * 2 - 1) * 0.35;
        d[i] = t < 0.4 ? y : y * 0.01;
      }
      return playInto(buf);
    },
  };

  // /say in text mode: the armed ask never reaches the relay as audio; its words come back as "heard", and only if the app
  // hands the ask to Gemini (ask_result source "gemini") are they sent on as a typed question, so a local command costs nothing.
  const WS = window.WebSocket;
  window.__blindText = null;
  window.WebSocket = class extends WS {
    constructor(...a) {
      super(...a);
      this.voice = String(a[0]).includes("/ws/voice");
      this.held = null;
    }
    send(data) {
      let m = null;
      if (this.voice) try { m = JSON.parse(data); } catch {}
      if (m?.type === "ask_start") {
        this.held = window.__blindText ? { id: m.id, text: window.__blindText.text, asked: false } : null;
        window.__blindText = null;
        if (this.held) return;
      }
      const h = this.held;
      if (h && m?.type === "ask_audio") return;
      if (h && m?.type === "ask_end" && (!m.id || m.id === h.id)) {
        setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "heard", id: h.id, text: h.text, source: "blind-text" }) })), 150);
        return;
      }
      if (h && m?.type === "ask_result" && m.id === h.id && m.decided?.source === "gemini" && !h.asked) {
        h.asked = true;
        if (down) return void setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "done", id: h.id, transcript: line, match: false, cached: true, budget: "depleted" }) })), 300);
        super.send(JSON.stringify({ type: "ask_text", id: h.id, text: h.text }));
      }
      if (down && m?.type === "ask_text") return void setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "done", id: m.id, transcript: line, match: false, cached: true, budget: "depleted" }) })), 300);
      return super.send(data);
    }
  };

  if (!probe) return;
  // Referee only: the real audio energy of everything the page plays (media elements and Web Audio), sampled every ~10 ms.
  const oc = AudioNode.prototype.connect;
  let mix, an, taps = new WeakMap(), seen = new WeakSet();
  const ensure = () => {
    if (mix) return;
    mix = new AudioContext();
    an = mix.createAnalyser();
    an.fftSize = 512;
    const mute = mix.createGain();
    mute.gain.value = 0;
    oc.call(oc.call(an, mute), mix.destination); // pulled by the destination, so the analyser always runs
    void mix.resume();
    const buf = new Float32Array(an.fftSize);
    let batch = [];
    setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (const v of buf) s += v * v;
      batch.push([Math.round(performance.timeOrigin + performance.now()), Math.round(10 * Math.log10(s / buf.length + 1e-12))]);
      if (batch.length >= 50) emit({ type: "energy", frame: window === top ? "page" : "video", samples: batch.splice(0) });
    }, 10);
  };
  AudioNode.prototype.connect = function (dest, ...r) {
    const out = oc.call(this, dest, ...r);
    try {
      if (dest instanceof AudioDestinationNode && this.context !== mix && this.context !== mc) {
        ensure();
        let t = taps.get(this.context);
        if (!t) {
          t = this.context.createMediaStreamDestination();
          oc.call(mix.createMediaStreamSource(t.stream), an);
          taps.set(this.context, t);
        }
        oc.call(this, t);
      }
    } catch {}
    return out;
  };
  const op = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    try {
      ensure();
      if (!seen.has(this) && this.captureStream) {
        seen.add(this);
        const s = this.captureStream();
        const add = (tr) => tr.kind === "audio" && oc.call(mix.createMediaStreamSource(new MediaStream([tr])), an);
        s.getAudioTracks().forEach(add);
        s.addEventListener("addtrack", (e) => add(e.track));
      }
    } catch {}
    return op.apply(this, arguments);
  };
}
