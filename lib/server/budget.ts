// What Arc spends today, and the spend guard for an open link. One place: every Gemini call (lib/server/gemini.ts, hearing.ts,
// decide.ts, live.ts), every Bright Data request (brightdata.ts, remote.ts, khan.ts) and local speech report here; queues ask
// here before starting paid work. State on globalThis, saved to .cache/budget/<yyyy-mm-dd>.json (UTC day) so a restart keeps
// the day. Prices: lib/server/prices.ts. Read by GET /api/budget (same machine only).
//
// Degradation as the day's estimated spend crosses ARC_DAILY_BUDGET_USD (default 2):
//   level 0 normal
//   level 1 "lean"   (>= 50%): no extras. Heavy-model passes (chart data, video re-descriptions, page clean-up) are skipped or
//                              use the light model; no automatic video pictures.
//   level 2 "asked"  (>= 80%): no background work. Only what a student asked for runs (a tour opened, a question, the PDF page
//                              they are on, the video window they are at, a picture they asked for).
//   level 3 "cap"    (>= 100%, or Gemini said the balance is empty): every new model call is refused with BudgetError.
// Pages, navigation and cached results need no model and keep working at every level.
// Enforced when NODE_ENV=production (ARC_BUDGET=off turns it off) or ARC_BUDGET=on. In development it only counts and logs, so
// a busy day of local testing is never refused.
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  BD_BROWSER_MB_PER_NAV,
  BD_BROWSER_PER_GB,
  BD_SERP_PER_REQ,
  BD_UNLOCKER_PER_REQ,
  LIVE_AUDIO_IN_PER_MIN,
  LIVE_AUDIO_OUT_PER_MIN,
  callCost,
} from "./prices";

export const CAP_LINE = "Arc has used up today's free budget. Pages still load, but pictures and questions are off until tomorrow.";
export const DEPLETED_LINE = "Arc's voice and pictures are out of credit right now. Pages still load, but pictures and questions are off for now.";
export const VISITOR_LINE = "You have used today's listening time on this free copy of Arc. Pages still load and show on screen; listening comes back tomorrow.";
export const WEB_LINE = "Arc has used up today's web fetches. Pages it already has still open, but new pages from the web are off until tomorrow.";
export const LEVEL_LINES = [
  "",
  "Arc is saving its budget today, so chart details and video pictures are simpler.",
  "Arc is low on today's budget, so it only prepares what you ask for.",
  CAP_LINE,
];
export const LEVEL_NAMES = ["normal", "lean", "asked", "cap"] as const;
export type Level = 0 | 1 | 2 | 3;

/** A refused paid call. `say` is one plain sentence a client can speak as it is. */
export class BudgetError extends Error {
  constructor(
    readonly say: string,
    readonly code: "cap" | "depleted" | "web" | "visitor",
  ) {
    super(say);
    this.name = "BudgetError";
  }
}
export const isBudgetError = (e: unknown): e is BudgetError => e instanceof BudgetError || (e as Error)?.name === "BudgetError";

type Sum = { calls: number; input: number; output: number; thinking: number; audioIn: number; audioOut: number; usd: number };
type Day = {
  day: string;
  byFeature: Record<string, Sum>;
  byModel: Record<string, Sum>;
  brightData: { unlocker: number; serp: number; browserNav: number; browserSeconds: number; refused: number };
  live: { sessions: number; connectedSeconds: number; audioInSeconds: number; audioOutSeconds: number; estimatedUsd: number };
  speech: { clips: number; seconds: number };
  refused: Record<string, number>;
};
type State = { d: Day; depletedUntil: number; saveTimer?: NodeJS.Timeout; saidLevel: Level; diskOk: boolean; noSave?: boolean };

const DIR = ".cache/budget";
const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const emptyDay = (day: string): Day => ({
  day,
  byFeature: {},
  byModel: {},
  brightData: { unlocker: 0, serp: 0, browserNav: 0, browserSeconds: 0, refused: 0 },
  live: { sessions: 0, connectedSeconds: 0, audioInSeconds: 0, audioOutSeconds: 0, estimatedUsd: 0 },
  speech: { clips: 0, seconds: 0 },
  refused: {},
});

function loadDay(day: string): Day {
  try {
    return { ...emptyDay(day), ...JSON.parse(readFileSync(`${DIR}/${day}.json`, "utf8")), day };
  } catch {
    return emptyDay(day);
  }
}

const g = globalThis as unknown as { __arcBudget?: State };
const S: State = (g.__arcBudget ??= { d: loadDay(today()), depletedUntil: 0, saidLevel: 0, diskOk: true });

/** Today's record, rolled over at UTC midnight. */
function day(now = Date.now()): Day {
  const t = today(now);
  if (S.d.day !== t) {
    S.d = loadDay(t);
    S.saidLevel = 0;
  }
  return S.d;
}

