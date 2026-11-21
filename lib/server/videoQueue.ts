// The video pipeline: one job per YouTube video, fanned out into windows and folded back into one list of segments.
// Lane "lite": flash-lite transcribes a window word for word (0 to 60 s first, then about 3 minutes each, from the start, until a
// window comes back empty or the duration is reached). Lane "describe": only for segments whose words lean on sight (or where
// flash-lite saw something), the describe model writes `shown` again; flash-lite's line is served until then.
// The student's position (prioritise) moves work to the front of both lanes. Callers: lib/server/video.ts, app/api/video/shown.
// State lives on globalThis (one long-lived process) and is saved to .cache/video/job-<id>.json after every step.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { GEMINI_VIDEO_DESCRIBE_MODEL, GEMINI_VISION_MODEL } from "../models";
import type { TwinNode } from "../types";
import { POINTS_AT, clock } from "./captions";
import { allowBackground, allowExtras, isBudgetError, level } from "./budget";
import { generateJsonChain, type Part } from "./gemini";
import { FrameError, capture, frameIndex, type FrameInfo } from "./videoFrames";

type WinState = "todo" | "running" | "done" | "failed";
type Saved = {
  url: string;
  duration: number; // 0 while unknown
  ended: number | null; // first window that came back empty
  source: "gemini" | "captions";
  segs: TwinNode[]; // stable ids; never renumbered
  wins: WinState[]; // lite windows by index
  lite: Record<string, string>;
  described: Record<string, string>;
  headings: Record<string, string>;
  pending: string[][]; // describe tasks not yet answered (segment ids)
  visual?: Record<string, FrameInfo>; // segments the describe model saw a picture in, and the best second for it
  frameQueue?: string[]; // segment ids waiting for a picture, most wanted first
  noFrames?: string; // why this video gives no pictures (embedding disabled), said once
  rescanned?: string[]; // segments the describe pass has covered with the `visual`/`at` fields (absent: saved before they existed)
  legacy?: true; // saved before those fields existed: its windows are described lazily, as the student reaches them
};
// seen: the last time a student's browser asked about this video (it polls while the lecture is open); wanted: pictures asked for.
type Job = Saved & { vid: string; runs: Map<number, Promise<void>>; describing: number; born: number; taken: Record<string, FrameInfo>; seen: number; wanted: Set<string> };
export type Status = {
  done: boolean;
  transcribed: boolean;
  duration: number;
  segments: TwinNode[];
  headings: Record<string, string>;
  shown: Record<string, string>;
  frames: Record<string, FrameInfo>; // segment id -> picture taken (the route adds its url)
  noFrames?: string;
};

type Queue = { jobs: Map<string, Job>; urgent: { vid: string; i: number }[]; busy: { lite: number; describe: number; frame: number }; calls: string[] };
const g = globalThis as unknown as { __arcVideoJobs?: Queue };
const Q: Queue = (g.__arcVideoJobs ??= { jobs: new Map(), urgent: [], busy: { lite: 0, describe: 0, frame: 0 }, calls: [] });
Q.busy.frame ??= 0; // a queue made before frames existed (hot reload)
const LIMIT = { lite: 2, describe: 1, frame: 1 };
const AUTO_FRAMES = 12; // pictures taken without being asked, per video; a student's request is never capped
const VISUALS = ["chart", "diagram", "table", "equation", "slide", "map"];
// Worth a picture first: the ones a tour can walk through.
const rank = (v: string) => (["chart", "diagram", "table", "map"].includes(v) ? 0 : v === "equation" ? 1 : 2);
const FIRST = 60;
// Length unknown: later windows wait this long for the player's duration. A window asked past the end gets its words spread
// over the time asked for (measured on 36v2EXZRzUE: 80 s of speech placed over 60 to 240 s), so the duration matters.
const GRACE_MS = 8_000;
const SPAN = 180;
// Background work for a video nobody has asked about for this long stops (the student left); it resumes if they come back.
const LEFT_MS = 10 * 60_000;
// The player reports the length; a longer claim is not believed (each 3 minutes is a paid window).
const MAX_VIDEO_S = Number(process.env.ARC_MAX_VIDEO_S) || 2 * 3600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const file = (vid: string) => `.cache/video/job-${vid}.json`;

