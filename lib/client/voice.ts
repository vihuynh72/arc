// Page-wide voice: one /ws/voice socket, one AudioContext, one thing playing at a time.
// say(text) resolves when playback ends or is stopped. prefetch(text) buffers without playing.
// Audio still streaming plays through Web Audio at 1x; complete audio plays through <audio> so
// speed 1 to 2 keeps pitch. Never uses speechSynthesis.
import { stopLine } from "@/lib/cues";
import type { Twin } from "@/lib/types";
import { b64ToPcm, wavBlob } from "./audio";

const RATE = 24000;

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
  heard(text: string): void;
  command(name: string, args: Record<string, unknown>): void;
  first(): void; // Gemini's first audio or command
}

let ws: WebSocket | undefined;
let outbox: string[] = [];
let context = "";
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
let paused = false;

function socket(): WebSocket {
  if (ws && ws.readyState <= WebSocket.OPEN) return ws;
  const s = (ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/voice`));
  s.onopen = () => {
    s.send(JSON.stringify({ type: "start", context }));
    for (const m of outbox) s.send(m);
    outbox = [];
  };
  s.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    const e = byId.get(m.id);
    if (e?.on && (m.type === "audio" || m.type === "command") && !e.chunks.length) e.on.first();
    if (m.type === "heard") return e?.on?.heard(m.text ?? "");
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
export function pageContext(twin: Twin, tourId: string | null): string {
  const first = (t: string) => t.split(/(?<=[.!?])\s+/)[0]?.slice(0, 240) ?? "";
  const lines = [`Title: ${twin.source.title}`];
  for (const n of twin.nodes) lines.push(n.kind === "figure" ? `${n.heading} (figure): ${n.text.slice(0, 300)}` : `${n.heading}: ${first(n.text)}`);
  const tour = twin.nodes.find((n) => n.id === tourId)?.tour;
  const tourText = tour ? `\n\nOPEN FIGURE TOUR: ${tour.title}. ${tour.overview}\n${tour.stops.map((_, i) => `Stop ${i + 1}: ${stopLine(tour.stops, i)}`).join("\n")}` : "";
  return lines.join("\n").slice(0, 6000 - tourText.length) + tourText;
}

/** Page text the question session answers from. */
export function setContext(text: string) {
  context = text;
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "start", context }));
}

export function prefetch(text: string) {
  if (text.trim()) request(text.trim());
}

/** Speaks text; resolves when it finishes or is stopped. */
export function say(text: string): Promise<void> {
  return play(request(text.trim()), `/api/speak?text=${encodeURIComponent(text.trim())}`);
}

/** Stops whatever is playing, at once. */
export function stop() {
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
  if (el) el.playbackRate = speed;
  return speed;
}
export const getSpeed = () => speed;
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
  stop();
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
  stop();
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
      else if (!e.failed) playEl(URL.createObjectURL(wavBlob(e.chunks, RATE)), speed, my, finish);
      else if (fallback) playEl(fallback, speed, my, finish); // local Kokoro voice
      else finish();
    };
    let used = 0;
    let at = 0;
    let streaming = false;
    function step() {
      if (my !== token) return e.wake.delete(step);
      if (!streaming && (e.done || e.failed || speed !== 1)) {
        if (e.done || (e.failed && !e.chunks.length)) return asFile();
        if (!e.failed) return; // speed-up waits for the whole clip
      }
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
