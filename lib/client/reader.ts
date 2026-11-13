// Browser-side reading voice for Reader.tsx and Twin.tsx. Speech is Kokoro audio from /api/speak, never speechSynthesis.
import type { TwinNode } from "@/lib/types";
import { kokoro, prefetch as prefetchLive, say as sayLive, stop as stopLive } from "./voice";

export const VOICE = "af_bella";
const clipUrl = (text: string) => `/api/speak?text=${encodeURIComponent(text)}&voice=${VOICE}`;

export const MAX_CHUNK = 300; // the server rejects text over 600 characters; shorter clips also start sooner

function hardSplit(s: string): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > MAX_CHUNK) {
    const head = rest.slice(0, MAX_CHUNK + 1);
    const clause = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "), head.lastIndexOf(": "), head.lastIndexOf(" – "), head.lastIndexOf(" — "));
    const cut = clause > 100 ? clause + 1 : head.lastIndexOf(" ");
    const at = cut > 0 ? cut : MAX_CHUNK; // no space at all: cut mid-word rather than send a clip the server refuses
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  return rest ? [...out, rest] : out;
}

/** Sentences, so the first one can play while the rest are still being made. Every piece is 1 to MAX_CHUNK characters.
 * shortcut: abbreviation list is short, upgrade if odd splits are heard. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n{2,}/)) {
    let buf = "";
    for (const part of para.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+(?=[A-Z0-9("“[])/)) {
      buf = buf ? `${buf} ${part}` : part;
      if (buf.length < 25 || /\b(et al|e\.g|i\.e|Fig|Figs|vs|approx|Eq|No|Dr|cf)\.$/.test(buf)) continue;
      out.push(buf);
      buf = "";
    }
    if (buf.trim()) out.push(buf);
  }
  return out.flatMap((c) => (c.length <= MAX_CHUNK ? [c] : hardSplit(c))).filter(Boolean);
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
export { clock };

/** What the voice says for a node: heading first, then the text by sentence. */
export function nodeSpeech(n: TwinNode): string[] {
  const head = n.heading.replace(/^(\d+(\.\d+)*)\.\s/, "$1 ").trim();
  const parts = [head];
  if (n.kind === "segment" && n.start != null) parts.push(`At ${clock(n.start)}.`);
  const body = splitSentences(n.text);
  // The heading clip plays while the first sentence is made, so keep that sentence short: cut a long one at its last comma or semicolon within 160 characters.
  const first = body[0] ?? "";
  const cut = first.length > 160 ? Math.max(first.lastIndexOf(", ", 160), first.lastIndexOf("; ", 160)) : -1;
  if (cut > 30) body.splice(0, 1, first.slice(0, cut + 1), first.slice(cut + 1).trim());
  parts.push(...body);
  if (n.shown) parts.push(...splitSentences(`On screen: ${n.shown}`));
  return parts.filter(Boolean);
}

/** goto: exact, then starts-with, then contains, on headings and (for figures) captions. */
export function findNode(nodes: TwinNode[], query: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const q = norm(query);
  if (!q) return -1;
  const keys = nodes.map((n) => {
    const h = norm(n.heading);
    return { h, bare: h.replace(/^\d+( \d+)*\s+/, ""), cap: n.kind === "figure" ? norm(`${n.heading} ${n.text}`) : h };
  });
  const tests: ((k: (typeof keys)[number]) => boolean)[] = [
    (k) => k.h === q || k.bare === q,
    (k) => k.h.startsWith(q) || k.bare.startsWith(q) || k.cap.startsWith(q),
    (k) => k.h.includes(q) || k.cap.includes(q),
  ];
  for (const t of tests) {
    const i = keys.findIndex(t);
    if (i >= 0) return i;
  }
  return -1;
}

export function said(text: string) {
  window.dispatchEvent(new CustomEvent("arc:said", { detail: { text } }));
}

const learn = (r: Response) => void (r.headers.get("x-arc-kokoro") === "off" && (kokoro.off = true));
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((r) => (setTimeout(r, ms), signal.addEventListener("abort", () => r())));