export const winStart = (i: number) => (i === 0 ? 0 : FIRST + (i - 1) * SPAN);
export const winOf = (t: number) => (t < FIRST ? 0 : 1 + Math.floor((t - FIRST) / SPAN));
const winEnd = (j: Saved, i: number) => {
  const e = i === 0 ? FIRST : winStart(i) + SPAN;
  return j.duration ? Math.min(e, j.duration) : e;
};
/** Last window index worth asking for; null while neither the duration nor an empty window is known. */
const lastWin = (j: Saved) => (j.duration ? winOf(Math.max(0, j.duration - 1)) : j.ended !== null ? j.ended - 1 : null);
const ordered = (j: Saved) => [...j.segs].sort((a, b) => a.order - b.order);

async function persist(j: Job) {
  const saved: Saved = {
    url: j.url, duration: j.duration, ended: j.ended, source: j.source, segs: j.segs, wins: j.wins, lite: j.lite, described: j.described, headings: j.headings,
    pending: j.pending, visual: j.visual, frameQueue: j.frameQueue, noFrames: j.noFrames, rescanned: j.rescanned ?? [], ...(j.legacy ? { legacy: true as const } : {}),
  };
  await mkdir(".cache/video", { recursive: true });
  await writeFile(file(j.vid), JSON.stringify(saved));
}

// ---- lite: transcribe one window ----

const LITE_SCHEMA = {
  type: "OBJECT",
  properties: {
    parts: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { start: { type: "NUMBER" }, end: { type: "NUMBER" }, said: { type: "STRING" }, heading: { type: "STRING" }, shown: { type: "STRING" } },
        required: ["start", "end", "said", "heading", "shown"],
      },
    },
  },
  required: ["parts"],
};

const litePrompt = (a: number, b: number) => `Transcribe this part of the video word for word, from ${a} to ${b} seconds of the whole video, in parts of about 30 seconds that end at a sentence end. Times are seconds from the start of the whole video.
For each part give: start, end, said (the exact words spoken; an empty string if nobody speaks), heading (3 to 6 plain words naming what the part is about), and shown (one short sentence on what is on screen that the words do not say, quoting on-screen text exactly; an empty string if the screen adds nothing or you are not sure).
Give the real times at which the words are spoken; do not space the parts evenly. If the video ends before ${b} seconds, stop where it ends.
If this part of the video has no speech and nothing on screen, return no parts.`;

type LitePart = { start: number; end: number; said: string; heading: string; shown: string };

/** Model parts into segments that tile [a, b]: times clamped, ordered and merged in code; each starts where the one before
 * ends. Ids are "n" + window + part ("n0302"), so they sort in time order and never change once served. */
export function tile(parts: LitePart[], a: number, b: number, win: number): { seg: TwinNode; heading: string; shown: string }[] {
  const kept: LitePart[] = [];
  const sorted = parts
    .map((p) => ({ said: (p.said ?? "").replace(/\s+/g, " ").trim(), shown: (p.shown ?? "").trim(), heading: (p.heading ?? "").trim(), start: Math.round(Math.min(b, Math.max(a, Number(p.start) || a))), end: 0 }))
    .filter((p) => p.said || p.shown)
    .sort((x, y) => x.start - y.start);
  for (const p of sorted) {
    const prev = kept[kept.length - 1];
    if (prev && (p.start === prev.start || p.start >= b)) prev.said = `${prev.said} ${p.said}`.trim(); // same second, or past the end
    else kept.push(p);
  }
  // Tile the window (each part ends where the next starts), then even out lengths, then number.
  const tiled = kept.map((p, k) => ({ ...p, start: k ? p.start : a, end: k + 1 < kept.length ? kept[k + 1].start : b }));
  return evenOut(tiled).map((p, k) => ({
    seg: {
      id: `n${String(win).padStart(2, "0")}${String(k).padStart(2, "0")}`,
      kind: "segment" as const,
      order: win * 100 + k,
      level: 3,
      heading: clock(p.start),
      text: p.said,
      start: p.start,
      end: p.end,
    },
    heading: p.heading.replace(/[.:]+$/, "").split(" ").slice(0, 8).join(" "),
    shown: cleanShown(p.shown),
  }));
}