function save() {
  if (S.saveTimer || S.noSave) return;
  S.saveTimer = setTimeout(() => {
    S.saveTimer = undefined;
    try {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(`${DIR}/${S.d.day}.json`, JSON.stringify(S.d));
      S.diskOk = true;
    } catch (e) {
      // A read-only or full disk: the guard keeps counting in memory; a restart then forgets the day.
      if (S.diskOk) console.warn(`[budget] cannot save ${DIR}: ${(e as Error).message}`);
      S.diskOk = false;
    }
  }, 2000);
  S.saveTimer.unref?.();
}

const env = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return process.env[name] && Number.isFinite(v) && v >= 0 ? v : fallback;
};
export const dailyBudget = () => env("ARC_DAILY_BUDGET_USD", 2);
export const bdCaps = () => ({ requests: env("ARC_DAILY_BD_REQUESTS", 400), browserNavs: env("ARC_DAILY_BD_NAVS", 40) });
const DEPLETED_MS = () => env("ARC_DEPLETED_MS", 5 * 60_000);

const add = (map: Record<string, Sum>, key: string, t: Omit<Sum, "calls">) => {
  const s = (map[key] ??= { calls: 0, input: 0, output: 0, thinking: 0, audioIn: 0, audioOut: 0, usd: 0 });
  s.calls++;
  for (const k of ["input", "output", "thinking", "audioIn", "audioOut", "usd"] as const) s[k] += t[k];
};

// ---- recording ----

type Detail = { modality?: string; tokenCount?: number };
const audioOf = (details: unknown) => (Array.isArray(details) ? (details as Detail[]) : []).filter((d) => /audio/i.test(d.modality ?? "")).reduce((n, d) => n + (d.tokenCount ?? 0), 0);

/** One generateContent (or Live turn) usageMetadata. Returns the dollars charged. */
export function recordGemini(feature: string, model: string, usage: Record<string, unknown> | undefined): number {
  const u = usage ?? {};
  const t = {
    input: Number(u.promptTokenCount ?? 0) || 0,
    output: (Number(u.candidatesTokenCount ?? u.responseTokenCount ?? 0) || 0),
    thinking: Number(u.thoughtsTokenCount ?? 0) || 0,
    audioIn: audioOf(u.promptTokensDetails),
    audioOut: audioOf(u.candidatesTokensDetails ?? u.responseTokensDetails),
  };
  const usd = callCost(model, t);
  chargeVisitor(usd);
  const d = day();
  add(d.byFeature, feature, { ...t, usd });
  add(d.byModel, model, { ...t, usd });
  save();
  levelNow(); // logs a level change once
  return usd;
}

/** A Decisions API reply's `usage` ({total_input_tokens, total_output_tokens, ...}). */
export function recordDecision(model: string, usage: Record<string, unknown> | undefined) {
  return recordGemini("decide", model, { promptTokenCount: usage?.total_input_tokens ?? usage?.total_tokens ?? 0, candidatesTokenCount: usage?.total_output_tokens ?? 0 });
}

/** A Live session closed. Seconds are measured by the relay; `charged` says whether its turns already reported usage. */
export function recordLiveSession(s: { connectedSeconds: number; audioInSeconds: number; audioOutSeconds: number; charged: boolean }) {
  const d = day();
  d.live.sessions++;
  d.live.connectedSeconds += s.connectedSeconds;
  d.live.audioInSeconds += s.audioInSeconds;
  d.live.audioOutSeconds += s.audioOutSeconds;
  // No usage messages came: cost the audio by Google's per-minute estimate instead.
  if (!s.charged) {
    const usd = (s.audioInSeconds / 60) * LIVE_AUDIO_IN_PER_MIN + (s.audioOutSeconds / 60) * LIVE_AUDIO_OUT_PER_MIN;
    d.live.estimatedUsd += usd;
    chargeVisitor(usd);
  }
  save();
}

export type BdKind = "unlocker" | "serp" | "browserNav";
export function recordBrightData(kind: BdKind, n = 1) {
  day().brightData[kind] += n;
  save();
}
export function recordBrowserSeconds(seconds: number) {
  day().brightData.browserSeconds += seconds;
  save();
}
export function recordSpeech(seconds: number) {
  const d = day();
  d.speech.clips++;
  d.speech.seconds += seconds;
  save();
}

// ---- totals ----

const bdUsd = (d: Day) => d.brightData.unlocker * BD_UNLOCKER_PER_REQ + d.brightData.serp * BD_SERP_PER_REQ + (d.brightData.browserNav * BD_BROWSER_MB_PER_NAV * BD_BROWSER_PER_GB) / 1024;
/** Estimated Gemini dollars today (the guarded balance; Bright Data has its own unit caps). */
export const geminiUsd = (d = day()) => Object.values(d.byModel).reduce((n, s) => n + s.usd, 0) + d.live.estimatedUsd;

