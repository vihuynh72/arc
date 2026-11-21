// Gemini REST helper (no SDK: it failed with this key). Two retries on 429/503. Every call is counted and guarded by
// lib/server/budget.ts: `feature` names who asked ("tour", "chart", "pdf-page", ...; "other" when not given).
import { GEMINI_VISION_MODEL } from "../models";
import { BudgetError, DEPLETED_LINE, checkModel, noteGeminiFailure, recordGemini } from "./budget";

export type Part = Record<string, unknown>;

// One ceiling on paid generate calls in flight, for both helpers below (the queues' own lane limits sit under it). Decisions,
// hearing and Live are not slotted: they are short and a student is waiting on each.
const MAX_PARALLEL = Math.max(1, Number(process.env.ARC_GEMINI_PARALLEL) || 4);
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
  opts: { model?: string; timeoutMs?: number; feature?: string } = {},
): Promise<T> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const model = opts.model ?? GEMINI_VISION_MODEL;
  const feature = opts.feature ?? "other";
  checkModel(feature);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.2 },
  });
  return slot(async () => {
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(2500);
      checkModel(feature); // the wait for a slot or a retry can cross the cap
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
      if (!res.ok) {
        const text = await res.text();
        if (noteGeminiFailure(res.status, text)) throw new BudgetError(DEPLETED_LINE, "depleted");
        if (res.status === 429 || res.status === 503) {
          lastErr = `HTTP ${res.status}`;
          continue;
        }
        throw new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const data = await res.json();
      recordGemini(feature, model, data?.usageMetadata);
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text !== "string") {
        // An empty answer happens under load (seen on the video outline); retry once, then fail.
        if (lastErr === "no text") throw new Error("Gemini returned no text");
        lastErr = "no text";
        continue;
      }
      return JSON.parse(text) as T;
    }
    throw new Error(`Gemini gave up after retries (${lastErr})`);
  });
}

// Fallback chain: models tried in order; a busy (429/500/503/timeout) model is retried once after a short wait, then the
// next is tried. A model that answered 429 in the last 5 minutes is moved to the back so the next request starts with one
// that works. No global slot here: the caller (lib/server/tourQueue.ts) limits its own concurrency.
const g = globalThis as unknown as { __arcQuota?: Map<string, number> };
const quotaHit = (g.__arcQuota ??= new Map());
const QUOTA_MS = 5 * 60_000;
// A free-tier daily cap ("requests per day ... Free Tier", 20 a day per model as measured) does not clear by retrying.
const DAILY_MS = 60 * 60_000;

/** "retryDelay" from a 429 body ("12s") or a Retry-After header, in ms; null when absent. */
function retryMs(body: string, header: string | null): number | null {
  const m = /"retryDelay":\s*"([\d.]+)s"/.exec(body);
  if (m) return Number(m[1]) * 1000;
  return header && Number.isFinite(Number(header)) ? Number(header) * 1000 : null;
}

export async function generateJsonChain<T>(
  parts: Part[],
  schema: object,
  models: string[],
  timeoutMs = 60_000,
  feature = "other",
): Promise<{ data: T; model: string; tried: string[] }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  checkModel(feature);
  return slot(() => chain<T>(key, parts, schema, models, timeoutMs, feature));
}

async function chain<T>(key: string, parts: Part[], schema: object, models: string[], timeoutMs: number, feature: string): Promise<{ data: T; model: string; tried: string[] }> {
  const now = Date.now();
  const fresh = (m: string) => (quotaHit.get(m) ?? 0) < now;
  const order = [...models.filter(fresh), ...models.filter((m) => !fresh(m))];
  const body = JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.2 },
  });
  const tried: string[] = [];
  for (const model of order) {
    for (let attempt = 0; attempt < 2; attempt++) {
      checkModel(feature);
      tried.push(`${model}${attempt ? " (retry)" : ""}`);
      let res: Response;
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": key, "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        console.log(`[gemini] ${model} ${(e as Error).name === "TimeoutError" ? "timed out" : "network error"}`);
        if (attempt === 0) await sleep(1000);
        continue;
      }
      if ([402, 403, 429, 500, 503].includes(res.status)) {
        const text = await res.text();
        if (noteGeminiFailure(res.status, text)) throw new BudgetError(DEPLETED_LINE, "depleted");
        if (res.status === 402 || res.status === 403) break;
        if (res.status === 429) quotaHit.set(model, Date.now() + (/per day/i.test(text) ? DAILY_MS : QUOTA_MS));
        const metric = /"quotaMetric":\s*"([^"]+)"/.exec(text)?.[1] ?? "";
        const wait = Math.min(3000, retryMs(text, res.headers.get("retry-after")) ?? 1500);
        const daily = res.status === 429 && /per day/i.test(text);
        console.log(`[gemini] ${model} HTTP ${res.status}${metric ? ` ${metric}` : ""}${daily ? " (daily cap)" : ""}; ${attempt || daily ? "next model" : `retry in ${wait} ms`}`);
        if (daily) break; // retrying a daily cap only burns time
        if (attempt === 0) await sleep(wait);
        continue;
      }
      if (!res.ok) {
        console.log(`[gemini] ${model} HTTP ${res.status}; next model`);
        break;
      }
      const data = await res.json();
      recordGemini(feature, model, data?.usageMetadata);
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text !== "string") continue;
      try {
        return { data: JSON.parse(text) as T, model, tried };
      } catch {
        break;
      }
    }
  }
  throw new Error(`no model answered (${tried.join(", ")})`);
}
