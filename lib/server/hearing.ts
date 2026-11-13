// Context-aware transcription of one finished spoken request, and the local record of every ask.
// Generic live transcription has no idea what a student on this page is likely to say; a stronger model given the
// whole clip plus the page's names does. Every ask is kept on this laptop (.cache/asks, gitignored) so real failures
// can be replayed: the audio never goes anywhere else than the Gemini calls that already hear it.
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { GEMINI_HEARING_MODEL } from "../models";

export const ASK_DIR = ".cache/asks";

export interface Reading {
  text: string;
  alternatives: string[];
  confident: boolean;
  ms: number;
  model: string;
}

/** 16 kHz mono PCM16 to a WAV file. */
export function wav(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** RMS and peak in dBFS, and the fraction of samples at full scale. */
export function level(pcm: Buffer) {
  const n = pcm.length >> 1;
  let sum = 0, peak = 0, clipped = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2);
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (a >= 32767) clipped++;
  }
  const db = (x: number) => Math.round(20 * Math.log10(x / 32768 + 1e-9) * 10) / 10;
  return { rmsDb: db(Math.sqrt(sum / Math.max(1, n))), peakDb: db(peak), clipped: n ? clipped / n : 0 };
}

const COMMANDS =
  "next, back, again, more, stop, open, open the first one, tour, tour figure one, start the tour of figure one, leave, " +
  "where am I, help, take me to the <section>, find a paper about <topic>, bigger text, high contrast";

/** Headings and figure labels from the page context the browser sends ("Heading: first sentence" lines), at most 60. */
export function pageNames(context: string): string[] {
  const names = context
    .split("\n")
    .map((l) => l.match(/^([^:]{2,80}):/)?.[1]?.replace(/\s*\(figure\)$/, "").trim())
    .filter((s): s is string => !!s && !/^(title|stop \d+|open figure tour|where the student is now)$/i.test(s));
  return [...new Set(names)].slice(0, 60);
}

/** One REST call with the whole clip. Rejects on error or after timeoutMs. */
export async function hearWithContext(pcm: Buffer, context: string, timeoutMs = 6000, model = GEMINI_HEARING_MODEL): Promise<Reading> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const names = pageNames(context);
  const prompt =
    "A blind student is speaking a short command or question to a reading app. Transcribe exactly what they said. " +
    `They are likely to say one of these commands: ${COMMANDS} ... or a question about the page. ` +
    (names.length ? `Names on this page they may mention: ${names.join("; ")}. ` : "") +
    "Do not invent words that were not spoken; if the audio is silence or noise return an empty text. " +
    "Return JSON: text (what was said), alternatives (up to 3 other plausible readings, different from text), confident (true if the words were clear).";
  const t = Date.now();
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: "audio/wav", data: wav(pcm).toString("base64") } }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: { text: { type: "STRING" }, alternatives: { type: "ARRAY", items: { type: "STRING" } }, confident: { type: "BOOLEAN" } },
          required: ["text", "alternatives", "confident"],
        },
        temperature: 0,
        thinkingConfig: { thinkingLevel: /lite/.test(model) ? "minimal" : "low" }, // the larger models refuse "minimal"
      },
    }),
  });
  if (!res.ok) throw new Error(`hearing HTTP ${res.status}`);
  const j = await res.json();
  const raw = (j.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
  const r = JSON.parse(raw) as { text?: string; alternatives?: string[]; confident?: boolean };
  const text = String(r.text ?? "").trim();
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const alternatives = [...new Set((r.alternatives ?? []).map((a) => String(a).trim()).filter((a) => a && norm(a) !== norm(text)))].slice(0, 3);
  return { text, alternatives, confident: !!r.confident, ms: Date.now() - t, model };
}

/** Writes <time>-<id>.wav and one log.jsonl line, and prints one short console line (no audio, no keys). */
export async function logAsk(rec: Record<string, unknown> & { id: string; t0: number; pcm: Buffer[] }) {
  const pcm = Buffer.concat(rec.pcm);
  const stamp = new Date(rec.t0).toISOString().replace(/[:.]/g, "-");
  const file = `${ASK_DIR}/${stamp}-${rec.id.replace(/[^\w-]/g, "")}.wav`;
  const { pcm: _pcm, t0, ...rest } = rec;
  const line = { time: new Date(t0).toISOString(), file, durationMs: Math.round(pcm.length / 32), ...level(pcm), ...rest };
  await mkdir(ASK_DIR, { recursive: true });
  await writeFile(file, wav(pcm));
  await appendFile(`${ASK_DIR}/log.jsonl`, JSON.stringify(line) + "\n");
  const f = rec.finals as { tr?: string; asker?: string; context?: Reading } | undefined;
  const d = (rec.result as { decided?: { source?: string; action?: string } } | undefined)?.decided;
  console.info(
    `[ask] ${rec.id} ${line.durationMs} ms rms ${line.rmsDb} dB · tr "${f?.tr ?? ""}" · live "${f?.asker ?? ""}" · context "${f?.context?.text ?? ""}"` +
      `${f?.context ? ` (${f.context.ms} ms)` : ""} · sent ${rec.sent ?? "?"} · decided ${d ? `${d.source}:${d.action}` : "?"}`,
  );
}
