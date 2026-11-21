// Page-wide voice: one /ws/voice socket, one AudioContext, one thing playing at a time.
// say(text) resolves when playback ends or is stopped. prefetch(text) buffers without playing.
// Audio still streaming starts at once through Web Audio at 1x (speed never delays the first sound); complete audio
// plays through <audio> at the current speed with pitch kept. A figure tour has its own speed. Never uses speechSynthesis.
import { stopLine } from "@/lib/cues";
import type { Twin, TwinNode } from "@/lib/types";
import { b64ToPcm, wavBlob } from "./audio";
import { heard } from "./heard";
import { postSpeak } from "./clip";
import { searchQuery } from "@/lib/intent";

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
  budget?: string; // the server refused for budget (lib/server/live.ts budgetLine): its recorded line is never played here
  said?: string[]; // the student's own words for this ask (typed, or every reading of what was heard): model commands are checked against them
}

/** Push-to-talk callbacks: the caller decides (Decision first) before Gemini's answer or command is used. */
export interface AskHooks {
  heard(text: string, alternatives?: string[]): void;
  revised?(text: string, alternatives: string[]): void; // a better reading came after "heard" and differs
  command(name: string, args: Record<string, unknown>): void;
  first(): void; // Gemini's first audio or command
  partial?(text: string): void; // the whole transcript so far, while the key is still held
  failed?(): void; // the relay or Live dropped before the answer: the audio sent so far is not the whole request
}

let ws: WebSocket | undefined;
let budgetAt = 0; // when the server last refused for budget
/** When the server last refused a line or a question for budget (0: never this session). */
export const budgetSeen = () => budgetAt;
// What Arc's reading voice said lately (lib/client/heard.ts events), for the question context: the last five minutes.
const spoken: { text: string; at: number }[] = [];
if (typeof window !== "undefined")
  window.addEventListener("arc:heard", (e) => {
    const d = (e as CustomEvent<{ kind: string; voice?: string; text?: string; phase?: string }>).detail;
    if (d?.kind !== "speech" || d.voice !== "arc" || d.phase !== "start" || !d.text || d.text.length < 30) return; // page words, not "Speed 1.2."
    if (spoken.at(-1)?.text === d.text) return;
    spoken.push({ text: d.text, at: Date.now() });
    while (spoken.length && (spoken.length > 40 || Date.now() - spoken[0].at > 5 * 60_000)) spoken.shift();
  });
// The last question-session exchange (typed or spoken), and the student's own words of the last few asks.
let exchange: { q: string; a: string; at: number } | undefined;
let asked: { words: string; at: number }[] = [];
/** The last answer or question from the question session, while no page reading has started since. */
export const lastExchange = () => (exchange && !spoken.some((x) => x.at > exchange!.at) ? exchange : undefined);
/** The student's words in the last five minutes of asks: a reply ("yes, a book chapter") may search with words said before it. */
const recentWords = () => asked.filter((x) => Date.now() - x.at < 5 * 60_000).map((x) => x.words);
/** The page words read aloud in the last five minutes, oldest first. */
export const recentlyRead = () => spoken.filter((x) => Date.now() - x.at < 5 * 60_000).map((x) => x.text).join(" ");

