// Child process for lib/server/kokoro.ts: one Kokoro model per process, so synthesis never blocks the server's event loop.
// A process, not a worker thread: onnxruntime-node crashes with two worker threads in one process ("Entering the V8 API
// without proper locking"), and a process can be killed mid-run when the listener moves on.
// Plain .mjs on purpose: Next does not bundle it, and both `tsx server.ts` and production load it from lib/server/ as is.
import { KokoroTTS } from "kokoro-js";
import { StyleTextToSpeech2Model, AutoTokenizer } from "@huggingface/transformers";
import { readFile } from "node:fs/promises";

const ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const { dtype, threads } = JSON.parse(process.env.ARC_KOKORO_WORKER ?? "{}");
process.on("disconnect", () => process.exit(0)); // the server went away
const ready = Promise.all([
  StyleTextToSpeech2Model.from_pretrained(ID, { dtype, device: "cpu", session_options: threads ? { intraOpNumThreads: threads } : {} }),
  AutoTokenizer.from_pretrained(ID),
]).then(async ([m, t]) => {
  const tts = new KokoroTTS(m, t);
  await tts.generate("Ready.", { voice: "af_bella" }); // first run allocates; keep it off the first real line
  return tts;
});
ready.then(() => process.send({ ready: true }), (e) => process.send({ fatal: String(e?.message ?? e) }, () => process.exit(1)));

/** 16-bit PCM WAV: half the bytes of the float WAV kokoro-js writes, and the same audio to the ear. */
function wav16(samples, rate) {
  // Kokoro peaks past full scale now and then (Italian: 525 samples in 10 clips): scale the clip down rather than clip it.
  let peak = 1;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  if (peak > 1) samples = samples.map((s) => s / peak);
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return buf;
}

// Other languages (lib/server/voices.ts): Kokoro with espeak phonemes, or a Piper voice. Loaded on first use; at most MAX_OTHER Piper
// voices stay loaded (about 100 MB each), and one unused for IDLE_MS is released. English is never released.
const MAX_OTHER = 2;
const IDLE_MS = 10 * 60_000;
const piper = new Map(); // model path -> { v: Promise<{ session, config }>, used }
let lib; // g2p.mjs and onnxruntime-node, imported on the first non-English clip
const libs = async () => (lib ??= Promise.all([import("./g2p.mjs"), import("onnxruntime-node")]).then(([g, ort]) => ({ g, ort: ort.default ?? ort })));
const drop = (k) => {
  const e = piper.get(k);
  piper.delete(k);
  void e?.v.then((x) => x.session.release(), () => {});
};
async function piperVoice(model) {
  let e = piper.get(model);
  if (!e) {
    const { g, ort } = await libs();
    e = { v: readFile(`${model}.json`, "utf8").then((c) => g.piperLoad(ort, model, JSON.parse(c), threads)), used: Date.now() };
    e.v.catch(() => piper.delete(model));
    piper.set(model, e);
    while (piper.size > MAX_OTHER) drop([...piper].filter(([k]) => k !== model).sort((a, b) => a[1].used - b[1].used)[0][0]);
  }
  e.used = Date.now();
  return e.v;
}
setInterval(() => {
  for (const [k, e] of piper) if (Date.now() - e.used > IDLE_MS) drop(k);
}, 60_000).unref();

process.on("message", async ({ id, text, voice, engine = "kokoro", espeak, model }) => {
  try {
    let a;
    if (engine === "piper") {
      const { g, ort } = await libs();
      a = await g.piperSpeak(ort, await piperVoice(model), text);
    } else if (espeak) a = await (await libs()).g.kokoroSpeak(await ready, text, voice, espeak);
    else {
      const r = await (await ready).generate(text, { voice });
      a = { audio: r.audio, rate: r.sampling_rate };
    }
    process.send({ id, wav: wav16(a.audio, a.rate) });
  } catch (e) {
    process.send({ id, error: String(e?.message ?? e) });
  }
});
