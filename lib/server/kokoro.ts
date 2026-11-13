// Called by app/api/speak/route.ts. One Kokoro model per process (on globalThis), every clip cached on disk.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { KokoroTTS } from "kokoro-js";

interface Job {
  live: number; // requests still waiting for this clip
  dropped: boolean; // all of them left before it started: skipped, and no longer counted as waiting
  started: boolean;
  queued: boolean; // counted in __arcKokoroPending
}
type G = typeof globalThis & {
  __arcKokoro?: Promise<KokoroTTS>;
  __arcKokoroQueue?: Promise<unknown>;
  __arcClips?: Map<string, Promise<Buffer>>;
  __arcKokoroPending?: number;
  __arcKokoroJobs?: Map<string, Job>;
};
const g = globalThis as G;
const DIR = ".cache/kokoro";

export const MAX_CHARS = 600;
export const DEFAULT_VOICE = "af_bella";
export const MAX_WAITING = 4; // a small host: more than one running plus this many waiting is answered 503 at once
export class Busy extends Error {}

export function model(): Promise<KokoroTTS> {
  g.__arcKokoro ??= KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" }).catch((e) => {
    g.__arcKokoro = undefined; // let the next request retry the download
    throw e;
  });
  return g.__arcKokoro;
}

/** Start loading the model now so the first spoken line is not waiting on it. */
export const warmKokoro = () => void model().catch(() => {});

/** WAV bytes for the text. Generations run one at a time. A clip whose every requester has gone (the reader moved on)
 * leaves the queue count at once and is skipped when its turn comes, so stale prefetches never crowd out the clip the
 * listener is waiting for, and a stale request never cancels a live one for the same text. */
export function speak(text: string, voice = DEFAULT_VOICE, signal?: AbortSignal): Promise<Buffer> {
  const key = createHash("sha1").update(voice + text).digest("hex");
  const clips = (g.__arcClips ??= new Map());
  const jobs = (g.__arcKokoroJobs ??= new Map());
  let clip = clips.get(key);
  let job = jobs.get(key);
  if (!clip || !job) {
    const mine: Job = (job = { live: 0, dropped: false, started: false, queued: false });
    jobs.set(key, mine);
    const file = `${DIR}/${key}.wav`;
    clip = readFile(file).catch(async () => {
      if ((g.__arcKokoroPending ?? 0) > MAX_WAITING) throw new Busy("speech queue full");
      g.__arcKokoroPending = (g.__arcKokoroPending ?? 0) + 1;
      mine.queued = true;
      if (mine.live === 0) drop(mine); // every requester left while the disk was read
      const run = async () => {
        mine.started = true;
        if (mine.dropped) throw new Error("aborted"); // the listener moved on while this waited in the queue
        const audio = await (await model()).generate(text, { voice: voice as never });
        const wav = Buffer.from(audio.toWav());
        await mkdir(DIR, { recursive: true });
        await writeFile(file, wav);
        return wav;
      };
      const next = (g.__arcKokoroQueue ?? Promise.resolve()).then(run, run).finally(() => {
        if (!mine.dropped) g.__arcKokoroPending = (g.__arcKokoroPending ?? 1) - 1;
      });
      g.__arcKokoroQueue = next.catch(() => {});
      return next;
    });
    clips.set(key, clip);
    clip.catch(() => clips.delete(key)).finally(() => jobs.get(key) === mine && jobs.delete(key));
  } else if (job.dropped && !job.started) {
    // a listener wants a clip that was dropped but has not run yet: it counts again and will be made
    job.dropped = false;
    g.__arcKokoroPending = (g.__arcKokoroPending ?? 0) + 1;
  }
  const j = job;
  j.live++;
  const leave = () => {
    if (--j.live === 0) drop(j);
  };
  if (signal?.aborted) leave();
  else signal?.addEventListener("abort", leave, { once: true });
  return clip!;
}

function drop(job: Job) {
  if (job.started || job.dropped || !job.queued) return;
  job.dropped = true;
  g.__arcKokoroPending = (g.__arcKokoroPending ?? 1) - 1;
}
