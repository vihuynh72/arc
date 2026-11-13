// Browser-side reading voice for Reader.tsx and Twin.tsx. Speech is Kokoro audio from /api/speak, never speechSynthesis.
import type { TwinNode } from "@/lib/types";
import { say as sayLive, stop as stopLive } from "./voice";

export const VOICE = "af_bella";
const clipUrl = (text: string) => `/api/speak?text=${encodeURIComponent(text)}&voice=${VOICE}`;

const MAX_CHUNK = 450; // the server rejects text over 600 characters

function hardSplit(s: string): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > MAX_CHUNK) {
    const head = rest.slice(0, MAX_CHUNK);
    const cut = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "), head.lastIndexOf(": "), head.lastIndexOf(" "));
    const at = cut > 100 ? cut + 1 : MAX_CHUNK;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  return rest ? [...out, rest] : out;
}

/** Sentences, so the first one can play while the rest are still being made. shortcut: abbreviation list is short, upgrade if odd splits are heard. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n{2,}/)) {
    let buf = "";
    for (const part of para.split(/(?<=[.!?])\s+(?=[A-Z0-9("“[])/)) {
      buf = buf ? `${buf} ${part}` : part;
      if (buf.length < 25 || /\b(et al|e\.g|i\.e|Fig|Figs|vs|approx|Eq|No|Dr|cf)\.$/.test(buf)) continue;
      out.push(buf);
      buf = "";
    }
    if (buf.trim()) out.push(buf);
  }
  return out.flatMap((c) => (c.length <= MAX_CHUNK ? [c] : hardSplit(c)));
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

async function fetchClip(text: string, signal: AbortSignal): Promise<string | null> {
  for (let tries = 0; tries < 2; tries++) {
    try {
      const r = await fetch(clipUrl(text), { signal });
      if (r.ok) return URL.createObjectURL(await r.blob());
    } catch {
      if (signal.aborted) return null;
    }
  }
  return null;
}

// A Kokoro clip later than this is spoken by the Gemini voice instead (first audio in about 1.3 s). After one miss the
// rest of the page waits less. The hosted copy (2 cores) needs about 10 s per new sentence; a laptop answers in under 1 s.
const PATIENCE = 4000; // laptop Kokoro can take ~2.6 s when three new clips queue; only a slow host should fall back
const PATIENCE_AFTER_MISS = 1200;
const SLOW = Symbol("slow");

/** Ask the server to make (and cache) a clip ahead of time. */
export const prefetchClip = (text: string) => void fetch(clipUrl(text)).catch(() => {});

class Speaker {
  rate = 1;
  private gen = 0;
  private ctl: AbortController | null = null;
  private audio: HTMLAudioElement | null = null;
  private release: (() => void) | null = null;
  private patience = PATIENCE;
  private live = false; // the Gemini voice is speaking a chunk

  /** A new page starts with the full patience again. */
  resetPatience() {
    this.patience = PATIENCE;
  }

  /** Speaks the chunks in order, resolves when done or cancelled. The next two are fetched while one plays. */
  async say(chunks: string[]): Promise<void> {
    this.cancel();
    const mine = this.gen;
    const ctl = (this.ctl = new AbortController());
    const clips: Promise<string | null>[] = [];
    const get = (i: number) => (i < chunks.length ? (clips[i] ??= fetchClip(chunks[i], ctl.signal)) : null);
    for (let i = 0; i < chunks.length && mine === this.gen; i++) {
      get(i);
      get(i + 1);
      get(i + 2);
      const url = await Promise.race([clips[i], new Promise<typeof SLOW>((r) => setTimeout(r, this.patience, SLOW))]);
      if (mine !== this.gen) break;
      if (url === SLOW) {
        // This chunk goes to the Gemini voice and the Kokoro request keeps running, so the clip is cached for next time.
        console.info("[arc-voice] kokoro slow, used live voice");
        this.patience = PATIENCE_AFTER_MISS;
        this.live = true;
        await sayLive(chunks[i]);
        this.live = false;
      } else if (url) await this.play(url);
    }
    for (const c of clips) void c.then((u) => u && URL.revokeObjectURL(u));
  }

  setRate(r: number) {
    this.rate = Math.min(2, Math.max(1, Math.round(r * 10) / 10));
    if (this.audio) this.audio.playbackRate = this.rate;
    return this.rate;
  }

  cancel() {
    this.gen++;
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
