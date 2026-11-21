// Browser-side reading voice for Reader.tsx and Twin.tsx. Speech is Kokoro audio from /api/speak, never speechSynthesis.
import type { TwinNode } from "@/lib/types";
import { kokoro, prefetch as prefetchLive, say as sayLive, stop as stopLive } from "./voice";
import { heard } from "./heard";
import { postSpeak } from "./clip";
import { localVoice } from "./localVoice";

export const VOICE = "af_bella";
// prio tells the server which clip to make first: 0 = about to play, 1 and 2 = read-ahead, 9 = warm-up.
// lang is the page's language, given only for the page's own words (never for Arc's English lines): the server refuses one the voice cannot read.
const ask = (text: string, prio = 0, lang?: string, signal?: AbortSignal) =>
  postSpeak(text, { voice: VOICE, ...(prio ? { prio } : {}), ...(lang ? { lang } : {}) }, signal).then((r) => (localVoice.hear(r), r));
// POST replies are not cached by the browser (GET ones were), so finished clips are kept here and R (repeat) or a read-ahead
// followed by playing makes one request. Blobs, not object URLs: say() revokes the URLs it made. A small least-recently-used map.
const kept = new Map<string, Blob>();
const keyOf = (text: string, lang?: string) => `${lang ?? ""}|${text}`;
const keep = (key: string, b: Blob) => (kept.delete(key), kept.set(key, b), kept.size > 40 && kept.delete(kept.keys().next().value!));
/** Ask ahead and keep the clip (a prefetch's 204 is "not made", so only a 200 is kept). */
const asking = new Set<string>();
const warm = (text: string, prio: number, lang?: string, signal?: AbortSignal) => {
  const key = keyOf(text, lang);
  if (kept.has(key) || asking.has(key)) return;
  asking.add(key);
  void ask(text, prio, lang, signal)
    .then(async (r) => (learn(r), r.status === 200 && keep(key, await r.blob())), () => {})
    .finally(() => asking.delete(key));
};
/** One thing to say. A plain string is Arc's own English; `lang` marks the words of a page in another language. */
export type Chunk = string | { text: string; lang?: string };
const SKIP = "skip"; // a clip the server refused (the voice cannot read this language): never replaced by another voice

export const MAX_CHUNK = 300; // the server rejects text over 600 characters; shorter clips also start sooner

