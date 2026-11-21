// Kokoro in the visitor's browser (lib/client/localVoice.ts starts it). The model and the af_bella voice come from the
// Hugging Face hub and stay in the browser's Cache Storage; the ONNX runtime's .wasm is served by Arc itself (the bundler
// emits it). Only text in, WAV out: nothing about the page leaves the browser.
import { KokoroTTS, env } from "kokoro-js";

// transformers.js points the runtime at a CDN; unset, onnxruntime-web uses the .wasm the bundler emitted next to it.
env.wasmPaths = undefined as unknown as string;

const ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
let tts: Promise<KokoroTTS> | undefined;
const queue: { id: number; text: string; voice: string }[] = [];
let running = false;

type In = { type: "load"; device: "webgpu" | "wasm"; dtype: "fp32" | "fp16" | "q8" | "q4" | "q4f16" } | { type: "say"; id: number; text: string; voice: string } | { type: "drop"; ids: number[] };

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift()!;
    try {
      const t = await tts!;
      const s = performance.now();
      const a = await t.generate(job.text, { voice: job.voice as "af_bella" });
      const wav = a.toWav();
      postMessage({ type: "clip", id: job.id, wav, seconds: a.audio.length / a.sampling_rate, ms: performance.now() - s }, { transfer: [wav] });
    } catch (e) {
      postMessage({ type: "error", id: job.id, error: String((e as Error)?.message ?? e) });
    }
  }
  running = false;
}

self.onmessage = (e: MessageEvent<In>) => {
  const m = e.data;
  if (m.type === "load") {
    const t0 = performance.now();
    tts = KokoroTTS.from_pretrained(ID, { device: m.device, dtype: m.dtype });
    // A warm-up line: the first run allocates, and its speed tells the page whether this machine keeps up.
    void tts
      .then(async (t) => {
        await t.generate("Ready.", { voice: "af_bella" });
        const s = performance.now();
        const a = await t.generate("Photosynthesis turns the energy of sunlight into sugar.", { voice: "af_bella" });
        const rtf = (performance.now() - s) / 1000 / (a.audio.length / a.sampling_rate);
        postMessage({ type: "ready", rtf, loadMs: performance.now() - t0 });
      })
      .catch((err) => postMessage({ type: "fail", error: String(err?.message ?? err) }));
  } else if (m.type === "say") {
    queue.push(m);
    void pump();
  } else if (m.type === "drop") {
    for (let i = queue.length - 1; i >= 0; i--) if (m.ids.includes(queue[i].id)) queue.splice(i, 1);
  }
};