const LONG = 45;
const SHORT = 12;
const ENOUGH = 20;
const sentences = (t: string) => t.match(/.+?[.?!]+["')\]]*(?=\s|$)|.+$/g)?.map((x) => x.trim()).filter(Boolean) ?? [];

/** One cursor stop should be one stretch of reading. Parts over 45 s split at sentence ends, each piece timed by its share of
 * the characters; then neighbours merge while one is under 12 s (or the first under 20 s) and the sum stays within 45 s.
 * Works inside one window only, so ids stay stable. */
export function evenOut(parts: LitePart[]): LitePart[] {
  const split: LitePart[] = [];
  for (const p of parts) {
    const len = p.end - p.start;
    const ss = sentences(p.said);
    if (len <= LONG || ss.length < 2) {
      split.push(p);
      continue;
    }
    const n = Math.min(ss.length, Math.ceil(len / 35));
    const total = ss.reduce((m, x) => m + x.length, 0);
    const groups: string[][] = [[]];
    let acc = 0;
    for (const x of ss) {
      // a new piece once this one holds its share, keeping enough sentences for the pieces still to come
      if (groups[groups.length - 1].length && acc >= (total * groups.length) / n && groups.length < n) groups.push([]);
      groups[groups.length - 1].push(x);
      acc += x.length;
    }
    let t = p.start;
    let used = 0;
    groups.forEach((g, k) => {
      used += g.reduce((m, x) => m + x.length, 0);
      const end = k === groups.length - 1 ? p.end : Math.round(p.start + (len * used) / total);
      split.push({ ...p, said: g.join(" "), start: t, end, heading: k ? "" : p.heading, shown: k ? "" : p.shown });
      t = end;
    });
  }
  const out: LitePart[] = [];
  for (const p of split) {
    const prev = out[out.length - 1];
    const prevLen = prev ? prev.end - prev.start : 0;
    if (prev && prevLen + (p.end - p.start) <= LONG && (prevLen < ENOUGH || p.end - p.start < SHORT)) {
      prev.end = p.end;
      prev.said = `${prev.said} ${p.said}`.trim();
      prev.shown = [prev.shown, p.shown].filter(Boolean).join(" ");
      prev.heading ||= p.heading;
    } else out.push({ ...p });
  }
  return out;
}

async function attempt<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  for (let k = 0; k < 3; k++) {
    if (k) await sleep(2500);
    const t0 = Date.now();
    try {
      const r = await fn();
      Q.calls.push(`${label} ok ${Date.now() - t0}ms`);
      return r;
    } catch (e) {
      Q.calls.push(`${label} fail ${Date.now() - t0}ms`);
      if (isBudgetError(e)) return null; // refused: no retries
      if (k === 2) console.log(`[video] ${label} failed: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  return null;
}

async function runLite(j: Job, i: number) {
  const a = winStart(i);
  const b = winEnd(j, i);
  const parts: Part[] = [{ fileData: { fileUri: j.url }, videoMetadata: { startOffset: `${a}s`, endOffset: `${b}s`, fps: i === 0 ? 0.5 : 0.2 } }, { text: litePrompt(a, b) }];
  const r = await attempt(`${j.vid} lite ${clock(a)}-${clock(b)}`, () => generateJsonChain<{ parts: LitePart[] }>(parts, LITE_SCHEMA, [GEMINI_VISION_MODEL], 30_000, "video-transcript"));
  if (!r && level() >= 3) {
    j.wins[i] = "todo"; // refused by today's budget, not a failed window: asked again when there is budget
    return;
  }
  if (!r) {
    j.wins[i] = "failed";
    // Length unknown: a window past the end fails (HTTP 400), so a failure ends the run; the player's duration reopens it.
    if (!j.duration) j.ended = j.ended === null ? i : Math.min(j.ended, i);
    return;
  }
  const out = tile(r.data.parts ?? [], a, j.duration ? Math.min(b, j.duration) : b, i); // the duration may have arrived meanwhile
  j.wins[i] = "done";
  if (!out.length) {
    j.ended = j.ended === null ? i : Math.min(j.ended, i);
    return;
  }
  for (const o of out) {
    if (o.heading) j.headings[o.seg.id] = o.heading;
    j.lite[o.seg.id] = o.shown;
  }
  const segs = out.map((o) => o.seg);
  j.segs.push(...segs);
  const need = segs.filter((s) => POINTS_AT.test(s.text) || j.lite[s.id]).map((s) => s.id);
  if (need.length) j.pending.push(need);
}

// ---- describe: re-describe the segments that lean on sight ----

const DESCRIBE_SCHEMA = {
  type: "OBJECT",
  properties: {
    segments: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { id: { type: "STRING" }, shown: { type: "STRING" }, visual: { type: "STRING", enum: [...VISUALS, "none"] }, at: { type: "NUMBER" } },
        required: ["id", "shown", "visual", "at"],
      },
    },
  },
  required: ["segments"],
};

export const describePrompt = (segs: TwinNode[], before: string) => `This clip is part of a lesson video. A blind student hears the words; you tell them what they would miss by not seeing the screen.
For each segment listed below give shown: what is on screen during that segment that the words do not already say, in one or two short sentences written to be heard. When the speaker says "this", "here", "as you can see" or points or writes, say what they point at or write. Quote on-screen text, labels and numbers exactly, and only when legible. If the screen shows only a person talking, adds nothing, or you are not sure, give an empty string. Never guess.
Also give visual: the kind of picture on screen in that segment, one of chart, diagram, table, equation (being written or shown), slide, map, or none (a person talking, plain titles, or nothing worth a picture). And at: the second, counted from the start of the whole video and inside that segment, when that picture is most complete and nothing covers it (for something drawn bit by bit, near the end of the drawing).
The lines are heard in order, and the student remembers them. Describe only what is new or changed since the segment before it (for the first segment, since the line said just before this clip, below): when the screen is unchanged give an empty string, and when part of it is new say only that part ("Now the speaker circles 18% in yellow."). Never list again what an earlier line already said. Describe a screen in full only when nothing was said about it yet. Do not use "still", "stays", "again" or "the same".
${before ? `Already said about the screen just before this clip: "${before}"\n` : ""}Segments (times are from the start of the whole video):
${segs.map((s) => `${s.id} ${clock(s.start!)} to ${clock(s.end!)}: "${s.text.slice(0, 700)}"`).join("\n")}`;

async function runDescribe(j: Job, ids: string[]) {
  const all = ordered(j);
  const segs = all.filter((s) => ids.includes(s.id));
  if (!segs.length) return;
  const a = segs[0].start!;
  const b = segs[segs.length - 1].end!;
  const prev = all[all.indexOf(segs[0]) - 1];
  const before = prev ? (j.described[prev.id] ?? j.lite[prev.id] ?? "") : "";
  const parts: Part[] = [{ fileData: { fileUri: j.url }, videoMetadata: { startOffset: `${a}s`, endOffset: `${b}s`, fps: b - a > 120 ? 0.5 : 1 } }, { text: describePrompt(segs, before) }];
  const r = await attempt(`${j.vid} describe ${clock(a)}-${clock(b)} (${segs.length})`, () =>
    generateJsonChain<{ segments: { id: string; shown: string; visual: string; at: number }[] }>(parts, DESCRIBE_SCHEMA, [GEMINI_VIDEO_DESCRIBE_MODEL], 90_000, "video-describe"),
  );
  for (const s of r?.data.segments ?? []) {
    const seg = segs.find((x) => x.id === s.id);
    if (!seg) continue; // unknown ids dropped
    j.described[s.id] = cleanShown(s.shown);
    if (VISUALS.includes(s.visual)) (j.visual ??= {})[s.id] = { visual: s.visual, at: frameAt(seg, s.at) };
  }
  for (const id of ids) if (!(j.rescanned ??= []).includes(id)) j.rescanned.push(id);
  queueFrames(j);
  if (!r) for (const id of ids) j.described[id] ??= j.lite[id] ?? ""; // failed: flash-lite's line stands
}

/** The model's second, kept inside the segment (and off its first and last second); its end when the model gave none. */
export function frameAt(seg: { start?: number; end?: number }, at: unknown): number {
  const lo = seg.start! + 1;
  const hi = Math.max(lo, seg.end! - 1);
  const t = typeof at === "number" && Number.isFinite(at) ? at : hi;
  return Math.round(Math.min(hi, Math.max(lo, t)) * 10) / 10;
}

/** Up to 12 pictures a video, unasked: charts, diagrams, tables and maps first, then equations, then slides; time order within. */
export function pickFrames(visual: Record<string, FrameInfo>, have: string[], cap = AUTO_FRAMES): string[] {
  const room = Math.max(0, cap - have.length);
  return Object.entries(visual)
    .filter(([id]) => !have.includes(id))
    .sort(([a, x], [b, y]) => rank(x.visual) - rank(y.visual) || a.localeCompare(b))
    .slice(0, room)
    .map(([id]) => id);
}

function queueFrames(j: Job) {
  if (j.noFrames || !allowExtras()) return; // automatic pictures are an extra
  const q = (j.frameQueue ??= []);
  for (const id of pickFrames(j.visual ?? {}, [...q, ...Object.keys(j.taken)])) q.push(id);
}

async function runFrame(j: Job, id: string) {
  const seg = j.segs.find((s) => s.id === id);
  if (!seg) return;
  const v = j.visual?.[id] ?? { visual: "none", at: frameAt(seg, undefined) };
  try {
    const r = await capture(j.vid, id, v.at, v.visual);
    j.taken[id] = { at: r.at, visual: v.visual };
    Q.calls.push(`${j.vid} frame ${id} @${r.at}s ${v.visual} ${r.route} ${r.ms}ms`);
  } catch (e) {
    Q.calls.push(`${j.vid} frame ${id} fail`);
    if (e instanceof FrameError && /outside its own site/.test(e.message)) {
      j.noFrames = e.message;
      j.frameQueue = [];
    }
    console.log(`[video] frame ${j.vid} ${id}: ${(e as Error).message.slice(0, 120)}`);
  }
}

/** One or two sentences, nothing that only says the screen is empty. */
export function cleanShown(t: string): string {
  const s = t.replace(/\s+/g, " ").trim();
  if (!s || /^(the speaker|a (man|woman|person)\b.*talk|unclear|nothing|none|n\/a|no (slides|visual))/i.test(s)) return "";
  // A sentence ends at . ? ! before a space or the end, so "2π(0.1)" and "x^2." inside a line do not cut it.
  return (s.match(/.+?[.?!]+["')\]]*(?=\s|$)/g) ?? [s]).slice(0, 2).join(" ").replace(/\s+/g, " ").trim();
}

// ---- scheduling ----

function nextLite(): { j: Job; i: number } | null {
  while (Q.urgent.length) {
    const { vid, i } = Q.urgent.shift()!;
    const j = Q.jobs.get(vid);
    if (j && (j.wins[i] ?? "todo") === "todo" && (lastWin(j) === null || i <= lastWin(j)!)) return { j, i };
  }
  if (!allowBackground()) return null; // low budget: only the window the student is at (urgent, above)
  for (const j of [...Q.jobs.values()].reverse()) { // the video touched last goes first
    if (Date.now() - j.seen > LEFT_MS) continue;
    const last = lastWin(j);
    // Unknown length: one window past the furthest asked for, so an empty answer stops the run without wasting many calls.
    const furthest = j.wins.reduce((m, s, k) => (s && s !== "todo" ? k : m), -1);
    const limit = last ?? (Date.now() - j.born < GRACE_MS ? 0 : furthest + 1);
    for (let i = 0; i <= limit; i++) if ((j.wins[i] ?? "todo") === "todo") return { j, i };
  }
  return null;
}

function pump() {
  while (Q.busy.lite < LIMIT.lite && level() < 3) {
    const t = nextLite();
    if (!t) break;
    const { j, i } = t;
    j.wins[i] = "running";
    Q.busy.lite++;
    const run = runLite(j, i)
      .catch(() => void (j.wins[i] = "failed"))
      .finally(async () => {
        Q.busy.lite--;
        await persist(j).catch(() => {});
        pump();
      });
    j.runs.set(i, run);
  }
  while (Q.busy.frame < LIMIT.frame) {
    // A picture a student asked for is always taken; automatic ones only on a normal day, for a video still open.
    for (const x of Q.jobs.values()) if (x.frameQueue?.length && (!allowExtras() || Date.now() - x.seen > LEFT_MS)) x.frameQueue = x.frameQueue.filter((id) => x.wanted.has(id));
    const j = [...Q.jobs.values()].reverse().find((x) => x.frameQueue?.length);
    if (!j) break;
    const id = j.frameQueue!.shift()!;
    Q.busy.frame++;
    runFrame(j, id).finally(async () => {
      Q.busy.frame--;
      await persist(j).catch(() => {});
      pump();
    });
  }
  while (Q.busy.describe < LIMIT.describe && allowExtras()) {
    const j = [...Q.jobs.values()].reverse().find((x) => x.pending.length && Date.now() - x.seen <= LEFT_MS);
    if (!j) break;
    const ids = j.pending.shift()!;
    Q.busy.describe++;
    j.describing++;
    runDescribe(j, ids)
      .catch(() => {})
      .finally(async () => {
        Q.busy.describe--;
        j.describing--;
        await persist(j).catch(() => {});
        pump();
      });
  }
}

const transcribed = (j: Saved) => {
  const last = lastWin(j);
  return last !== null && Array.from({ length: last + 1 }, (_, i) => j.wins[i]).every((s) => s === "done" || s === "failed");
};

// ---- entry points ----

async function load(vid: string): Promise<Saved | null> {
  try {
    return JSON.parse(await readFile(file(vid), "utf8"));
  } catch {
    return null;
  }
}

/** Get or start the job. `seed`: segments already known (the opt-in captions route): no transcription, only describing. */
const touch = (j: Job) => {
  j.seen = Date.now();
  Q.jobs.delete(j.vid);
  Q.jobs.set(j.vid, j);
};

export async function job(vid: string, url: string, seed?: TwinNode[]): Promise<Job> {
  let j = Q.jobs.get(vid);
  if (j) return touch(j), j;
  const saved = await load(vid);
  j = Q.jobs.get(vid); // another request may have started it while the file was read
  if (j) return j;
  const fresh: Saved = { url, duration: 0, ended: null, source: seed ? "captions" : "gemini", segs: [], wins: [], lite: {}, described: {}, headings: {}, pending: [] };
  j = { ...(saved ?? fresh), vid, runs: new Map(), describing: 0, born: Date.now(), taken: await frameIndex(vid), seen: Date.now(), wanted: new Set() };
  if (saved && saved.rescanned === undefined) {
    j.legacy = true;
    j.rescanned = Object.keys(saved.visual ?? {});
  }
  setTimeout(pump, GRACE_MS + 50).unref();
  j.wins = j.wins.map((s) => (s === "running" ? "todo" : s)); // a restart mid-call: ask again
  if (!saved && seed) {
    j.segs = seed;
    j.duration = Math.max(...seed.map((s) => s.end ?? 0));
    j.wins = Array.from({ length: winOf(Math.max(0, j.duration - 1)) + 1 }, () => "done" as const);
    for (const w of windows(seed)) {
      const need = w.filter((s) => POINTS_AT.test(s.text)).map((s) => s.id);
      if (need.length) j.pending.push(need);
    }
  }
  Q.jobs.set(vid, j);
  if ((j.wins[0] ?? "todo") === "todo") Q.urgent.unshift({ vid, i: 0 }); // the first window is what /api/load waits for
  pump();
  return j;
}

/** Wait for the first window (at most `ms`), for the response to /api/load. */
export async function firstWindow(j: Job, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until && (j.wins[0] ?? "todo") !== "done" && j.wins[0] !== "failed") await (j.runs.get(0) ? Promise.race([j.runs.get(0), sleep(until - Date.now())]) : sleep(100));
}

/** The player reported the length: windows stop there. */
export function setDuration(vid: string, seconds: number) {
  const j = Q.jobs.get(vid);
  seconds = Math.min(seconds, MAX_VIDEO_S);
  if (!j || !(seconds > 0) || j.duration === Math.round(seconds)) return false;
  j.duration = Math.round(seconds);
  if (j.ended !== null && j.wins[j.ended] === "failed") j.wins[j.ended] = "todo"; // it failed only because the end was unknown
  j.ended = null;
  touch(j);
  pump();
  return true;
}

/** The student moved to `at` seconds: that window is transcribed next, and its describing goes first. */
export function prioritise(vid: string, at: number) {
  const j = Q.jobs.get(vid);
  if (!j || !(at >= 0)) return false;
  const i = winOf(at);
  touch(j);
  if ((j.wins[i] ?? "todo") === "todo") Q.urgent.unshift({ vid, i });
  const k = j.pending.findIndex((ids) => ids.some((id) => j.segs.find((s) => s.id === id && s.start! <= at && at < s.end!)));
  if (k > 0) j.pending.unshift(...j.pending.splice(k, 1));
  const here = j.segs.find((s) => s.start! <= at && at < s.end!)?.id;
  if (j.legacy) {
    // Saved before `visual`/`at` existed: describe the window under the cursor now (not the whole video), so pictures appear as the student moves.
    const ids = ordered(j).filter((s) => winOf(s.start!) === i && !j.rescanned!.includes(s.id) && (POINTS_AT.test(s.text) || j.lite[s.id] || j.described[s.id])).map((s) => s.id);
    if (ids.length) {
      j.rescanned!.push(...ids);
      j.pending.unshift(ids);
    }
  }
  const f = here ? (j.frameQueue ?? []).indexOf(here) : -1;
  if (f > 0) j.frameQueue!.unshift(...j.frameQueue!.splice(f, 1)); // the picture under the cursor goes first
  pump();
  return true;
}

/** The student asked for the picture of this segment: taken next, whatever the cap. */
export function requestFrame(vid: string, node: string): "ready" | "queued" | "unknown" | string {
  const j = Q.jobs.get(vid);
  if (!j || !j.segs.some((s) => s.id === node)) return "unknown";
  if (j.taken[node]) return "ready";
  if (j.noFrames) return j.noFrames;
  const q = (j.frameQueue ??= []);
  if (q.includes(node)) q.splice(q.indexOf(node), 1);
  q.unshift(node);
  j.wanted.add(node);
  touch(j);
  pump();
  return "queued";
}

/** After a restart the job is only on disk: bring it back so a request about it (a frame, a position) finds it. */
export async function restore(vid: string): Promise<boolean> {
  if (Q.jobs.has(vid)) return true;
  const saved = await load(vid);
  if (!saved) return false;
  await job(vid, saved.url);
  return true;
}

export const atNode = (vid: string, node: string) => Q.jobs.get(vid)?.segs.find((s) => s.id === node)?.start;

export async function status(vid: string): Promise<Status> {
  const live = Q.jobs.get(vid);
  if (live) {
    const back = Date.now() - live.seen > LEFT_MS;
    live.seen = Date.now(); // the open lecture polls this: the student is still here
    if (back) pump();
  }
  const j: Saved | null = live ?? (await load(vid));
  if (!j) return { done: false, transcribed: false, duration: 0, segments: [], headings: {}, shown: {}, frames: {} };
  const shown: Record<string, string> = {};
  for (const s of j.segs) {
    const v = j.described[s.id] ?? j.lite[s.id];
    if (v !== undefined) shown[s.id] = v;
  }
  const t = transcribed(j);
  return {
    done: t && !j.pending.length && !live?.describing,
    transcribed: t,
    duration: j.duration,
    segments: ordered(j).map((s) => ({ ...s, heading: j.headings[s.id] ?? s.heading, ...(shown[s.id] !== undefined ? { shown: shown[s.id] } : {}) })),
    headings: j.headings,
    shown,
    frames: await frameIndex(vid), // from disk, so pictures show even for a job held in memory since before they existed
    ...(j.noFrames ? { noFrames: j.noFrames } : {}),
  };
}

/** Caption segments grouped into windows of at most 150 s (the captions route has no lite windows). */
export function windows<T extends { start?: number; end?: number }>(segs: T[]): T[][] {
  const out: T[][] = [];
  for (const s of segs) {
    const w = out[out.length - 1];
    if (w && s.end! - w[0].start! <= 150) w.push(s);
    else out.push([s]);
  }
  return out;
}

/** For checks: every model call so far, one line each. */
export const calls = () => [...Q.calls];