/** The open page, as Twin last handed it over (pageContext, tourContext): command.ts reads its nodes for find and "how long". */
let twinNow: Twin | undefined;
export const currentTwin = () => twinNow;
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
    // A refusal for budget ("done" with the recorded line, or "error"): the reader stops reading ahead (arc:budget), and the
    // recorded line is not played: lib/client/command.ts says one plain line of its own, once, then short ones.
    if ((m.type === "done" || m.type === "error") && m.budget) {
      budgetAt = Date.now();
      // An answer: the notice is said now. A line (a tour stop) says it only if the local voice cannot read the line instead
      // (play, below): read by the local voice, the student loses nothing, and a notice per stop would talk over the tour.
      if (!e || e.key === e.id) window.dispatchEvent(new CustomEvent("arc:budget", { detail: { say: String(m.say ?? m.transcript ?? ""), code: m.budget } }));
      if (!e) return;
      e.budget = String(m.say ?? m.transcript ?? m.budget);
      e.chunks = [];
      e.failed = true;
      byKey.delete(e.key);
      if (playingId === e.id && e.key === e.id) halt(); // an answer: its first chunks are scheduled 50 ms ahead, so nothing was heard
      e.wake.forEach((f) => f());
      return;
    }
    if (e?.on && (m.type === "audio" || m.type === "command") && !e.chunks.length) e.on.first();
    if ((m.type === "heard" || m.type === "heard_revised") && e) e.said = [...(e.said ?? []), String(m.text ?? ""), ...(Array.isArray(m.alternatives) ? m.alternatives.map(String) : [])];
    if (m.type === "heard" && m.text) asked = [...asked, { words: String(m.text), at: Date.now() }].slice(-4);
    if (m.type === "heard") {
      if (m.id === pendingHeard) flushAsk();
      return e?.on?.heard(m.text ?? "", m.alternatives);
    }
    if (m.type === "heard_revised") return e?.on?.revised?.(m.text ?? "", m.alternatives ?? []);
    if (m.type === "heard_partial") return e?.on?.partial?.(m.text ?? "");
    if (m.type === "command") {
      // Every command from the question session is made by the model, which read the page: one that leaves the page is checked first.
      let args = modelCommand(String(m.name), m.args ?? {}, twinNow, [...(e?.said ?? []), ...recentWords()]);
      // A model-made search with words she did not say: her own words are searched instead, so a search she asked for still runs
      // (and is announced like any other); never silence after "I'm fetching that".
      const own = !args && m.name === "search" && !twinNow?.source.private ? searchQuery((e?.said ?? [])[0] ?? "") : undefined;
      if (own) args = { query: own };
      if (!args) return void console.warn(`[voice] dropped a model-made ${String(m.name).slice(0, 20)}: not something the student asked for`);
      if (e?.on) return e.on.command(m.name, args);
      window.dispatchEvent(new CustomEvent("arc:command", { detail: { name: m.name, args } }));
      return;
    }
    if (m.type === "error") console.warn("[voice]", m.message);
    if (m.type === "error" && e?.on && !e.done) e.on.failed?.();
    if (!e) return;
    if (m.type === "audio") e.chunks.push(b64ToPcm(m.data));
    if (m.type === "done") {
      e.done = true;
      e.transcript = m.transcript;
      if (e.key === e.id && e.said?.[0] && m.transcript) exchange = { q: e.said[0], a: String(m.transcript), at: Date.now() }; // an ask's answer
      if (!m.match) console.warn("[voice] spoken text differed from requested text", m.transcript);
    }
    if (m.type === "error") {
      e.failed = true;
      byKey.delete(e.key); // ask again next time
    }
    e.wake.forEach((f) => f());
  };
  s.onclose = () => {
    heldAsk = [];
    pendingHeard = undefined; // a new connection never saw the held frames: the asks they belonged to are reported failed below
    // Anything unfinished falls back; it is re-requested on the next say.
    for (const e of byId.values())
      if (!e.done && !e.failed) {
        e.failed = true;
        byKey.delete(e.key);
        e.on?.failed?.();
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

export const PRIVATE_PAGE = "PRIVATE PAGE: from the student's own account.";

// ---- model-made commands that leave the page (prompt injection: a page's text can ask the model to open or search) ----
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter(Boolean);
/** Address-shaped tokens of what the student said or typed ("example dot com" counts), without scheme, www or trailing marks. */
const addresses = (s: string) => s.toLowerCase().replace(/\s+dot\s+/g, ".").split(/[\s<>"']+/).map(bare).filter((w) => w.length >= 4 && w.includes("."));
const bare = (u: string) => u.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#.,!;:)]+$/, "");
const FILLER = new Set("a an the of in on for about and to me please".split(" "));
const MAX_QUERY = 120; // a search the student said is a few words; a paragraph lifted from the page is not
/**
 * The args a model-made command may run with, or null to drop it. `open` runs only for an address the student could have meant:
 * a link of the open page, a numbered result (`result`: the list on screen, which the page itself builds), or one in the
 * student's own words. `search` runs only with the student's own words (the model may drop words, never add page text). On a
 * private page neither runs (lib/server/live.ts does not offer them there either). Other commands move within the page.
 */
export function modelCommand(name: string, args: Record<string, unknown>, twin: Twin | undefined, said: string[]): Record<string, unknown> | null {
  if (name !== "open" && name !== "search") return args;
  if (twin?.source.private) return null;
  const heard = said.join(" ");
  if (name === "open") {
    if (typeof args.result === "number" && Number.isInteger(args.result) && args.result >= 1 && args.result <= 99) return { id: `r${String(args.result).padStart(2, "0")}` };
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (!url || url.length > 2000) return null;
    if (twin?.links?.some((l) => l.url === url)) return { url };
    return addresses(heard).includes(bare(url)) ? { url } : null; // the whole address, said or typed
  }
  const q = typeof args.query === "string" ? args.query.trim() : "";
  if (!q || q.length > MAX_QUERY || /https?:|www\.|[\w-]{31,}/i.test(q)) return null;
  const mine = new Set(words(heard));
  const joined = new Set(words(heard).flatMap((w, i, a) => (a[i + 1] ? [w + a[i + 1]] : []))); // "photo synthesis" heard, "photosynthesis" searched
  return words(q).every((w) => mine.has(w) || joined.has(w) || FILLER.has(w)) ? { query: q } : null;
}

/** Compact page text for the question session: title, headings with first sentences, captions, and an open tour. */
export function pageContext(twin: Twin, tourId: string | null = null): string {
  if (!twinNow || twinNow.id !== twin.id || twin.nodes.length >= twinNow.nodes.length) twinNow = twin; // a PDF's first-pages copy never replaces the whole one
  const first = (t: string) => t.split(/(?<=[.!?])\s+/)[0]?.slice(0, 240) ?? "";
  const lines = [`Title: ${twin.source.title}`];
  // A page from the student's own account (lib/server/live.ts keeps such sessions out of its local logs), and a quiz or test
  // being taken (the session reads and navigates but never answers its questions: ASKER_RULE).
  if (twin.source.assessment) lines.unshift("ASSESSMENT: the student is taking this quiz or test.");
  if (twin.source.private) lines.push(PRIVATE_PAGE);
  // Subsections are indented one step per level below the top, so "the methods, the second part" can be placed.
  // A private page's first section is given whole (up to 500 characters): course pages put their facts there (due date, how to hand in).
  twin.nodes.forEach((n, i) => lines.push(n.kind === "figure" ? `${n.heading} (figure): ${n.text.slice(0, 300)}` : `${"  ".repeat(Math.min(Math.max((n.level ?? 2) - 2, 0), 2))}${n.heading}: ${twin.source.private && i === 0 ? n.text.slice(0, 500) : first(n.text)}`));
  const tourText = tourContext(twin, tourId);
  // The page's own navigation, so "open week 3" or "the next page" can name a real address.
  const links = (twin.links ?? []).slice(0, 40).map((l) => `${l.rel === "next" ? "Next page: " : l.rel === "prev" ? "Previous page: " : ""}${l.label} <${l.url}>`);
  const nav = links.length ? `\n\nLINKS ON THIS PAGE (to open one, call open with its address):\n${links.join("\n")}` : "";
  return lines.join("\n").slice(0, 6000 - tourText.length - Math.min(nav.length, 2500)) + nav.slice(0, 2500) + (tourText && `\n\n${tourText}`);
}

const toured = new Set<string>(); // figures whose tour the student opened this session: questions about them see the tour too
/** What a figure's tour said, marked as coming from the picture (the page text does not hold it). */
const pictureLines = (n: TwinNode) =>
  n.tour ? `FROM THE PICTURE ${n.heading} (Arc's tour of the image, not the page text): ${n.tour.overview} ${n.tour.stops.map((s, i) => `Stop ${i + 1}, ${s.label}: ${s.says}`).join(" ")}` : "";

/** The open figure tour, for the volatile part of the question context. */
export function tourContext(twin: Twin, tourId: string | null): string {
  twinNow = twin; // called with the whole twin each time the student moves
  if (tourId) toured.add(tourId);
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
  return play(request(text.trim()), kokoro.off ? undefined : () => kokoroClip(text.trim()));
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
/** True while a spoken line or a question's answer is playing (the video player waits on this before it resumes). */
export const answering = () => playingId !== undefined;

/** Pauses or resumes the current audio. Returns true when now paused. */
export function togglePause(): boolean {
  paused = !paused;
  if (playingId || el) heard({ kind: "pause", on: paused });
  if (paused) {
    el?.pause();
    ctx?.suspend();
  } else {
    el?.play().catch(() => {});
    ctx?.resume();
  }
  return paused;
}

function playEl(url: string, rate: number, my: number, done: () => void, onStart?: () => void) {
  const a = (el = new Audio(url));
  a.onplaying = () => ((a.onplaying = null), onStart?.()); // once: a resume after P fires "playing" again
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
  return a;
}

/** Plays a sound file to the end (or until stop()). */
export function playUrl(url: string, rate = 1, name = "chime"): Promise<void> {
  halt();
  const my = token;
  return new Promise((resolve) => {
    endCurrent = resolve;
    playEl(url, rate, my, () => {
      endCurrent = undefined;
      resolve();
    }, () => heard({ kind: "sound", name }));
  });
}

export const chime = (name = "chime") => playUrl("/chime-a.wav", 1, name);

/** The local voice's clip for the fallback: asked by POST, so the sentence is not in a URL. */
const kokoroClip = (text: string) => postSpeak(text).then((r) => (r.status === 200 ? r.blob().then((b) => URL.createObjectURL(b)) : null), () => null);

/** Soft repeating tone while something is being made or fetched. Returns a stop function. */
export function startWaitTone(): () => void {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return () => {};
  const ctx = new Ctx();
  const beep = () => {
    heard({ kind: "sound", name: "wait-tone" });
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 440;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.04, t + 0.08);
    gain.gain.linearRampToValueAtTime(0, t + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.5);
  };
  beep();
  const timer = setInterval(beep, 1500);
  return () => {
    clearInterval(timer);
    void ctx.close();
  };
}

// Watchdog for the second voice (a line, not a question's answer): no sound after TONE_MS, the waiting tone; none after
// GIVE_UP_MS, the line is dropped from the relay and the local voice says it; nothing at all after DEAD_MS, it is abandoned so
// the next request proceeds. A stream that stops mid-line without its end is closed after STALL_MS. An answer gets ANSWER_MS.
// Exported for scripts/checks/voicewatch.ts.
// After one line fell back, the next ones fall back sooner for a while (SOON_MS after RECENT_MS): the relay is likely still stuck.
export const WATCH = { TONE_MS: 1200, GIVE_UP_MS: 3500, SOON_MS: 900, RECENT_MS: 30_000, DEAD_MS: 9000, STALL_MS: 4000, ANSWER_MS: 25_000 };
/** What the watchdog does after `ms` of no sound (paused time not counted): nothing, the tone, the fallback voice, or give up. */
export function watchStep(ms: number, line: boolean, tone: boolean, fellBack: boolean, recent = false): "wait" | "tone" | "fallback" | "abandon" {
  if (!line) return ms >= WATCH.ANSWER_MS ? "abandon" : "wait";
  if (ms >= WATCH.DEAD_MS) return "abandon";
  if (ms >= (recent ? WATCH.SOON_MS : WATCH.GIVE_UP_MS) && !fellBack) return "fallback";
  if (ms >= WATCH.TONE_MS && !tone) return "tone";
  return "wait";
}

let fellAt = -1e9; // when a line last fell back to the local voice
function play(e: Entry, fallback?: () => Promise<string | null>): Promise<void> {
  halt(); // not stop(): this line may be the prefetched one, which must not be cancelled
  const my = token;
  playingId = e.id;
  // heard: which voice is audible (set when its sound starts), the element playing it, and the streamed audio's span.
  let voice: "arc" | "gemini" | undefined, a: HTMLAudioElement | undefined, t0 = 0;
  const tell = (phase: "start" | "end" | "cut", frac?: number, t?: number) => voice && heard({ kind: "speech", voice, text: e.key !== e.id ? e.key : (e.transcript ?? ""), phase, frac }, t);
  let toneOff: (() => void) | undefined;
  const quiet = () => (toneOff?.(), (toneOff = undefined));
  const begin = (v: "arc" | "gemini", t?: number) => () => (quiet(), (voice = v), tell("start", undefined, t));
  return new Promise<void>((resolve) => {
    let waited = 0;
    let fellBack = false;
    let lastChunk = 0;
    const line = e.key !== e.id;
    const watch = setInterval(() => {
      if (my !== token) return void (clearInterval(watch), quiet());
      if (paused) return;
      const now = performance.now();
      if (voice) {
        // Streaming, every chunk played, no more coming and no end: the relay went quiet mid-line.
        if (streaming && !e.done && !e.failed && !sources.length && lastChunk && now - lastChunk > WATCH.STALL_MS) finish();
        return;
      }
      waited += 250;
      const s = watchStep(waited, line, !!toneOff, fellBack || !!a, now - fellAt < WATCH.RECENT_MS); // a clip already handed to <audio> is not replaced
      if (s === "tone") toneOff = startWaitTone();
      else if (s === "fallback") {
        fellBack = true;
        fellAt = now;
        console.warn("[voice] no sound from the second voice: the local voice says it", e.key.slice(0, 60));
        e.wake.delete(step);
        send({ type: "cancel", id: e.id });
        byKey.delete(e.key); // asked again next time
        if (fallback) void fallback().then((u) => (my !== token || voice ? undefined : u ? (a = playEl(u, rate(), my, finish, begin("arc"))) : finish()));
        else finish();
      } else if (s === "abandon") {
        console.warn("[voice] a line never started: abandoned", e.key.slice(0, 60));
        if (!line) dropAnswer(e.id);
        halt(); // resolves this play: nothing waits on it any more
      }
    }, 250);
    endCurrent = () => (clearInterval(watch), quiet(), tell("cut", a ? a.currentTime / a.duration : ctx && at > t0 ? (ctx.currentTime - t0) / (at - t0) : undefined), resolve());
    const finish = () => {
      e.wake.delete(step);
      if (my !== token) return;
      clearInterval(watch);
      quiet();
      tell("end");
      endCurrent = undefined;
      playingId = undefined;
      resolve();
    };
    // No voice at all for a line refused for budget: now the notice is due (components/Reader.tsx says it).
    const unsaid = () => {
      if (e.budget) window.dispatchEvent(new CustomEvent("arc:budget", { detail: { say: e.budget } }));
      finish();
    };
    const asFile = () => {
      e.wake.delete(step);
      if (!e.failed && !e.chunks.length) finish(); // a command, no spoken answer
      else if (!e.failed) a = playEl(URL.createObjectURL(wavBlob(e.chunks, RATE)), rate(), my, finish, begin("gemini"));
      else if (fallback)
        void fallback().then((u) => (my !== token ? undefined : u ? (a = playEl(u, rate(), my, finish, begin("arc"))) : unsaid())); // local Kokoro voice
      else unsaid();
    };
    let used = 0;
    let at = 0;
    let streaming = false;
    function step() {
      if (my !== token) return e.wake.delete(step);
      // Refused for budget after the server's recorded notice began to sound: that recording is not this line. It is cut, and the
      // local voice says the line (asFile). Before this the play never ended (its chunk count could no longer match), so a tour hung.
      if (e.budget && streaming) {
        for (const src of sources) {
          src.onended = null;
          src.stop();
        }
        sources = [];
        tell("cut", 0);
        voice = undefined;
        streaming = false;
        fellBack = true; // the watchdog must not start a second local clip
      }
      // Buffered or cached: the whole clip at the current speed. Still arriving: stream now at 1x, never wait for speed.
      if (!streaming && (e.done || (e.failed && !e.chunks.length))) return asFile();
      if (!e.chunks.length && !e.failed) return; // nothing to play yet
      streaming = true;
      ctx ??= new AudioContext();
      if (ctx.state === "suspended" && !paused) ctx.resume();
      if (used < e.chunks.length) lastChunk = performance.now();
      for (; used < e.chunks.length; used++) {
        const c = e.chunks[used];
        const buf = ctx.createBuffer(1, c.length, RATE);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < c.length; i++) ch[i] = c[i] / 0x8000;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        at = Math.max(at, ctx.currentTime + 0.05);
        if (!voice) begin("gemini", performance.now() + (at - ctx.currentTime) * 1000)(), (t0 = at); // audible when the first chunk starts
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
let askWs: WebSocket | undefined; // the relay connection the open ask started on
// The relay keeps one ask at a time and its transcripts carry no ask id: a second ask that starts before the first one's
// words are back would be given them. So the second ask's frames wait (about 0.25 s) until "heard" for the first is in.
let pendingHeard: string | undefined; // the last ended ask whose "heard" has not come back
let heldAsk: object[] = [];
let heardTimer: ReturnType<typeof setTimeout> | undefined;
function flushAsk() {
  pendingHeard = undefined;
  clearTimeout(heardTimer);
  while (heldAsk.length && !pendingHeard) {
    const m = heldAsk.shift() as { type: string; id?: string };
    send(m);
    if (m.type === "ask_end") waitHeard(m.id!);
  }
}
function waitHeard(id: string) {
  pendingHeard = id;
  clearTimeout(heardTimer);
  heardTimer = setTimeout(flushAsk, 3000); // never wait longer than this for a transcript that is not coming
}
const askSend = (m: object) => void (pendingHeard ? heldAsk.push(m) : send(m));
export function askStart(on?: AskHooks): string {
  stop();
  const e = entry(); // ask answers are keyed by id, never reused
  e.on = on;
  askSend({ type: "ask_start", id: e.id });
  askWs = ws;
  return e.id;
}
// After a reconnect the new relay connection never saw ask_start: the rest of that ask's audio is dropped, not sent as
// a stray fragment (the ask is reported failed by the close, and the student is asked to say it again).
export const askAudio = (b64: string) => void (ws === askWs && askSend({ type: "ask_audio", data: b64 }));

/** Ends the question (the mic is closed). The id keeps a late end from closing a newer ask. */
export function askEnd(id: string) {
  if (ws !== askWs) return;
  const held = !!pendingHeard;
  askSend({ type: "ask_end", id });
  if (!held) waitHeard(id);
}
/** What the browser heard and did for an ask, for the relay's local log (.cache/asks). */
export const askResult = (r: { id: string; chrome?: string; decided: Record<string, unknown> }) => send({ type: "ask_result", ...r });

/** The refusal line when the server refused this ask for budget, else undefined. */
export const budgetOf = (id: string) => byId.get(id)?.budget;

/** Drops a question's answer and, if it is playing, stops it: the student has moved on to something else. */
export function stopAnswer(id: string) {
  if (playingId === id) halt();
  dropAnswer(id);
}

/** Where the student is now, for the next question only (the stable page text stays as it is). */
export function setWhere(now: string) {
  where = now;
  send({ type: "start", where });
}

/** True when some of this answer's sound arrived (an answer with no transcript may still have been heard). */
export const answerSounded = (id: string) => (byId.get(id)?.chunks.length ?? 0) > 0;

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
  e.said = [text];
  asked = [...asked, { words: text, at: Date.now() }].slice(-4);
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
  heard({ kind: "sound", name: "tick", hz });
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
  heard({ kind: "sound", name: "tone", hz });
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

const QSTOP = new Set("the a an of to and in on for is are was were be it this that what which who how why when where does do did can could would should with from by as at or about into its their there these those has have had will than then so not no yes me my i you your we our they them he she his her page paper part section tell say said author authors study article mention mentions mentioned".split(" "));
// shortcut: a word's first six letters stand for it ("accurate" and "accuracy" meet); a real stemmer if odd matches show up.
const qroot = (w: string) => w.replace(/(?<=\w{3})(?:ies|es|s)$/, "").replace(/(?<=\w{4})(?:ing|ed)$/, "").slice(0, 6);
// A question's words that a paper says another way ("what will they do next": "future work").
const QALSO: Record<string, string[]> = { next: ["future"], plan: ["future"], later: ["future"], cost: ["price", "cheap", "effective"], price: ["cost"], fast: ["speed", "time"], accurate: ["accuracy"], better: ["improve", "outperform"], problem: ["limitation", "challenge"], weakness: ["limitation"] };
const qwords = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !QSTOP.has(w)).map(qroot);
const askWords = (s: string) => {
  const raw = s.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").split(/\s+/);
  return [...qwords(s), ...raw.flatMap((w) => QALSO[w] ?? []).map(qroot)];
};

/**
 * The page text a question is answered from, at most `limit` characters, most useful first: the title, the section under the
 * cursor (whole), the sections whose words the question shares (scored locally: each shared word counts, a heading word three
 * times), then the outline. The stable page text (pageContext) keeps only first sentences, so a fact in the middle of a section
 * ("the belt unit" in 2.1 Hardware) was lost to it.
 */
export function questionContext(twin: Twin, question: string, cursorId?: string | null, limit = 12000, recent = ""): string {
  // Sections: a heading node with the PDF paragraphs under it; a figure on its own.
  const groups: { head: TwinNode; text: string }[] = [];
  for (const n of twin.nodes) {
    const para = n.page != null && n.kind === "section" && !n.level;
    if (para && groups.length) groups[groups.length - 1].text += `\n${n.text}`;
    else groups.push({ head: n, text: n.page != null && n.level ? "" : n.text }); // a PDF heading node's text is its heading
  }
  const q = new Set(askWords(question));
  // A word few sections use says more than one they all use ("future" against "study"): each of the question's words counts by
  // how rare it is on this page, up to three uses a section, and three more when the heading has it.
  const bags = groups.map((g) => qwords(g.text));
  const rare = new Map([...q].map((w) => [w, Math.log(1 + groups.length / (1 + bags.filter((b) => b.includes(w)).length))]));
  const score = (g: (typeof groups)[number], k: number) => {
    const head = qwords(g.head.heading);
    let s = 0;
    for (const w of q) s += (Math.min(3, bags[k].filter((x) => x === w).length) + (head.includes(w) ? 3 : 0)) * (rare.get(w) ?? 0);
    return s;
  };
  // the group holding the cursor: the last group starting at or before the cursor's node
  const at = cursorId ? twin.nodes.findIndex((n) => n.id === cursorId) : -1;
  let mine = -1;
  if (at >= 0) groups.forEach((g, k) => void (twin.nodes.indexOf(g.head) <= at && (mine = k)));
  const outline = `OUTLINE: ${twin.nodes.filter((n) => n.kind === "figure" || n.level).map((n) => n.heading).join("; ")}`.slice(0, 1200);
  // The paper's own details (authors, year, journal: a "Details" or "About this copy" block, else the credit line), always.
  const details = twin.nodes.find((n) => /^(?:details|about this (?:copy|page))\b/i.test(n.heading.trim()));
  const head = `Title: ${twin.source.title}${details ? `\nDETAILS OF THIS DOCUMENT: ${details.text.slice(0, 700)}` : twin.source.credit ? `\nDETAILS OF THIS DOCUMENT: ${twin.source.credit.slice(0, 400)}` : ""}`;
  // Tours of figures near the cursor, of any figure the student toured, and of the two whose tours share the most of the
  // question's words (a fact only the picture shows): what a tour said, an answer must not deny. Its own room, 1,500 at most.
  const shared = (n: TwinNode) => (n.tour ? qwords(`${n.tour.overview} ${n.tour.stops.map((x) => `${x.label} ${x.says}`).join(" ")}`).filter((w) => q.has(w)).length : 0);
  const mineTours = twin.nodes.filter((n, k) => n.tour && ((at >= 0 && Math.abs(k - at) <= 3) || toured.has(n.id)));
  const best = twin.nodes.filter((n) => shared(n) > 0).sort((a, b) => shared(b) - shared(a)).slice(0, 2);
  const pics = [...new Set([...mineTours, ...best])].map(pictureLines).join("\n\n").slice(0, 1500);
  const room = limit - outline.length - head.length - 120 - pics.length;
  const parts: string[] = [];
  let used = 0;
  // Each part is capped, so several sections fit: the cursor's to 1,800 characters, the best relevant one to 2,400 and the others to 1,400, around their best words.
  const add = (label: string, g: (typeof groups)[number], cap: number) => {
    let text = g.text;
    if (text.length > cap && q.size) {
      const sents = text.split(/(?<=[.!?])\s+/);
      const hits = sents.map((x) => [...new Set(qwords(x))].reduce((a, w) => a + (rare.get(w) ?? 0), 0)); // the sentence with the telling words, not the common ones
      const best = hits.indexOf(Math.max(...hits));
      text = sents.slice(Math.max(0, best - 2)).join(" ");
    }
    const body = `${label}${g.head.heading}${g.head.kind === "figure" ? " (figure)" : ""}: ${text}`.replace(/\s+\n/g, "\n").slice(0, cap);
    const take = body.slice(0, Math.max(0, room - used));
    if (take.length < 80) return false;
    parts.push(take);
    used += take.length + 2;
    return true;
  };
  if (recent) {
    // What Arc read aloud lately: a question right after "average accuracy of 97.4%" is about that.
    const r = `READ ALOUD TO THE STUDENT IN THE LAST FEW MINUTES (newest last): ${recent}`.slice(-Math.min(1800, room));
    parts.push(r);
    used += r.length + 2;
  }
  if (mine >= 0) add("THE SECTION THE STUDENT IS IN: ", groups[mine], 1800);
  if (pics) parts.push(pics); // its room was set aside above
  const ranked = groups.map((g, k) => ({ g, k, s: score(g, k) })).filter((x) => x.s > 0 && x.k !== mine).sort((a, b) => b.s - a.s || a.k - b.k);
  ranked.forEach((x, k) => void (used < room && add("RELEVANT: ", x.g, k ? 1400 : 2400))); // the best one has more room
  return [head, ...parts, outline].join("\n\n");
}
