// The browser's own Kokoro (af_bella), for reader.ts when the server has no Kokoro (a small host). Off until the server says
// "x-arc-browser-voice: on"; the model downloads only after the first key or click, never on a save-data connection, and the
// server voice reads meanwhile. Reader asks pick() once per block (the voice never changes inside one): local only when the
// whole block can be made in time for gapless playback; a clip that is late anyway, or fails, hands the rest of the block to the server. Never speechSynthesis. The decision logic is pure and checked offline
// (scripts/checks/localVoice.ts).
import { primary, scriptLang } from "@/lib/parse/lang";

export const LIMITS = {
  firstMs: 1500, // the block's first clip (the hosted server voice measured 2.5 to 3.2 s to its first sound)
  gapMs: 400, // a later clip this late is a miss (heard as a gap)
  hardMs: 1200, // a later clip this late: the server reads the rest of the block
  misses: 3, // misses before the server reads for the rest of the session
};
export type Status = "off" | "idle" | "loading" | "ready";
export interface State {
  status: Status;
  rtf: number; // seconds of compute per second of audio, measured on this machine
  misses: number;
}
type Item = { text: string; lang?: string };

/** The server's Kokoro would read this in its English voice (app/api/speak's rule): the only text read locally. */
export const english = (c: Item) => {
  const l = primary(c.lang) ?? scriptLang(c.text);
  return !l || l === "en";
};
/** Seconds of af_bella audio at 1x for a text (measured: 10 characters 2.2 s, 113 characters 8.3 s). */
export const seconds = (text: string) => 0.5 + text.length / 14;
/** Whether one after another, clips made serially (rtf, `made` ones already done) keep up with playback at this speed:
 * the first within firstMs, each later one ready within gapMs of the previous one ending. */
export function fits(texts: string[], rtf: number, rate: number, made: (t: string) => boolean = () => false): boolean {
  let ready = 0; // ms after the block starts
  let end = 0;
  for (let k = 0; k < texts.length; k++) {
    if (!made(texts[k])) ready += rtf * seconds(texts[k]) * 1000;
    if (k === 0 ? ready > LIMITS.firstMs : ready - end > LIMITS.gapMs) return false;
    end = Math.max(end, ready) + (seconds(texts[k]) * 1000) / rate;
  }
  return true;
}
/** Which voice reads a block: decided once, before its first clip. */
export const pick = (s: State, items: Item[], rate: number, made?: (t: string) => boolean): "local" | "server" =>
  s.status === "ready" && s.misses < LIMITS.misses && items.length > 0 && items.every(english) && fits(items.map((c) => c.text), s.rtf, rate, made) ? "local" : "server";
/** How long the reader waits for local clip i before the server takes over. */
export const patience = (i: number) => (i === 0 ? LIMITS.firstMs : LIMITS.hardMs);
/** A clip made slower than real time: this machine cannot keep up, and local reading ends for the session. */
export const tooSlow = (m: { ms: number; seconds: number }) => m.ms / 1000 > m.seconds;
/** After the reader waited for clip i (got: it came in time): the state that follows. */
export function after(s: State, waitedMs: number, i: number, got: boolean): State {
  const late = !got || waitedMs > (i === 0 ? LIMITS.firstMs : LIMITS.gapMs);
  const misses = s.misses + (late ? 1 : 0);
  return { ...s, misses, status: misses >= LIMITS.misses ? "off" : s.status };
}
/** May the model download now: the server allows it, the student has pressed something, and the connection is not saving data. */
export const mayLoad = (o: { allowed: boolean; gesture: boolean; saveData?: boolean; effectiveType?: string }) =>
  o.allowed && o.gesture && !o.saveData && !["slow-2g", "2g"].includes(o.effectiveType ?? "");

// ---- the browser side ----
const state: State = { status: "off", rtf: 1, misses: 0 };
let gesture = false;
let worker: Worker | undefined;
let seq = 0;
const pending = new Map<number, { done: (b: Blob | null) => void; text: string }>();
const made = new Map<string, Blob>(); // finished clips by text, so "say that again" makes nothing new
const keep = (t: string, b: Blob) => (made.delete(t), made.set(t, b), made.size > 40 && made.delete(made.keys().next().value!));

