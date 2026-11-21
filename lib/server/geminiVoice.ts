// The paid voice tier (lib/server/voices.ts engine "gemini"): one Gemini TTS request per sentence, for languages with no
// acceptable local voice. Only the page's words are sent, never a style instruction the voice could read aloud.
// Called by lib/server/kokoro.ts speak(), which caches the result like any other clip.
import { GEMINI_TTS_MODEL } from "@/lib/models";
import { BudgetError, DEPLETED_LINE, checkModel, noteGeminiFailure, recordGemini } from "@/lib/server/budget";

/** 16-bit mono WAV around Gemini's raw PCM. */
function wav(pcm: Buffer, rate: number) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** WAV bytes for the text in the given prebuilt voice. Two retries with 2.5 s backoff (repo rule), then the error. */
export async function geminiSpeak(text: string, voice: string, signal?: AbortSignal): Promise<Buffer> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("no Gemini key");
  let last = "";
  for (let t = 0; t < 3; t++) {
    if (t) await new Promise((r) => setTimeout(r, 2500));
    if (signal?.aborted) throw new Error("aborted");
    checkModel("speech"); // today's budget and an empty balance (lib/server/budget.ts): throws BudgetError
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`, {
      method: "POST",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      }),
    }).catch((e: Error) => e);
    if (r instanceof Error) {
      if (signal?.aborted) throw r;
      last = r.message;
      continue;
    }
    if (!r.ok && noteGeminiFailure(r.status, await r.clone().text().catch(() => ""))) throw new BudgetError(DEPLETED_LINE, "depleted");
    const j = (await r.json().catch(() => ({}))) as { usageMetadata?: Record<string, unknown>; candidates?: { content?: { parts?: { inlineData?: { data: string; mimeType: string } }[] } }[] };
    if (r.ok) recordGemini("speech", GEMINI_TTS_MODEL, j.usageMetadata);
    const part = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
    if (part) return wav(Buffer.from(part.data, "base64"), Number(/rate=(\d+)/.exec(part.mimeType)?.[1]) || 24000);
    last = `gemini tts ${r.status}`;
  }
  throw new Error(last);
}
