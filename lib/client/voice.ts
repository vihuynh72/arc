// Page-wide voice: one /ws/voice socket, one AudioContext, one thing playing at a time.
// say(text) resolves when playback ends or is stopped. prefetch(text) buffers without playing.
// Audio still streaming starts at once through Web Audio at 1x (speed never delays the first sound); complete audio
// plays through <audio> at the current speed with pitch kept. A figure tour has its own speed. Never uses speechSynthesis.
import { stopLine } from "@/lib/cues";
import type { Twin } from "@/lib/types";
import { b64ToPcm, wavBlob } from "./audio";

const RATE = 24000;

/** Set once /api/speak answers with x-arc-kokoro: off. The host has no local voice, so nothing asks it again this session. */
export const kokoro = { off: false };

interface Entry {
  id: string;
  key: string; // the text, or the ask id
  chunks: Int16Array[];
  done: boolean;
  failed: boolean;
  transcript?: string; // what Gemini said, once done
  wake: Set<() => void>;
  on?: AskHooks;
}

/** Push-to-talk callbacks: the caller decides (Snap first) before Gemini's answer or command is used. */
export interface AskHooks {
  heard(text: string, alternatives?: string[]): void;
  revised?(text: string, alternatives: string[]): void; // a better reading came after "heard" and differs
  command(name: string, args: Record<string, unknown>): void;
  first(): void; // Gemini's first audio or command
  partial?(text: string): void; // the whole transcript so far, while the key is still held
}

let ws: WebSocket | undefined;
let outbox: string[] = [];
let context = "";
let where = "";
let seq = 0;
const byKey = new Map<string, Entry>();
const byId = new Map<string, Entry>();

let ctx: AudioContext | undefined;
let el: HTMLAudioElement | undefined;
let sources: AudioBufferSourceNode[] = [];
let token = 0;
let endCurrent: (() => void) | undefined;
let playingId: string | undefined;
let speed = 1;
let tourSpeed = 1.25;
let touring = false;
const rate = () => (touring ? tourSpeed : speed);
let paused = false;