function stop(why: string) {
  if (state.status === "off") return;
  state.status = "off";
  console.warn("[arc-voice] browser voice off:", why);
  for (const p of pending.values()) p.done(null);
  pending.clear();
  worker?.terminate();
  worker = undefined;
}

function load() {
  if (state.status !== "idle" || !gesture) return;
  const c = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (!mayLoad({ allowed: true, gesture, saveData: c?.saveData, effectiveType: c?.effectiveType })) return;
  state.status = "loading";
  void (async () => {
    // WebGPU fp32 only. Measured in Chrome on an M5 Mac (seconds of compute per second of audio): WebGPU fp32 0.13, and its
    // audio matches the server's Kokoro sample for sample; WebGPU fp16 and q4f16 are as fast but speak garbage; q8 1.4 (WebGPU)
    // and 1.5 (WASM), WASM fp32 1.2: slower than real time on one thread (threads need cross-origin isolation, which would
    // break the YouTube player and pictures from other sites). Without WebGPU nothing downloads and the server keeps reading.
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!(await gpu?.requestAdapter().catch(() => null))) return stop("no WebGPU");
    try {
      worker = new Worker(new URL("./localVoice.worker.ts", import.meta.url), { type: "module" });
    } catch (e) {
      return stop(String(e));
    }
    worker.onerror = (e) => stop(e.message || "worker error");
    worker.onmessage = (e: MessageEvent<{ type: string; id?: number; wav?: ArrayBuffer; seconds?: number; ms?: number; rtf?: number; error?: string }>) => {
      const m = e.data;
      if (m.type === "ready") return void ((state.rtf = m.rtf!), (state.status = "ready"), console.info(`[arc-voice] browser voice ready, rtf ${m.rtf!.toFixed(2)}`));
      if (m.type === "fail") return stop(m.error ?? "load failed");
      const p = pending.get(m.id!);
      if (!p) return;
      pending.delete(m.id!);
      if (m.type === "error") return stop(m.error ?? "speech failed"), p.done(null);
      const b = new Blob([m.wav!], { type: "audio/wav" });
      keep(p.text, b);
      p.done(b);
      state.rtf = 0.7 * state.rtf + 0.3 * (m.ms! / 1000 / m.seconds!); // follow the machine: a busy GPU is slower
      if (tooSlow({ ms: m.ms!, seconds: m.seconds! })) stop("slower than real time");
    };
    worker.postMessage({ type: "load", device: "webgpu", dtype: "fp32" });
  })();
}

if (typeof window !== "undefined")
  for (const ev of ["keydown", "pointerdown"]) window.addEventListener(ev, () => ((gesture = true), load()), { capture: true, once: true });

export const localVoice = {
  state,
  /** Every /api/speak reply passes here: the server says whether the browser may read. */
  hear(r: Response) {
    if (r.headers.get("x-arc-browser-voice") === "on" && state.status === "off" && !worker) {
      state.status = "idle";
      load();
    }
  },
  pick: (items: Item[], rate: number) => pick(state, items, rate, (t) => made.has(t)),
  /** A clip's WAV, or null when the browser voice failed (it is then off for the session). Aborting drops it from the queue. */
  clip(text: string, voice: string, signal: AbortSignal): Promise<Blob | null> {
    const hit = made.get(text);
    if (hit) return keep(text, hit), Promise.resolve(hit);
    if (!worker || state.status !== "ready" || signal.aborted) return Promise.resolve(null);
    const id = ++seq;
    return new Promise((done) => {
      pending.set(id, { done, text });
      worker!.postMessage({ type: "say", id, text, voice });
      signal.addEventListener("abort", () => (pending.delete(id) && worker?.postMessage({ type: "drop", ids: [id] }), done(null)), { once: true });
    });
  },
  /** Waits for local clip i as long as the reader may; null means the server takes over. Updates the miss count. */
  async wait(clip: Promise<string | null>, i: number): Promise<string | null> {
    const t0 = performance.now();
    const url = await Promise.race([clip, new Promise<null>((ok) => setTimeout(ok, patience(i), null))]);
    if (state.status === "off") return url;
    const next = after(state, performance.now() - t0, i, !!url);
    if (next.status === "off") stop("too many late clips");
    else state.misses = next.misses;
    return url;
  },
};