function hardSplit(s: string): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > MAX_CHUNK) {
    const head = rest.slice(0, MAX_CHUNK + 1);
    const clause = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "), head.lastIndexOf(": "), head.lastIndexOf(" – "), head.lastIndexOf(" — "), head.lastIndexOf("، "), head.lastIndexOf("，"), head.lastIndexOf("；"), head.lastIndexOf("、"));
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
    // A sentence ends at . ! ? (and Arabic ؟, Hindi ।) before a space and a capital, a caseless letter (Arabic, Devanagari) or
    // ¿ ¡; Chinese and Japanese 。！？ end one with no space after.
    for (const part of para.replace(/\s+/g, " ").trim().split(/(?<=[.!?؟।])\s+(?=[\p{Lu}\p{Lo}0-9("“[¿¡«])|(?<=[。！？])\s*/u)) {
      buf = buf ? `${buf}${/[。！？]$/.test(buf) ? "" : " "}${part}` : part;
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

/** What the voice says for a section heading stop (its blocks are separate stops). */
export const headSpeech = (n: TwinNode): string[] => [n.heading.replace(/^(\d+(\.\d+)*)\.\s/, "$1 ").trim()].filter(Boolean);

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

const learn = (r: Response) => {
  if (r.headers.get("x-arc-kokoro") === "off") kokoro.off = true;
  if (r.status === 422 && r.headers.get("x-arc-lang") === "unsupported")
    void r.clone().json().then((d: { lang?: string; say?: string }) => speaker.refuse(d.lang ?? "", d.say ?? ""), () => {});
  if (r.status === 202 && r.headers.get("x-arc-voice") === "loading")
    void r.clone().json().then((d: { lang?: string; say?: string }) => speaker.announce(d.lang ?? "", d.say ?? ""), () => {});
};
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((r) => (setTimeout(r, ms), signal.addEventListener("abort", () => r())));

/** A clip URL, or null when Kokoro is off or the clip failed twice. A busy server (503) is waited out, not counted as a failure. */
async function fetchClip(text: string, signal: AbortSignal, prio = 0, lang?: string): Promise<string | null> {
  const key = keyOf(text, lang);
  const hit = kept.get(key);
  if (hit) return keep(key, hit), URL.createObjectURL(hit);
  let failed = 0;
  for (let busy = 0, loading = 0; failed < 2 && busy < 20 && loading < 120 && !signal.aborted; ) {
    try {
      const r = await ask(text, prio, lang, signal);
      if (r.status === 202) {
        learn(r); // this language's voice is being fetched: its line is said once, and the clip asked for again
        loading++;
        await wait(1500, signal);
        continue;
      }
      if (r.ok) {
        const b = await r.blob();
        keep(key, b);
        return URL.createObjectURL(b);
      }
      learn(r);
      if (r.status === 422) return SKIP; // another language: refused once, not retried
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
export const prefetchClip = (text: string) => void (!kokoro.off && warm(text, 9));
/** One short request when a page in another language opens: if the voice cannot read it, the server refuses and `speaker.refuse` hears of it before any reading starts. */
export const probeLanguage = (lang: string) => void (!kokoro.off && warm("Hello.", 9, lang));
/** The next stop's first clip while this one plays (prio 2: after this stop's own next clips). Abortable: the reader drops it when the cursor goes elsewhere. */
export const prefetchAhead = (text: string, signal: AbortSignal, lang?: string) =>
  void (localVoice.pick([{ text, lang }], speaker.rate) === "local" ? localVoice.clip(text, VOICE, signal) : !kokoro.off && !(lang && speaker.blocked === lang) && warm(text, 2, lang, signal));

/** A block's chunks with the first cut to about one clause, so its clip is made in about a second (later chunks stay as they are).
 * span[k] is the sentence (the [data-s] span) that chunk k belongs to. */
export function shortFirst(lines: string[], max = 110): { lines: string[]; span: number[] } {
  const first = lines[0] ?? "";
  let cut = -1;
  if (first.length > max) {
    cut = Math.max(first.lastIndexOf(", ", max), first.lastIndexOf("; ", max), first.lastIndexOf(": ", max));
    if (cut < 30 && first.length > 140) cut = first.lastIndexOf(" ", 100); // no clause break early on: a word break near 100
    if (cut < 30 || first.length - cut < 20) cut = -1; // never leave a stub
  }
  if (cut < 0) return { lines, span: lines.map((__, k) => k) };
  return { lines: [first.slice(0, cut + 1).trim(), first.slice(cut + 1).trim(), ...lines.slice(1)], span: [0, ...lines.map((__, k) => k)] };
}

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
  cutAt = -1; // when speech was last cut off (cancelled while busy), and when a say() last began: Reader's "Paused." line
  sayAt = -1;
  recent: { text: string; at: number }[] = []; // what was said lately, so a status line is not said twice (voice first)
  /** The language of the open page when the voice cannot read it: its own words are then not asked for, and "arc:language" says why once. */
  blocked: string | null = null;
  private gen = 0;
  private ctl: AbortController | null = null;
  private audio: HTMLAudioElement | null = null;
  private release: (() => void) | null = null;
  private live = false; // the Gemini voice is speaking a chunk

  /** Speaks the chunks in order; onChunk(i) fires as chunk i starts to play. Resolves true when all were spoken, false when cancelled. While clip i plays, clips i+1 and
   * i+2 are already asked for (gapless), with a priority so the server makes the nearest first; cancel() aborts them all. */
  async say(input: Chunk[], onChunk?: (i: number) => void): Promise<boolean> {
    this.cancel();
    this.sayAt = performance.now();
    const mine = this.gen;
    this.busy = true;
    const items = input.map((c) => (typeof c === "string" ? { text: c, lang: undefined } : c));
    const chunks = items.map((c) => c.text);
    const now = Date.now();
    this.recent = [...this.recent.filter((r) => now - r.at < 10_000), { text: chunks.join(" "), at: now }];
    const ctl = (this.ctl = new AbortController());
    const clips: (Promise<string | null> | undefined)[] = [];
    const held = (i: number) => !!items[i].lang && items[i].lang === this.blocked; // this page's language cannot be read aloud
    // The browser's own Kokoro reads the whole block or none of it (lib/client/localVoice.ts); the server is the fallback.
    let local = localVoice.pick(items, this.rate) === "local";
    const fromLocal = (t: string) => localVoice.clip(t, VOICE, ctl.signal).then((b) => (b ? URL.createObjectURL(b) : null));
    const get = (i: number, prio: number) =>
      void (i < chunks.length && !held(i) && (clips[i] ??= local ? fromLocal(chunks[i]) : kokoro.off ? undefined : fetchClip(chunks[i], ctl.signal, prio, items[i].lang)));
    const drop = (from: number) => void clips.splice(from).forEach((c) => void c?.then((u) => u && u !== SKIP && URL.revokeObjectURL(u)));
    let unread = false;
    if (local) for (let i = 0; i < chunks.length; i++) get(i, 0); // made one after another in the browser: all asked at once
    for (let i = 0; i < chunks.length && mine === this.gen; i++) {
      get(i, 0);
      get(i + 1, 1);
      get(i + 2, 2);
      let url = held(i) || !clips[i] ? null : local ? await localVoice.wait(clips[i]!, i) : await clips[i]!;
      if (mine !== this.gen) break;
      if (local && !url) {
        // Late or failed: the server reads the rest of this block (a change between sentences, never inside one).
        local = false;
        drop(i);
        get(i, 0);
        get(i + 1, 1);
        get(i + 2, 2);
        url = clips[i] ? await clips[i]! : null;
        if (mine !== this.gen) break;
      }
      if (held(i) || url === SKIP) {
        unread = true; // not read, and no other voice takes over: it would read it wrongly
        continue;
      }
      if (url) {
        await this.notice; // "Getting the Spanish voice" finishes before the page's first words
        if (mine !== this.gen) break;
        onChunk?.(i);
        await this.play(url, chunks[i]);
      } else {
        // Kokoro is off on this host, or this one clip failed twice: the Gemini voice says it, then Kokoro carries on.
        if (kokoro.off && i + 1 < chunks.length) prefetchLive(chunks[i + 1]); // one ahead: Live costs a round trip per chunk
        this.live = true;
        onChunk?.(i);
        await sayLive(chunks[i]);
        this.live = false;
      }
    }
    for (const c of clips) void c?.then((u) => u && u !== SKIP && URL.revokeObjectURL(u));
    if (mine === this.gen) this.busy = false;
    return mine === this.gen && !unread;
  }

  /** The server refused a language. The first time for a page: remember it and tell Twin, which says the server's line. */
  refuse(lang: string, line: string) {
    if (!lang || this.blocked === lang) return;
    this.blocked = lang;
    window.dispatchEvent(new CustomEvent("arc:language", { detail: { lang, say: line } }));
  }

  private told = new Set<string>(); // languages whose "getting the voice" line has been said
  private notice: Promise<void> = Promise.resolve();
  /** The server is fetching this language's voice for the first time: say its English line once, as soon as nothing else plays. */
  announce(lang: string, line: string) {
    if (!lang || !line || this.told.has(lang)) return;
    this.told.add(lang);
    said(line);
    const free = async () => {
      while (this.audio) await new Promise((ok) => setTimeout(ok, 200));
    };
    this.notice = this.notice
      .then(() => Promise.all([fetchClip(line, new AbortController().signal), free()]))
      .then(([u]) => (u && u !== SKIP ? this.play(u, line).finally(() => URL.revokeObjectURL(u)) : undefined))
      .catch(() => {});
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
    if (this.busy) this.cutAt = performance.now();
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

  private play(url: string, text = "") {
    return new Promise<void>((done) => {
      const a = new Audio(url);
      let on = false; // heard: its sound started
      a.onplaying = () => void (on || ((on = true), heard({ kind: "speech", voice: "arc", text, phase: "start" })));
      a.preservesPitch = true;
      a.playbackRate = this.rate;
      this.audio = a;
      const end = () => {
        if (on) heard({ kind: "speech", voice: "arc", text, phase: a.ended ? "end" : "cut", frac: a.currentTime / a.duration });
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

/** Soft repeating tone while a live fetch runs (lib/client/voice.ts: its watchdog uses it too). Returns a stop function. */
export { startWaitTone } from "./voice";