function socket(): WebSocket {
  if (ws && ws.readyState <= WebSocket.OPEN) return ws;
  const s = (ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/voice`));
  s.onopen = () => {
    s.send(JSON.stringify({ type: "start", context, where }));
    for (const m of outbox) s.send(m);
    outbox = [];
  };
  s.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    const e = byId.get(m.id);
    if (e?.on && (m.type === "audio" || m.type === "command") && !e.chunks.length) e.on.first();
    if (m.type === "heard") return e?.on?.heard(m.text ?? "", m.alternatives);
    if (m.type === "heard_revised") return e?.on?.revised?.(m.text ?? "", m.alternatives ?? []);
    if (m.type === "heard_partial") return e?.on?.partial?.(m.text ?? "");
    if (m.type === "command") {
      if (e?.on) return e.on.command(m.name, m.args ?? {});
      window.dispatchEvent(new CustomEvent("arc:command", { detail: { name: m.name, args: m.args } }));
      return;
    }
    if (m.type === "error") console.warn("[voice]", m.message);
    if (!e) return;
    if (m.type === "audio") e.chunks.push(b64ToPcm(m.data));
    if (m.type === "done") {
      e.done = true;
      e.transcript = m.transcript;
      if (!m.match) console.warn("[voice] spoken text differed from requested text", m.transcript);
    }
    if (m.type === "error") {
      e.failed = true;
      byKey.delete(e.key); // ask again next time
    }
    e.wake.forEach((f) => f());
  };
  s.onclose = () => {
    // Anything unfinished falls back; it is re-requested on the next say.
    for (const e of byId.values())
      if (!e.done && !e.failed) {
        e.failed = true;
        byKey.delete(e.key);
        e.wake.forEach((f) => f());
      }
    ws = undefined;
  };
  return s;
}

function send(m: object) {
  const s = socket();
  const data = JSON.stringify(m);
  if (s.readyState === WebSocket.OPEN) s.send(data);
  else outbox.push(data);
}

function entry(key?: string): Entry {
  const id = `v${++seq}`;
  const e: Entry = { id, key: key ?? id, chunks: [], done: false, failed: false, wake: new Set() };
  if (key) byKey.set(key, e);
  byId.set(id, e);
  return e;
}

function request(text: string): Entry {
  const hit = byKey.get(text);
  if (hit) return hit;
  const e = entry(text);
  send({ type: "say", id: e.id, text });
  return e;
}

/** Compact page text for the question session: title, headings with first sentences, captions, and an open tour. */
export function pageContext(twin: Twin, tourId: string | null = null): string {
  const first = (t: string) => t.split(/(?<=[.!?])\s+/)[0]?.slice(0, 240) ?? "";
  const lines = [`Title: ${twin.source.title}`];
  for (const n of twin.nodes) lines.push(n.kind === "figure" ? `${n.heading} (figure): ${n.text.slice(0, 300)}` : `${n.heading}: ${first(n.text)}`);
  const tourText = tourContext(twin, tourId);
  return lines.join("\n").slice(0, 6000 - tourText.length) + (tourText && `\n\n${tourText}`);
}

/** The open figure tour, for the volatile part of the question context. */
export function tourContext(twin: Twin, tourId: string | null): string {
  const tour = twin.nodes.find((n) => n.id === tourId)?.tour;
  return tour ? `OPEN FIGURE TOUR: ${tour.title}. ${tour.overview}\n${tour.stops.map((_, i) => `Stop ${i + 1}: ${stopLine(tour.stops, i)}`).join("\n")}` : "";
}

/** Page text the question session answers from: `page` is stable (a change reopens the session), `now` is where the
 * student is now (sent with the next question only). */
export function setContext(page: string, now = "") {
  const changed = page !== context;
  context = page;
  where = now;
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(changed ? { type: "start", context, where } : { type: "start", where }));
  else if (changed) socket(); // open the socket (and with it the question session) when a page loads
}

export function prefetch(text: string) {
  if (text.trim()) request(text.trim());
}

/** Speaks text; resolves when it finishes or is stopped. */
export function say(text: string): Promise<void> {
  return play(request(text.trim()), kokoro.off ? undefined : `/api/speak?text=${encodeURIComponent(text.trim())}`);
}

/** Stops whatever is playing, at once, and tells the relay to drop lines that were not finished. */
export function stop() {
  const p = playingId ? byId.get(playingId) : undefined;
  if (p && p.key !== p.id && !p.done && !p.failed) {
    // An unfinished line: the relay lets it finish on its own session and starts the next line at once.
    send({ type: "cancel", id: p.id });
    byKey.delete(p.key); // asked again next time (the relay's disk cache has it by then)
  }
  for (const e of byKey.values())
    if (!e.done && !e.failed && e.id !== playingId) {
      send({ type: "cancel", id: e.id }); // a prefetched line ahead of the new one must not hold the queue
      byKey.delete(e.key);
    }
  halt();
}

function halt() {
  token++;
  for (const s of sources) {
    s.onended = null;
    try {
      s.stop();
    } catch {}
  }
  sources = [];
  if (el) {
    el.onended = el.onerror = null;
    el.pause();
    el = undefined;
  }
  if (playingId && byId.get(playingId)?.key === playingId) send({ type: "cancel", id: playingId }); // ask answers only
  playingId = undefined;
  if (paused) ctx?.resume();
  paused = false;
  const end = endCurrent;
  endCurrent = undefined;
  end?.();
}

export function setSpeed(v: number) {
  speed = Math.min(2, Math.max(1, Math.round(v * 100) / 100));
  if (el && !touring) el.playbackRate = speed;
  return speed;
}
export const getSpeed = () => speed;
/** While a figure tour is open its lines play at the tour speed, kept apart from the reading voice's. */
export function setTouring(on: boolean) {
  touring = on;
}
/** The tour voice speed: 1 to 1.75 in steps of 0.25, 1.25 by default. */
export function setTourSpeed(v: number) {
  tourSpeed = Math.min(1.75, Math.max(1, Math.round(v * 4) / 4));
  if (el && touring) el.playbackRate = tourSpeed;
  return tourSpeed;
}
export const getTourSpeed = () => tourSpeed;
/** The Web Audio context state, for the localhost test hook. */
export const audioState = () => ctx?.state;

/** Pauses or resumes the current audio. Returns true when now paused. */
export function togglePause(): boolean {
  paused = !paused;
  if (paused) {
    el?.pause();
    ctx?.suspend();
  } else {
    el?.play().catch(() => {});
    ctx?.resume();
  }
  return paused;
}

function playEl(url: string, rate: number, my: number, done: () => void) {
  const a = (el = new Audio(url));
  a.preservesPitch = true;
  a.playbackRate = rate;
  const end = () => {
    if (my !== token) return;
    el = undefined;
    done();
  };
  const fail = () => {
    console.warn("[voice] could not play", url.slice(0, 80));
    end();
  };
  a.onended = end;
  a.onerror = fail;
  a.play().catch(fail);
}

/** Plays a sound file to the end (or until stop()). */
export function playUrl(url: string, rate = 1): Promise<void> {
  halt();
  const my = token;
  return new Promise((resolve) => {
    endCurrent = resolve;
    playEl(url, rate, my, () => {
      endCurrent = undefined;
      resolve();
    });
  });
}

export const chime = () => playUrl("/chime-a.wav");

function play(e: Entry, fallback?: string): Promise<void> {
  halt(); // not stop(): this line may be the prefetched one, which must not be cancelled
  const my = token;
  playingId = e.id;
  return new Promise<void>((resolve) => {
    endCurrent = resolve;
    const finish = () => {
      e.wake.delete(step);
      if (my !== token) return;
      endCurrent = undefined;
      playingId = undefined;
      resolve();
    };
    const asFile = () => {
      e.wake.delete(step);
      if (!e.failed && !e.chunks.length) finish(); // a command, no spoken answer
      else if (!e.failed) playEl(URL.createObjectURL(wavBlob(e.chunks, RATE)), rate(), my, finish);
      else if (fallback) playEl(fallback, rate(), my, finish); // local Kokoro voice
      else finish();
    };
    let used = 0;
    let at = 0;
    let streaming = false;
    function step() {
      if (my !== token) return e.wake.delete(step);
      // Buffered or cached: the whole clip at the current speed. Still arriving: stream now at 1x, never wait for speed.
      if (!streaming && (e.done || (e.failed && !e.chunks.length))) return asFile();
      if (!e.chunks.length && !e.failed) return; // nothing to play yet
      streaming = true;
      ctx ??= new AudioContext();
      if (ctx.state === "suspended" && !paused) ctx.resume();
      for (; used < e.chunks.length; used++) {
        const c = e.chunks[used];
        const buf = ctx.createBuffer(1, c.length, RATE);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < c.length; i++) ch[i] = c[i] / 0x8000;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        at = Math.max(at, ctx.currentTime + 0.05);
        src.start(at);
        at += buf.duration;
        sources.push(src);
        src.onended = () => {
          sources = sources.filter((s) => s !== src);
          if ((e.done || e.failed) && !sources.length && used === e.chunks.length) finish();
        };
      }
      if ((e.done || e.failed) && !sources.length) finish();
    }
    e.wake.add(step);
    step();
  });
}

// ---- push-to-talk ----

/** Starts a spoken question; returns its id. Audio chunks go through askAudio. */
export function askStart(on?: AskHooks): string {
  stop();
  const e = entry(); // ask answers are keyed by id, never reused
  e.on = on;
  send({ type: "ask_start", id: e.id });
  return e.id;
}
export const askAudio = (b64: string) => send({ type: "ask_audio", data: b64 });

/** Ends the question (the mic is closed). */
export const askEnd = () => send({ type: "ask_end" });
/** What the browser heard and did for an ask, for the relay's local log (.cache/asks). */
export const askResult = (r: { id: string; chrome?: string; decided: Record<string, unknown> }) => send({ type: "ask_result", ...r });

/** Drops Gemini's reply to a question: the relay stops sending it and it is never played. */
export const dropAnswer = (id: string) => send({ type: "cancel", id });

/** Plays the spoken answer to a question, if one comes; resolves when it ends. */
export function playAnswer(id: string): Promise<void> {
  const e = byId.get(id);
  return e ? play(e) : Promise.resolve();
}

/** Sends a typed question to the same question session a spoken one uses. Its command (if any) goes to onCommand; the spoken answer plays through playAnswer(id). */
export function askText(text: string, onCommand: AskHooks["command"]): string {
  stop();
  const e = entry();
  e.on = { heard() {}, first() {}, command: onCommand };
  send({ type: "ask_text", id: e.id, text });
  return e.id;
}

/** Resolves with the answer's transcript when the reply is complete, or null if the relay failed or stayed silent for `ms`. */
export function answerText(id: string, ms = 15000): Promise<string | null> {
  const e = byId.get(id);
  if (!e) return Promise.resolve(null);
  return new Promise((resolve) => {
    const finish = (v: string | null) => {
      clearTimeout(timer);
      e.wake.delete(check);
      resolve(v);
    };
    const check = () => {
      if (e.failed) finish(null);
      else if (e.done) finish(e.transcript ?? "");
    };
    const timer = setTimeout(() => {
      dropAnswer(id); // a late reply must not play over what comes next
      finish(null);
    }, ms);
    e.wake.add(check);
    check();
  });
}

let ticking: OscillatorNode | undefined;

/** A short quiet tick (default about 60 ms) on the page's AudioContext: pointer exploration marks the picture's edges with
 * it, and guided seeking repeats a softer, shorter one. One tick oscillator at a time: a new tick cuts the last. */
export function tick(hz: number, ms = 60, gain = 0.05) {
  if (paused) return;
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  const t = ctx.currentTime;
  try {
    ticking?.stop();
  } catch {}
  const o = (ticking = ctx.createOscillator());
  const g = ctx.createGain();
  o.frequency.value = hz;
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + ms / 1000);
}

/** A short soft tone (about 80 ms, quieter than the chime) whose pitch carries a chart value while the student scrubs. */
export function tone(hz: number, ms = 80) {
  if (paused) return;
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  const t = ctx.currentTime;
  const end = t + ms / 1000;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = "sine";
  o.frequency.value = hz;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.04, t + 0.015);
  g.gain.setValueAtTime(0.04, end - 0.03);
  g.gain.linearRampToValueAtTime(0, end);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(end + 0.01);
}
