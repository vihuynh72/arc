// Called by app/api/speak/route.ts. Kokoro runs in a small pool of child processes (lib/server/kokoro-worker.mjs), so
// synthesis never blocks this process's event loop. Finished clips sit in an in-memory LRU and on disk.
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { ENGLISH, type Voice } from "@/lib/server/voices";
import { geminiSpeak as gemini } from "@/lib/server/geminiVoice";
import { isPrivateText } from "@/lib/server/vault"; // a private page's words: memory cache only, never the disk

export const MAX_CHARS = 600;
export const MAX_WAITING = 8; // more than this many clips waiting is answered 503 at once; the client waits and retries
export class Busy extends Error {}

// fp32 measured 2x faster than q8 on Apple silicon (70 chars: 1.1 s vs 2.2 s) and is the reference quality; q4/fp16 were no faster.
const DTYPE = process.env.ARC_KOKORO_DTYPE ?? "fp32";
// Measured on a 10-core M5: two clips side by side take as long as one after the other (the cores are shared), so only
// RUN workers synthesise at once and the clip the student waits for gets every core. The second process is a warm spare:
// when a running clip is abandoned its process is killed and the spare takes the next clip at once.
const SIZE = Number(process.env.ARC_KOKORO_WORKERS) || (availableParallelism() >= 8 ? 2 : 1);
const RUN = Math.min(SIZE, Number(process.env.ARC_KOKORO_PARALLEL) || 1);
const THREADS = Math.max(1, Math.floor(Math.min(8, availableParallelism()) / RUN));
const DIR = `.cache/kokoro/${DTYPE}`;
const LRU_MAX = 200; // about 0.3 MB per sentence of 16-bit audio

interface Job {
  key: string;
  text: string;
  voice: Voice;
  prio: number; // 0 = the clip the student is waiting for; higher = further ahead
  seq: number;
  live: number; // requests still waiting for this clip
  done: Promise<Buffer>;
  resolve: (b: Buffer) => void;
  reject: (e: Error) => void;
  slot?: Slot; // set while a worker is making it
}
interface Slot {
  w: ChildProcess;
  ready: Promise<void>;
  up?: boolean; // posted {ready}
  job?: Job;
}
interface Pool {
  slots: Slot[];
  queue: Job[];
  jobs: Map<string, Job>;
  lru: Map<string, Buffer>;
  seq: number;
  missing: number; // workers killed or crashed, not yet replaced
}
const g = globalThis as typeof globalThis & { __arcKokoroPool?: Pool };

// Not bundled by Next: the server always runs from the repo root (tsx server.ts), in dev and production alike.
const WORKER = path.join(/* turbopackIgnore: true */ process.cwd(), "lib/server/kokoro-worker.mjs");

function spawn(p: Pool): Slot {
  const w = fork(WORKER, [], {
    serialization: "advanced", // Buffers cross as bytes, not JSON
    env: { ...process.env, ARC_KOKORO_WORKER: JSON.stringify({ dtype: DTYPE, threads: THREADS }) },
    execArgv: [], // not tsx's loader: the worker is plain JS
  });
  let ok!: () => void, bad!: (e: Error) => void;
  const slot: Slot = { w, ready: new Promise<void>((a, b) => ((ok = a), (bad = b))) };
  slot.ready.catch(() => {});
  w.on("message", (m: { ready?: true; fatal?: string; id?: string; wav?: Uint8Array; error?: string }) => {
    if (m.ready) return (slot.up = true), ok(), pump(p);
    if (m.fatal) return bad(new Error(m.fatal));
    const job = slot.job;
    if (!job || job.key !== m.id) return;
    slot.job = job.slot = undefined;
    p.jobs.delete(job.key);
    if (m.wav) {
      const wav = Buffer.from(m.wav.buffer, m.wav.byteOffset, m.wav.byteLength);
      remember(p, job.key, wav);
      if (!isPrivateText(job.text)) void mkdir(DIR, { recursive: true }).then(() => writeFile(`${DIR}/${job.key}.wav`, wav)).catch(() => {});
      job.resolve(wav);
    } else job.reject(new Error(m.error ?? "speech failed"));
    pump(p);
    refill(p);
  });
  w.on("error", (e) => bad(e));
  w.on("exit", () => {
    // A crash or an abort-kill: fail its clip; a fresh worker takes its place (see refill).
    const i = p.slots.indexOf(slot);
    if (i < 0) return;
    slot.job?.reject(new Error("aborted"));
    if (slot.job) p.jobs.delete(slot.job.key);
    p.slots.splice(i, 1);
    if (slot.up) return p.missing++, pump(p), refill(p);
    // The model never loaded (no download, no memory): give up on this pool; the next request starts a fresh one.
    if (p.slots.length) return;
    for (const j of p.queue) j.reject(new Error("speech model failed to load"));
    if (g.__arcKokoroPool === p) g.__arcKokoroPool = undefined;
  });
  return slot;
}