/** Pure: the level for a spend against a budget. */
export function levelFor(spent: number, budget: number, depleted = false): Level {
  if (depleted || spent >= budget) return 3;
  if (spent >= budget * 0.8) return 2;
  if (spent >= budget * 0.5) return 1;
  return 0;
}

export const enforced = () => process.env.ARC_BUDGET === "on" || (process.env.NODE_ENV === "production" && process.env.ARC_BUDGET !== "off");
export const isDepleted = (now = Date.now()) => S.depletedUntil > now;

/** The level the guard acts on: always 0 when not enforced. */
const levelNow = (): Level => (enforced() ? measured() : (measured(), 0));
function measured(): Level {
  const l = levelFor(geminiUsd(), dailyBudget(), isDepleted());
  if (l !== S.saidLevel) {
    console.log(`[budget] level ${LEVEL_NAMES[l]} at $${geminiUsd().toFixed(3)} of $${dailyBudget()}: ${isDepleted() ? DEPLETED_LINE : LEVEL_LINES[l] || "back to normal"}`);
    S.saidLevel = l;
  }
  return l;
}
export const level = levelNow;
/** Heavy-model passes and automatic pictures may run. */
export const allowExtras = () => levelNow() < 1;
/** Work nobody asked for (warming tours, later video windows, the next PDF page) may run. */
export const allowBackground = () => levelNow() < 2;
/** The plain line for the current level ("" when normal). */
export const levelLine = () => (!enforced() ? "" : isDepleted() ? DEPLETED_LINE : LEVEL_LINES[levelNow()]);

/** The line to say when no new model call may start, else null. */
export const refusalLine = () => (!enforced() ? null : isDepleted() ? DEPLETED_LINE : levelNow() >= 3 ? CAP_LINE : null);

/** Throws BudgetError when no new model call may start. Call before every paid Gemini request. */
export function checkModel(feature: string) {
  if (!enforced()) return void levelNow();
  if (isDepleted()) return refuse(feature, new BudgetError(DEPLETED_LINE, "depleted"));
  if (levelNow() >= 3) return refuse(feature, new BudgetError(CAP_LINE, "cap"));
  const v = currentVisitor();
  if (v && (spendBy().get(v) ?? 0) >= visitorDailyUsd()) return refuse(`visitor:${feature}`, new BudgetError(CAP_LINE, "visitor")); // the same line: one visitor's share is the day's budget for them
}
function refuse(feature: string, e: BudgetError): never {
  const d = day();
  d.refused[feature] = (d.refused[feature] ?? 0) + 1;
  save();
  throw e;
}

/** Throws BudgetError when today's Bright Data cap for this kind is reached. */
export function checkBrightData(kind: BdKind) {
  if (!enforced()) return;
  const d = day();
  const caps = bdCaps();
  const over = kind === "browserNav" ? d.brightData.browserNav >= caps.browserNavs : d.brightData.unlocker + d.brightData.serp >= caps.requests;
  if (over) {
    d.brightData.refused++;
    save();
    throw new BudgetError(WEB_LINE, "web");
  }
}

// ---- one visitor's share of the voice ----
// Measured: hosted reading costs about $0.02 a minute of speech, so one visitor reading all day would spend the whole budget.
// Seconds of Gemini speech per visitor address, today, in memory only (addresses are never written to disk).
const voiceDay = globalThis as unknown as { __arcVoiceDay?: { day: string; by: Map<string, number> } };
const visitors = () => {
  const d = (voiceDay.__arcVoiceDay ??= { day: today(), by: new Map() });
  if (d.day !== today()) Object.assign(d, { day: today(), by: new Map() });
  return d.by;
};
export const voiceMinutesPerVisitor = () => env("ARC_VOICE_MINUTES_PER_VISITOR", 30);
export const addVoiceSeconds = (visitor: string, seconds: number) => void visitors().set(visitor, (visitors().get(visitor) ?? 0) + seconds);
/** Throws BudgetError when this visitor has heard today's share of Gemini speech. */
export function checkVisitor(visitor: string) {
  if (!enforced()) return;
  if ((visitors().get(visitor) ?? 0) >= voiceMinutesPerVisitor() * 60) throw new BudgetError(VISITOR_LINE, "visitor");
}