/** A clip URL, or null when Kokoro is off or the clip failed twice. A busy server (503) is waited out, not counted as a failure. */
async function fetchClip(text: string, signal: AbortSignal): Promise<string | null> {
  let failed = 0;
  for (let busy = 0; failed < 2 && busy < 20 && !signal.aborted; ) {
    try {
      const r = await fetch(clipUrl(text), { signal });
      if (r.ok) return URL.createObjectURL(await r.blob());
      learn(r);
      if (kokoro.off) return null;
      if (r.status === 503) busy++;
      else failed++;
    } catch {
      failed++;
    }
    await wait(700, signal);
  }
  if (!signal.aborted) console.warn("[arc-voice] no kokoro clip after retries:", text.slice(0, 60));
  return null;
}

/** Ask the server to make (and cache) a clip ahead of time. */
export const prefetchClip = (text: string) => void (!kokoro.off && fetch(clipUrl(text)).then(learn, () => {}));

const SPEED = "arc-speed"; // the reading speed the user chose, kept like "arc-display"
const savedRate = () => {
  try {
    const v = Number(localStorage.getItem(SPEED));
    return v >= 1 && v <= 2 ? v : 1.25;
  } catch {
    return 1.25;
  }
};

class Speaker {
  rate = savedRate();
  busy = false; // a say() is under way
  recent: { text: string; at: number }[] = []; // what was said lately, so a status line is not said twice (voice first)
  private gen = 0;
  private ctl: AbortController | null = null;
  private audio: HTMLAudioElement | null = null;
  private release: (() => void) | null = null;
  private live = false; // the Gemini voice is speaking a chunk

  /** Speaks the chunks in order; resolves true when all were spoken, false when cancelled. At most two clips are asked for
   * at once (the one to play and the next), so a reading never fills the server's queue (1 running + 4 waiting). */
  async say(chunks: string[]): Promise<boolean> {
    this.cancel();
    const mine = this.gen;
    this.busy = true;
    const now = Date.now();
    this.recent = [...this.recent.filter((r) => now - r.at < 10_000), { text: chunks.join(" "), at: now }];
    const ctl = (this.ctl = new AbortController());
    const clips: Promise<string | null>[] = [];
    const get = (i: number) => void (i < chunks.length && !kokoro.off && (clips[i] ??= fetchClip(chunks[i], ctl.signal)));
    for (let i = 0; i < chunks.length && mine === this.gen; i++) {
      get(i);
      get(i + 1);
      const url = kokoro.off ? null : await clips[i];
      if (mine !== this.gen) break;
      if (url) await this.play(url);
      else {
        // Kokoro is off on this host, or this one clip failed twice: the Gemini voice says it, then Kokoro carries on.
        if (kokoro.off && i + 1 < chunks.length) prefetchLive(chunks[i + 1]); // one ahead: Live costs a round trip per chunk
        this.live = true;
        await sayLive(chunks[i]);
        this.live = false;
      }
    }
    for (const c of clips) void c?.then((u) => u && URL.revokeObjectURL(u));
    if (mine === this.gen) this.busy = false;
    return mine === this.gen;
  }

  setRate(r: number) {
    this.rate = Math.min(2, Math.max(1, Math.round(r * 10) / 10));
    if (this.audio) this.audio.playbackRate = this.rate;
    try {
      localStorage.setItem(SPEED, String(this.rate));
    } catch {}
    return this.rate;
  }

  cancel() {
    this.gen++;
    this.busy = false;
    this.ctl?.abort();
    this.audio?.pause();
    this.release?.();
    if (this.live) {
      this.live = false;
      stopLive();
    }
  }

  private play(url: string) {
    return new Promise<void>((done) => {
      const a = new Audio(url);
      a.preservesPitch = true;
      a.playbackRate = this.rate;
      this.audio = a;
      const end = () => {
        a.onended = a.onerror = null;
        if (this.audio === a) this.audio = null;
        this.release = null;
        done();
      };
      this.release = end;
      a.onended = a.onerror = end;
      a.play().catch(end); // autoplay refused: skip rather than hang
    });
  }
}

export const speaker = new Speaker();

/** Soft repeating tone while a live fetch runs. Returns a stop function. */
export function startWaitTone(): () => void {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return () => {};
  const ctx = new Ctx();
  const beep = () => {
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