function pool(): Pool {
  if (!g.__arcKokoroPool) {
    const p: Pool = { slots: [], queue: [], jobs: new Map(), lru: new Map(), seq: 0, missing: 0 };
    g.__arcKokoroPool = p;
    for (let i = 0; i < SIZE; i++) p.slots.push(spawn(p));
  }
  return g.__arcKokoroPool;
}

/** Resolves when the first worker has its model loaded and warmed (server.ts warms this at start). */
export function model(): Promise<void> {
  return Promise.any(pool().slots.map((s) => s.ready));
}
export const warmKokoro = () => void model().catch(() => {});

/** Replace lost workers, but only while nothing is being made: loading a model takes every core for about a second, and
 * the clip the student is waiting for should not share them. With no loaded worker left, replace at once. */
function refill(p: Pool) {
  if (!p.missing || (p.slots.some((s) => s.up) && (p.queue.length || p.slots.some((s) => s.job)))) return;
  for (; p.missing > 0; p.missing--) p.slots.push(spawn(p));
}

function remember(p: Pool, key: string, wav: Buffer) {
  p.lru.delete(key);
  p.lru.set(key, wav);
  if (p.lru.size > LRU_MAX) p.lru.delete(p.lru.keys().next().value!);
}

/** Give each idle, loaded worker the most urgent waiting clip. */
function pump(p: Pool) {
  for (const slot of p.slots) {
    if (!slot.up || slot.job || !p.queue.length || p.slots.filter((s) => s.job).length >= RUN) continue;
    p.queue.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
    const job = p.queue.shift()!;
    slot.job = job;
    job.slot = slot;
    const v = job.voice;
    slot.w.send({ id: job.key, text: job.text, voice: v.voice, engine: v.engine, espeak: v.espeak, model: v.file && voicePath(v.file.path) });
  }
}

/** The requester left. When nobody wants the clip any more, a waiting job leaves the queue and a running one has its
 * worker killed (ONNX cannot be interrupted mid-run) so the CPU goes to the clip the student is waiting for now. */
function leave(p: Pool, job: Job) {
  if (--job.live > 0 || p.jobs.get(job.key) !== job) return; // still wanted, or already finished
  if (job.slot) return void job.slot.w.kill("SIGKILL");
  const i = p.queue.indexOf(job);
  if (i >= 0) p.queue.splice(i, 1);
  p.jobs.delete(job.key);
  job.reject(new Error("aborted"));
}

// Gemini clips in flight, by key: one request per sentence however many readers ask (each costs money).
const paid = new Map<string, Promise<Buffer>>();
/** The voice that actually made a clip when it was not the one asked for (the paid voice's local fallback). */
export const spokenBy = new WeakMap<Buffer, Voice>();
let paidDown = 0; // after a failure (it took about 6 s with retries), Gemini is not asked again for 5 minutes

