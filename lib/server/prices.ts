// Every price Arc uses to turn counts into dollars. USD. Each one can be overridden by an env variable of the name shown
// (ARC_PRICE_...), so a price change needs no deploy of code. "UNVERIFIED" marks a number not read from the vendor's own page.
// Read on 2026-11-20 from https://aistudio.google.com/docs/pricing (Gemini, paid tier, Standard) and brightdata.com/pricing/*.
import {
  GEMINI_CHART_MODEL,
  GEMINI_DECISION_MODEL,
  GEMINI_HEARING_MODEL,
  GEMINI_LIVE_MODEL,
  GEMINI_PDF_MODEL,
  GEMINI_STRUCTURE_MODEL,
  GEMINI_TTS_MODEL,
  GEMINI_VIDEO_DESCRIBE_MODEL,
  GEMINI_VISION_MODEL,
} from "../models";

const env = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 && process.env[name] !== "" && process.env[name] !== undefined ? v : fallback;
};

/** Per 1M tokens. `audioIn`/`audioOut` apply to tokens the API reports with modality AUDIO; thinking is billed as output. */
export type ModelPrice = { input: number; output: number; audioIn?: number; audioOut?: number; source: string };

const p = (key: string, input: number, output: number, source: string, audioIn?: number, audioOut?: number): ModelPrice => ({
  input: env(`ARC_PRICE_${key}_IN`, input),
  output: env(`ARC_PRICE_${key}_OUT`, output),
  ...(audioIn !== undefined ? { audioIn: env(`ARC_PRICE_${key}_AUDIO_IN`, audioIn) } : {}),
  ...(audioOut !== undefined ? { audioOut: env(`ARC_PRICE_${key}_AUDIO_OUT`, audioOut) } : {}),
  source,
});

export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Google pricing page: $0.30 in (text, image, video, audio), $2.50 out incl. thinking.
  "gemini-3.5-flash-lite": p("FLASH_LITE", 0.3, 2.5, "aistudio.google.com/docs/pricing"),
  // Google pricing page: $0.75 / $3.75 through 2026-12-31, then $1.50 / $7.50. The 2027 price is used (the dearer one).
  "gemini-3.6-flash": p("FLASH_36", 1.5, 7.5, "aistudio.google.com/docs/pricing (2027 price)"),
  "gemini-3.8-flash": p("FLASH_38", 1.5, 7.5, "aistudio.google.com/docs/pricing (2027 price)"),
  // Google pricing page: $1.50 in, $7.50 out.
  "gemini-4-hydrogen": p("HYDROGEN", 1.5, 7.5, "aistudio.google.com/docs/pricing"),
  // Google pricing page (Live row): text $0.75 in / $4.50 out; audio $3.00 in / $12.00 out; image/video in $1.00.
  "gemini-3.8-live": p("LIVE", 0.75, 4.5, "aistudio.google.com/docs/pricing", 3.0, 12.0),
  // Google pricing page: audio in $3.50, text out $21.00.
  "gemini-3.5-transcribe-live": p("TRANSCRIBE", 3.5, 21.0, "aistudio.google.com/docs/pricing", 3.5),
  // Google pricing page: text in $0.50 / audio out $6.00 through 2026-12-31, then $1.00 / $12.00. The 2027 price is used.
  // About 25 audio tokens per second of speech (measured by the voice work): $0.018 a minute at the 2027 price.
  "gemini-3.8-flash-lite-tts": p("TTS", 1.0, 12.0, "aistudio.google.com/docs/pricing (2027 price)", 1.0, 12.0),
  // UNVERIFIED: not on Google's pricing page when read; press reports $0.10 per 1M input and no output charge. Placeholder 3x.
  "gemini-decision-1": p("DECISION", 0.3, 0, "UNVERIFIED: press reports $0.10/M input, placeholder 0.30"),
};

// UNVERIFIED: a model id Arc does not list above is charged as the dearest known model, so it is never under-counted.
export const UNKNOWN_MODEL: ModelPrice = p("UNKNOWN", 1.5, 21.0, "UNVERIFIED: placeholder for an unlisted model");

// Live sessions may report no usage; then audio is costed by the minute. Google's page gives these per-minute estimates:
// audio in $0.005/min, audio out $0.018/min (Live row).
export const LIVE_AUDIO_IN_PER_MIN = env("ARC_PRICE_LIVE_AUDIO_IN_MIN", 0.005);
export const LIVE_AUDIO_OUT_PER_MIN = env("ARC_PRICE_LIVE_AUDIO_OUT_MIN", 0.018);

// Bright Data, pay as you go. Web Unlocker: brightdata.com/pricing/web-unlocker "$1.5/1K requests". SERP: brightdata.com/pricing/serp
// "$1.5/1K requests". Browser API: brightdata.com/pricing/scraping-browser "$8 /GB" (no time charge).
export const BD_UNLOCKER_PER_REQ = env("ARC_PRICE_BD_UNLOCKER", 1.5 / 1000);
export const BD_SERP_PER_REQ = env("ARC_PRICE_BD_SERP", 1.5 / 1000);
export const BD_BROWSER_PER_GB = env("ARC_PRICE_BD_BROWSER_GB", 8);
// UNVERIFIED: Arc does not measure Browser API bytes. A navigation is costed as this many MB (an article page with images is
// a few MB; a YouTube embed that seeks into a video streams more). Deliberately high.
export const BD_BROWSER_MB_PER_NAV = env("ARC_PRICE_BD_MB_PER_NAV", 15);

/** Dollars for one generate call. `audioIn`/`audioOut`: tokens of those counts that were audio. */
export function callCost(model: string, t: { input: number; output: number; thinking: number; audioIn?: number; audioOut?: number }): number {
  const m = MODEL_PRICES[model] ?? UNKNOWN_MODEL;
  const aIn = Math.min(t.audioIn ?? 0, t.input);
  const aOut = Math.min(t.audioOut ?? 0, t.output);
  return (
    ((t.input - aIn) * m.input + aIn * (m.audioIn ?? m.input) + (t.output - aOut + t.thinking) * m.output + aOut * (m.audioOut ?? m.output)) / 1e6
  );
}

/** True for the models whose passes are "extras" that a lean day drops: anything dearer than the light model. */
export const isHeavy = (model: string) => (MODEL_PRICES[model] ?? UNKNOWN_MODEL).input > (MODEL_PRICES[GEMINI_VISION_MODEL]?.input ?? 0);

// Every model id lib/models.ts names must have a price (checked in scripts/checks/budget.ts).
export const NAMED_MODELS = [GEMINI_VISION_MODEL, GEMINI_CHART_MODEL, GEMINI_LIVE_MODEL, GEMINI_HEARING_MODEL, GEMINI_DECISION_MODEL, GEMINI_VIDEO_DESCRIBE_MODEL, GEMINI_PDF_MODEL, GEMINI_STRUCTURE_MODEL, GEMINI_TTS_MODEL];
