// Gemini REST helper (no SDK: it failed with this key). Concurrency 2, two retries on 429/503.
import { GEMINI_VISION_MODEL } from "../models";

export type Part = Record<string, unknown>;

const MAX_PARALLEL = 2;
let active = 0;
const waiting: (() => void)[] = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ask Gemini for JSON matching `schema` (OpenAPI-subset, types in caps). Throws after 2 retries. */
export async function generateJson<T>(
  parts: Part[],
  schema: object,
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<T> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${opts.model ?? GEMINI_VISION_MODEL}:generateContent`;
  const body = JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.2 },
  });
  return slot(async () => {
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(2500);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "x-goog-api-key": key, "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
        });
      } catch (e) {
        lastErr = `network: ${(e as Error).message}`;
        continue;
      }
      if (res.status === 429 || res.status === 503) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text !== "string") throw new Error("Gemini returned no text");
      return JSON.parse(text) as T;
    }
    throw new Error(`Gemini gave up after retries (${lastErr})`);
  });
}