/** WAV bytes for the text in that voice. prio 0 is the clip being waited for; prefetches pass a higher number. */
export async function speak(text: string, voice: Voice = ENGLISH, signal?: AbortSignal, prio = 0): Promise<Buffer> {
  const p = pool();
  // English keeps its old key, so clips cached before other languages existed still hit.
  const key = createHash("sha1").update((voice.engine === "kokoro" ? "" : `${voice.engine}:`) + voice.voice + text).digest("hex");
  const hit = p.lru.get(key);
  if (hit) return remember(p, key, hit), hit;
  let job = p.jobs.get(key);
  if (!job) {
    const disk = await readFile(`${DIR}/${key}.wav`).catch(() => null);
    if (disk) return remember(p, key, disk), disk;
    if (signal?.aborted) throw new Error("aborted");
    if (voice.engine === "gemini") {
      // Not a worker job: no CPU is involved, and an abandoned request is let finish (it is paid for and cached).
      let made = paid.get(key);
      if (!made) {
        // Gemini down (quota, spending cap): the local voice reads instead, worse but not silent. Its clip is cached under its own key.
        const local = voice.fallback;
        made = (Date.now() < paidDown ? Promise.reject(new Error("paid voice unavailable")) : gemini(text, voice.voice))
          .then((wav) => (remember(p, key, wav), isPrivateText(text) || void mkdir(DIR, { recursive: true }).then(() => writeFile(`${DIR}/${key}.wav`, wav)).catch(() => {}), wav))
          .catch((e) => ((paidDown = Math.max(paidDown, Date.now() + 5 * 60_000)), local && voiceReady(local) ? speak(text, local, signal, prio).then((w) => (spokenBy.set(w, local), w)) : Promise.reject(e)))
          .finally(() => paid.delete(key));
        paid.set(key, made);
      }
      return made;
    }
    job = p.jobs.get(key); // another request may have queued it while the disk was read
    if (!job) {
      if (p.queue.length >= MAX_WAITING) {
        // Full: a more urgent clip pushes out the least urgent waiting one; otherwise this one is turned away.
        const worst = p.queue.reduce((a, b) => (b.prio > a.prio || (b.prio === a.prio && b.seq > a.seq) ? b : a));
        if (worst.prio <= prio) throw new Busy("speech queue full");
        p.queue.splice(p.queue.indexOf(worst), 1);
        p.jobs.delete(worst.key);
        worst.reject(new Busy("speech queue full"));
      }
      let resolve!: (b: Buffer) => void, reject!: (e: Error) => void;
      const done = new Promise<Buffer>((a, b) => ((resolve = a), (reject = b)));
      done.catch(() => {});
      job = { key, text, voice, prio, seq: p.seq++, live: 0, done, resolve, reject };
      p.jobs.set(key, job);
      p.queue.push(job);
    }
  }
  const j = job;
  j.live++;
  if (prio < j.prio) j.prio = prio; // the student now needs a clip that was only prefetched
  if (signal) {
    if (signal.aborted) leave(p, j);
    else signal.addEventListener("abort", () => leave(p, j), { once: true });
  }
  pump(p);
  return j.done;
}

// Piper voices download on first use, once, from rhasspy/piper-voices only, checked against the size and MD5 in voices.ts.
const VOICE_DIR = path.join(/* turbopackIgnore: true */ process.cwd(), ".cache/voices");
const voicePath = (p: string) => path.join(VOICE_DIR, path.basename(p));
const fetching = new Map<string, Promise<void>>();

async function download(url: string, dest: string, size: number, md5: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!r.ok || !r.body) throw new Error(`voice download ${r.status}`);
  const hash = createHash("md5");
  let n = 0;
  const part = `${dest}.part`;
  const out = createWriteStream(part);
  try {
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      n += chunk.length;
      if (!out.write(chunk)) await new Promise<void>((ok) => out.once("drain", () => ok()));
    }
    await new Promise<void>((ok, bad) => out.end((e?: Error | null) => (e ? bad(e) : ok())));
    if (n !== size || hash.digest("hex") !== md5) throw new Error(`voice file ${path.basename(dest)} failed its check`);
    await rename(part, dest);
  } catch (e) {
    out.destroy();
    await rm(part, { force: true });
    throw e;
  }
}

/** True when the voice can speak now. Otherwise starts its download (once) and returns false: the caller says "one moment". */
export function voiceReady(v: Voice): boolean {
  const f = v.file;
  if (!f) return true;
  const onnx = voicePath(f.path);
  if (existsSync(onnx) && existsSync(`${onnx}.json`)) return true;
  if (!fetching.has(f.path)) {
    const base = "https://huggingface.co/rhasspy/piper-voices/resolve/main/";
    const t0 = Date.now();
    const job = mkdir(VOICE_DIR, { recursive: true })
      .then(() => Promise.all([download(base + f.path, onnx, f.size, f.md5), download(`${base}${f.path}.json`, `${onnx}.json`, f.jsonSize, f.jsonMd5)]))
      .then(() => console.log(`[voices] ${path.basename(onnx)} ready in ${Date.now() - t0} ms`))
      .catch((e) => console.error(`[voices] ${path.basename(onnx)}: ${e instanceof Error ? e.message : e}`))
      .finally(() => fetching.delete(f.path));
    fetching.set(f.path, job);
  }
  return false;
}
