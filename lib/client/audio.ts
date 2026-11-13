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
let pre: Int16Array[] = [];
let level = { sum: 0, n: 0 }; // over the current ask: mean square of samples sent
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
    for (const v of out) level.sum += v * v;
    level.n += out.length;
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
export async function startMic(onChunk: (b64: string) => void): Promise<() => Promise<void>> {
  if (!live || live.stream.getAudioTracks()[0]?.readyState !== "live") {
    void live?.ctx.close();
    pre = [];
    await openMic();
  }
  if (live!.ctx.state === "suspended") await live!.ctx.resume();
  level = { sum: 0, n: 0 };
  for (const c of pre.splice(0)) onChunk(pcmToB64(c));
  sink = onChunk;
  return async () => {
    await new Promise((r) => setTimeout(r, TAIL_MS));
    if (sink !== onChunk) return;
    sink = undefined;
    const db = 10 * Math.log10(level.sum / Math.max(1, level.n) / 0x8000 ** 2 + 1e-12);
    if (level.n > 16000 * 0.4 && db < QUIET_DBFS) window.dispatchEvent(new CustomEvent("arc:quiet", { detail: { db } }));
  };
}
