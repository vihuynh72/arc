// Called by app/api/speak/route.ts. One Kokoro model per process (on globalThis), every clip cached on disk.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { KokoroTTS } from "kokoro-js";

type G = typeof globalThis & { __arcKokoro?: Promise<KokoroTTS>; __arcKokoroQueue?: Promise<unknown>; __arcClips?: Map<string, Promise<Buffer>> };
const g = globalThis as G;
const DIR = ".cache/kokoro";

export const MAX_CHARS = 600;
export const DEFAULT_VOICE = "af_bella";

function model(): Promise<KokoroTTS> {
  g.__arcKokoro ??= KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" }).catch((e) => {
    g.__arcKokoro = undefined; // let the next request retry the download
    throw e;
  });
  return g.__arcKokoro;
}

/** Start loading the model now so the first spoken line is not waiting on it. */
export const warmKokoro = () => void model().catch(() => {});

/** WAV bytes for the text. shortcut: generations run one at a time, fine for one student on one laptop. */
export function speak(text: string, voice = DEFAULT_VOICE, signal?: AbortSignal): Promise<Buffer> {
  const key = createHash("sha1").update(voice + text).digest("hex");
  const clips = (g.__arcClips ??= new Map());
  let clip = clips.get(key);
  if (!clip) {
    const file = `${DIR}/${key}.wav`;
    clip = readFile(file).catch(async () => {
      const run = async () => {
        if (signal?.aborted) throw new Error("aborted"); // the listener moved on while this waited in the queue
        const audio = await (await model()).generate(text, { voice: voice as never });
        const wav = Buffer.from(audio.toWav());
        await mkdir(DIR, { recursive: true });
        await writeFile(file, wav);
        return wav;
      };
      const next = (g.__arcKokoroQueue ?? Promise.resolve()).then(run, run);
      g.__arcKokoroQueue = next.catch(() => {});
      return next;
    });
    clips.set(key, clip);
    clip.catch(() => clips.delete(key));
  }
  return clip;
}
