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

async function openMic() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  // shortcut: ScriptProcessorNode is deprecated but needs no worklet file; move to AudioWorklet if Chrome drops it.
  // 2048 frames is about 43 ms at 48 kHz, so the last words reach the relay soon after release.
  const proc = ctx.createScriptProcessor(2048, 1, 1);
  const step = ctx.sampleRate / 16000;
  proc.onaudioprocess = (e) => {
    if (!sink) return;
    const input = e.inputBuffer.getChannelData(0);
    const out = new Int16Array(Math.floor(input.length / step));
    for (let i = 0; i < out.length; i++) {
      // average the samples that fold into one 16 kHz sample (cheap low-pass)
      const a = Math.floor(i * step);
      const b = Math.min(input.length, Math.floor((i + 1) * step));
      let sum = 0;
      for (let j = a; j < b; j++) sum += input[j];
      const v = Math.max(-1, Math.min(1, sum / Math.max(1, b - a)));
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    sink(pcmToB64(out));
  };
  src.connect(proc);
  proc.connect(ctx.destination); // a ScriptProcessor only runs while connected; it outputs silence
  live = { stream, ctx };
}

/** Sends microphone audio to onChunk as base64 PCM16 at 16 kHz until the returned stop function is called. */
export async function startMic(onChunk: (b64: string) => void): Promise<() => void> {
  if (!live || live.stream.getAudioTracks()[0]?.readyState !== "live") {
    void live?.ctx.close();
    await openMic();
  }
  if (live!.ctx.state === "suspended") await live!.ctx.resume();
  sink = onChunk;
  return () => {
    if (sink === onChunk) sink = undefined;
  };
}
