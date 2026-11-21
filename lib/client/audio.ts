// Browser audio helpers: base64 PCM16, WAV wrapping, and 16 kHz microphone capture.

export function b64ToPcm(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
}

function pcmToB64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Mono PCM16 chunks to a WAV blob, so an <audio> element can play it with pitch-preserving speed. */
export function wavBlob(chunks: Int16Array[], rate: number): Blob {
  const len = chunks.reduce((n, c) => n + c.byteLength, 0);
  const h = new DataView(new ArrayBuffer(44));
  const tag = (o: number, s: string) => [...s].forEach((ch, i) => h.setUint8(o + i, ch.charCodeAt(0)));
  tag(0, "RIFF");
  h.setUint32(4, 36 + len, true);
  tag(8, "WAVEfmt ");
  h.setUint32(16, 16, true);
  h.setUint16(20, 1, true); // PCM
  h.setUint16(22, 1, true); // mono
  h.setUint32(24, rate, true);
  h.setUint32(28, rate * 2, true);
  h.setUint16(32, 2, true);
  h.setUint16(34, 16, true);
  tag(36, "data");
  h.setUint32(40, len, true);
  return new Blob([h.buffer, ...chunks.map((c) => c.slice().buffer)], { type: "audio/wav" });
}

// The microphone stays open after the first grant and only the chunks sent are gated: opening it on every key press
// cost a few hundred ms and clipped the first word.
let live: { stream: MediaStream; ctx: AudioContext } | undefined;
let sink: ((b64: string) => void) | undefined;
// About 200 ms of audio from before the key went down, so a word started with the key press is not clipped.
const PRE_MS = 200;
const TAIL_MS = 250; // people release the key while finishing the last word
const TAIL_QUIET_MS = 80; // the last 200 ms were already quiet: only the chunk still in flight
let pre: Int16Array[] = [];
let level = { sum: 0, n: 0 }; // over the current ask: mean square of samples sent
let frames: { n: number; db: number }[] = []; // per chunk sent: samples and level, for the end-of-speech and no-speech checks
const dbOf = (ms: number) => 10 * Math.log10(ms / 0x8000 ** 2 + 1e-12);
let cut: (() => void) | undefined;
/** Ends the release tail now (a new ask starts straight after this one). */
export const cutTail = () => cut?.();
/** What the microphone heard in one ask: milliseconds clearly above the room's own noise, and the mean level. */
export interface MicStats {
  speechMs: number;
  db: number;
}
const QUIET_DBFS = -45; // a whole ask below this is a quiet speaker or the wrong microphone

/** Low-pass then decimate any input rate to 16 kHz: a 63-tap windowed sinc cut at 7 kHz, state kept across chunks. */
export function resampler(rate: number): (input: Float32Array) => Float32Array {
  if (rate === 16000) return (x) => x;
  const N = 63, M = (N - 1) / 2, fc = 7000 / rate;
  const h = Float32Array.from({ length: N }, (_, i) => {
    const k = i - M;
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    return sinc * (0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (N - 1)));
  });
  const step = rate / 16000;
  let hist = new Float32Array(N - 1); // the last N-1 input samples of the previous chunk
  let pos = 0; // next output position, in samples of the current chunk
  return (input) => {
    const x = new Float32Array(hist.length + input.length);
    x.set(hist);
    x.set(input, hist.length);
    const out: number[] = [];
    for (; pos + M < input.length; pos += step) {
      const c = Math.floor(pos) + hist.length; // centre in x
      let acc = 0;
      for (let j = 0; j < N; j++) acc += h[j] * x[c - M + j];
      out.push(acc);
    }
    pos -= input.length;
    hist = x.slice(x.length - (N - 1));
    return Float32Array.from(out);
  };
}

function toPcm(x: Float32Array): Int16Array {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = Math.max(-1, Math.min(1, x[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

async function openMic() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  // The browser resamples the microphone to 16 kHz properly; where it refuses, our own low-pass runs instead.
  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ sampleRate: 16000 });
  } catch {
    ctx = new AudioContext();
  }
  const resample = resampler(ctx.sampleRate);
  const src = ctx.createMediaStreamSource(stream);
  // shortcut: ScriptProcessorNode is deprecated but needs no worklet file; move to AudioWorklet if Chrome drops it.
  // 1024 frames is 64 ms at 16 kHz, so the last words reach the relay soon after release.
  const proc = ctx.createScriptProcessor(ctx.sampleRate === 16000 ? 1024 : 2048, 1, 1);
  proc.onaudioprocess = (e) => {
    const out = toPcm(resample(e.inputBuffer.getChannelData(0)));
    if (!sink) {
      pre.push(out);
      let n = pre.reduce((a, c) => a + c.length, 0);
      while (pre.length > 1 && n - pre[0].length >= (PRE_MS * 16000) / 1000) n -= pre.shift()!.length;
      return;
    }
    let sq = 0;
    for (const v of out) sq += v * v;
    level.sum += sq;
    level.n += out.length;
    frames.push({ n: out.length, db: dbOf(sq / Math.max(1, out.length)) });
    sink(pcmToB64(out));
  };
  src.connect(proc);
  proc.connect(ctx.destination); // a ScriptProcessor only runs while connected; it outputs silence
  live = { stream, ctx };
}

/**
 * Sends microphone audio to onChunk as base64 PCM16 at 16 kHz, starting with about 200 ms from before the call, until
 * the returned stop function resolves (about 250 ms after it is called). A very quiet ask fires "arc:quiet" on window.
 */
export async function startMic(onChunk: (b64: string) => void): Promise<(now?: boolean) => Promise<MicStats | undefined>> {
  if (!live || live.stream.getAudioTracks()[0]?.readyState !== "live") {
    void live?.ctx.close();
    pre = [];
    await openMic();
  }
  if (live!.ctx.state === "suspended") await live!.ctx.resume();
  level = { sum: 0, n: 0 };
  frames = [];
  for (const c of pre.splice(0)) onChunk(pcmToB64(c));
  sink = onChunk;
  return async (now = false) => {
    // Speech that ended before release (the last 200 ms are 18 dB under the loudest chunk) needs no tail.
    let last = 0, n = 0;
    for (let i = frames.length - 1; i >= 0 && n < 3200; i--) { last += frames[i].db * frames[i].n; n += frames[i].n; }
    const peak = Math.max(-200, ...frames.map((f) => f.db));
    const wait = now ? 0 : n && last / n < peak - 18 ? TAIL_QUIET_MS : TAIL_MS; // now: a tap has no words to finish
    await new Promise<void>((r) => {
      const t = setTimeout(r, wait);
      cut = () => (clearTimeout(t), r());
    });
    cut = undefined;
    const db = dbOf(level.sum / Math.max(1, level.n));
    if (sink !== onChunk) return undefined; // another ask has taken the microphone
    sink = undefined;
    // Speech frames: above -50 dBFS and 10 dB over the room (the 20th percentile), so an amplified noise floor is not speech.
    const sorted = frames.map((f) => f.db).sort((a, b) => a - b);
    const gate = Math.max(-50, (sorted[Math.floor(sorted.length * 0.2)] ?? -120) + 10);
    const speechMs = frames.filter((f) => f.db > gate).reduce((t, f) => t + f.n / 16, 0);
    // A soft voice (speech over the room's noise, but under -45 dBFS overall) is "too quiet"; no speech at all is "heard nothing".
    if (speechMs >= 120 && level.n > 16000 * 0.4 && db < QUIET_DBFS) window.dispatchEvent(new CustomEvent("arc:quiet", { detail: { db } }));
    return { speechMs, db };
  };
}