// ---- one visitor's share of the day's spend ----
// The visitor's key (lib/server/limits.ts clientIp: the address, an IPv6 one as its /64) is set once per request and per voice
// message by server.ts and lib/server/live.ts; every recordGemini inside that call, and in work it starts, adds to the key's day.
// In memory only (addresses are never written to disk). Enforced exactly when the budget guard is (enforced()).
// ARC_VISITOR_DAILY_USD, default 0.50: measured costs (README) are about $0.15 to open the demo paper, $0.12 for a ten-minute
// lecture, $0.02 a minute of the paid reading voice: a whole study session with questions fits, and the $2 day holds four visitors.
const scope = ((globalThis as unknown as { __arcVisitor?: AsyncLocalStorage<string> }).__arcVisitor ??= new AsyncLocalStorage<string>()); // one instance for server.ts and Next's bundles
export const runAsVisitor = <T>(visitor: string | undefined, fn: () => T): T => (visitor ? scope.run(visitor, fn) : fn());
export const currentVisitor = () => scope.getStore();
export const visitorDailyUsd = () => env("ARC_VISITOR_DAILY_USD", 0.5);
const spendDay = globalThis as unknown as { __arcSpendDay?: { day: string; by: Map<string, number> } };
const spendBy = () => {
  const d = (spendDay.__arcSpendDay ??= { day: today(), by: new Map() });
  if (d.day !== today()) Object.assign(d, { day: today(), by: new Map() });
  if (d.by.size > 50_000) d.by.clear(); // shortcut: a flood of addresses resets the day's shares rather than grow without bound
  return d.by;
};
function chargeVisitor(usd: number) {
  const v = currentVisitor();
  if (v && usd > 0) spendBy().set(v, (spendBy().get(v) ?? 0) + usd);
}
/** For checks: this visitor's estimated spend today. */
export const visitorSpend = (v: string) => spendBy().get(v) ?? 0;

// ---- an empty balance ----

/** Pure: whether a Gemini error says the prepaid balance is empty (as opposed to a per-minute rate limit). */
export function saysDepleted(status: number, body: string): boolean {
  if (status === 402) return true;
  // Narrow on purpose: a Live close reason such as "load balancing" or a per-minute quota must not pause the whole app. Google's
  // ordinary rate-limit answer says "You exceeded your current quota, please check your plan and billing details": the bare word
  // "billing" is therefore not a sign of an empty balance (it once switched the voice off for five minutes, on 2026-11-21).
  return (status === 429 || status === 403) && /prepay|credits? (?:are |is |have been )?(?:depleted|exhausted|exceeded)|billing (?:account|is (?:not enabled|disabled)|has not been enabled|must be enabled)|enable billing|spending cap|insufficient (?:balance|funds|credit)/i.test(body);
}

/** Call with every failed Gemini response. Remembers an empty balance for a few minutes so nothing hammers it. */
export function noteGeminiFailure(status: number, body: string): boolean {
  if (!saysDepleted(status, body)) return false;
  if (!isDepleted()) console.log(`[budget] Gemini says the balance is empty (HTTP ${status}: ${body.replace(/\s+/g, " ").slice(0, 160)}); model calls paused for ${Math.round(DEPLETED_MS() / 1000)} s`);
  S.depletedUntil = Date.now() + DEPLETED_MS();
  levelNow();
  return true;
}

// ---- report ----

export function report() {
  const d = day();
  const g = geminiUsd(d);
  const bd = bdUsd(d);
  const l = levelNow();
  const r = (n: number) => Math.round(n * 1e5) / 1e5;
  const rounded = (m: Record<string, Sum>) => Object.fromEntries(Object.entries(m).sort(([, a], [, b]) => b.usd - a.usd).map(([k, s]) => [k, { ...s, usd: r(s.usd) }]));
  return {
    day: d.day,
    budgetUsd: dailyBudget(),
    geminiUsd: r(g),
    level: LEVEL_NAMES[l],
    enforced: enforced(),
    measuredLevel: LEVEL_NAMES[measured()],
    say: levelLine(),
    depletedUntil: isDepleted() ? new Date(S.depletedUntil).toISOString() : null,
    byFeature: rounded(d.byFeature),
    byModel: rounded(d.byModel),
    live: { ...d.live, estimatedUsd: r(d.live.estimatedUsd) },
    brightData: { ...d.brightData, caps: bdCaps(), estimatedUsd: r(bd) },
    speech: d.speech,
    refused: d.refused,
    savedToDisk: S.diskOk,
    note: "Estimates from token counts and lib/server/prices.ts; Bright Data Browser API bytes are not measured (UNVERIFIED MB per navigation).",
  };
}

/** For checks only: start a clean day in memory and forget an empty balance. */
export function resetForTest(spentUsd = 0) {
  S.noSave = true; // a check never writes .cache/budget
  process.env.ARC_BUDGET = "on";
  S.d = emptyDay(today());
  S.depletedUntil = 0;
  S.saidLevel = 0;
  spendBy().clear();
  if (spentUsd) S.d.byModel["test"] = { calls: 1, input: 0, output: 0, thinking: 0, audioIn: 0, audioOut: 0, usd: spentUsd };
}
