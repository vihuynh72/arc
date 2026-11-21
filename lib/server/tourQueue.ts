// Background figure analysis while the student reads. Called by app/api/load and app/api/ingest (warmPage, never awaited)
// and app/api/tour (serve, status, prioritise). Two lanes: the light model (2 at a time) builds quick tours in page order;
// the heavy chart chain (1 at a time) then reads each chart's data. State lives on globalThis (one long-lived process).
import { allowBackground, allowExtras, isBudgetError } from "./budget";
import { cachedTour, fullTour, quickTour } from "./tour";
import type { Tour, Twin } from "../types";

export type State = "none" | "queued" | "building" | "quick" | "full" | "failed";
type Job = { state: State; context?: string; kind?: string; fullFailed?: boolean; quick?: Promise<Tour | null>; full?: Promise<Tour | null>; queuedAt?: number; asked?: boolean };

type Queue = { jobs: Map<string, Job>; light: string[]; heavy: string[]; busy: { light: number; heavy: number }; calls: string[]; seen?: Map<string, number> };
const g = globalThis as unknown as { __arcTours?: Queue };
const Q: Queue = (g.__arcTours ??= { jobs: new Map(), light: [], heavy: [], busy: { light: 0, heavy: 0 }, calls: [] });
Q.seen ??= new Map(); // added after the first release: a hot reload keeps the old object

// A tour is a paid model call, so one is built only for a picture the server itself saw: a figure of a page it loaded or served
// from its store (warmPage), a picture of a handed-over private page (lib/server/ingest.ts), or one of its own pictures (video
// frames from app/api/video/shown, PDF figure crops from lib/server/pdf.ts figureUrl). Any other address gets 404: a query string
// added to an image address is a new string, and without this every one was a new paid tour. Bounded: oldest forgotten first.
const MAX_SEEN = Number(process.env.ARC_TOUR_PICTURES) || 20_000; // about 1,000 pages' figures
const MAX_JOBS = Number(process.env.ARC_TOUR_JOBS) || 5_000; // tour states kept in memory (each holds two promises)
export function seePictures(urls: Iterable<string>) {
  for (const u of urls) {
    if (typeof u !== "string" || !/^https?:\/\//i.test(u) || u.length > 4000) continue;
    Q.seen!.delete(u);
    Q.seen!.set(u, Date.now());
  }
  for (const k of Q.seen!.keys()) {
    if (Q.seen!.size <= MAX_SEEN) break;
    Q.seen!.delete(k);
  }
}
export const knownPicture = (url: string) => Q.seen!.has(url);
const LIMIT = { light: 2, heavy: 1 };
// Measured on the lower-limb paper (22 figures): warming every figure cost $0.04 of quick tours and $0.11 of chart data reads.
// On an open link set ARC_WARM_FIGURES low and ARC_WARM_CHARTS=off: charts are then read only when a student reaches or opens one.
const MAX_FIGURES = Number(process.env.ARC_WARM_FIGURES) || 30;
const WARM_CHARTS = process.env.ARC_WARM_CHARTS !== "off";
// A burst of pages must not queue hours of paid work: at most this many figures wait, newest pages kept, and a figure waiting
// longer than MAX_AGE_MS is dropped (the student has most likely left; opening its tour still builds it on demand).
const MAX_QUEUED = 60;
const MAX_AGE_MS = 20 * 60_000;

const kindOf = (t: Tour | null) => (!t ? undefined : t.stage === "quick" || t.chart ? "chart" : "figure");
const job = (image: string) => {
  let j = Q.jobs.get(image);
  if (!j) {
    Q.jobs.set(image, (j = { state: "none" }));
    // Oldest first, never one being built or waiting in a lane (its promise and its place there belong to it).
    for (const [k, o] of Q.jobs) {
      if (Q.jobs.size <= MAX_JOBS) break;
      if (o.state !== "building" && o.state !== "queued" && k !== image) Q.jobs.delete(k);
    }
  }
  return j;
};

/** One timeout and one retry around a stage; a failure is one log line and is remembered (no retry loop). */
async function attempt(image: string, lane: "light" | "heavy", fn: (u: string, context?: string) => Promise<Tour | null>): Promise<Tour | null> {
  const ms = lane === "light" ? 30_000 : 150_000;
  for (let k = 0; k < 2; k++) {
    const t = Date.now();
    try {
      const tour = await Promise.race([fn(image, Q.jobs.get(image)?.context), new Promise<never>((_, no) => setTimeout(() => no(new Error(`timed out after ${ms} ms`)), ms))]);
      Q.calls.push(`${lane} ${tour ? "ok" : "none"} ${Date.now() - t}ms ${image.split("/").pop()}`);
      return tour;
    } catch (e) {
      Q.calls.push(`${lane} fail ${Date.now() - t}ms ${image.split("/").pop()}`);
      if (isBudgetError(e)) throw e; // no retry, and not remembered as a failed figure
      if (k) console.log(`[tours] ${lane} failed for ${image.split("/").pop()}: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  return null;
}

/** Stage one for an image, shared by the queue and an on-demand request (never run twice at once). */
function runQuick(image: string): Promise<Tour | null> {
  const j = job(image);
  j.quick ??= (async () => {
    j.state = "building";
    const t = await attempt(image, "light", quickTour).catch((e) => {
      j.quick = undefined; // refused by the budget: may be built another day
      j.state = "none";
      throw e;
    });
    j.kind = kindOf(t);
    if (!t) j.state = "failed";
    else if (t.stage === "quick") {
      j.state = "quick";
      if (!Q.heavy.includes(image)) Q.heavy.push(image);
    } else j.state = "full";
    pump();
    return t;
  })();
  return j.quick;
}

function runFull(image: string): Promise<Tour | null> {
  const j = job(image);
  j.full ??= (async () => {
    const t = await attempt(image, "heavy", fullTour).catch(() => null);
    if (t && t.stage !== "quick") j.state = "full";
    else j.fullFailed = true; // the quick tour stays and is reported as "quick"; the full one is not retried in a loop
    pump();
    return t;
  })();
  return j.full;
}

function pump() {
  const old = Date.now() - MAX_AGE_MS;
  while (Q.light.length && (Q.jobs.get(Q.light[0])?.queuedAt ?? Date.now()) < old) Q.jobs.get(Q.light.shift()!)!.state = "none";
  while (allowBackground() && Q.busy.light < LIMIT.light && Q.light.length) {
    const image = Q.light.shift()!;
    Q.busy.light++;
    runQuick(image).catch(() => null).finally(() => {
      Q.busy.light--;
      pump();
    });
  }
  while (allowExtras() && Q.busy.heavy < LIMIT.heavy && Q.heavy.length) {
    const k = WARM_CHARTS ? 0 : Q.heavy.findIndex((i) => Q.jobs.get(i)?.asked);
    if (k < 0) break;
    const image = Q.heavy.splice(k, 1)[0];
    Q.busy.heavy++;
    runFull(image).finally(() => {
      Q.busy.heavy--;
      pump();
    });
  }
}

/** Each figure's caption plus up to about 600 characters of the paragraphs that mention it ("Figure 20", "Fig. 20"). */
export function figureContexts(twin: Twin): Record<string, string> {
  const out: Record<string, string> = {};
  const texts = twin.nodes.filter((n) => n.kind !== "figure").map((n) => n.text);
  for (const n of twin.nodes) {
    if (n.kind !== "figure" || !n.image) continue;
    const caption = [n.heading, n.image.alt, n.text].filter(Boolean).join(" ").trim();
    const no = /\b(?:figure|fig\.?)\s*(\d+)/i.exec(caption)?.[1];
    const near = no ? texts.filter((t) => new RegExp(`\\b(?:figure|fig\\.?)\\s*${no}\\b`, "i").test(t)).join(" ").slice(0, 600) : "";
    const ctx = [caption && `Caption: ${caption.slice(0, 300)}`, near && `Text: ${near}`].filter(Boolean).join("\n");
    if (ctx) out[n.image.url] = ctx;
  }
  return out;
}

/** Queue the first 30 figures of a page, in page order, skipping cached and known ones. Returns at once. `contexts` (from
 * figureContexts) gives the vision model the page's caption and text for each figure. */
export function warmPage(images: string[], contexts: Record<string, string> = {}) {
  seePictures(images); // a figure of a page Arc loaded: its tour may be built when asked for, even on a day too low to warm it
  if (!allowBackground()) return void console.log(`[tours] not warming ${images.length} figures: today's budget is low (tours are built when opened)`);
  void (async () => {
    for (const image of [...new Set(images)].slice(0, MAX_FIGURES)) {
      if (contexts[image]) job(image).context ??= contexts[image];
      if (Q.jobs.get(image)?.state && Q.jobs.get(image)!.state !== "none") continue;
      const have = await cachedTour(image);
      const j = job(image);
      if (have) {
        j.kind = kindOf(have);
        j.state = have.stage === "quick" ? "quick" : "full";
        if (have.stage === "quick") Q.heavy.push(image);
      } else {
        j.state = "queued";
        j.queuedAt = Date.now();
        Q.light.push(image);
      }
    }
    for (const drop of Q.light.splice(0, Math.max(0, Q.light.length - MAX_QUEUED))) Q.jobs.get(drop)!.state = "none";
    console.log(`[tours] warming ${Q.light.length} figures (${Q.heavy.length} charts waiting for data)`);
    pump();
  })().catch((e) => console.log(`[tours] warm failed: ${(e as Error).message}`));
}

/** Move one figure to the front of its lane (the cursor is on it, or its tour was opened). False for a picture Arc never saw. */
export function prioritise(image: string): boolean {
  if (!knownPicture(image)) return false;
  const j = job(image);
  j.asked = true; // the cursor is on it or its tour was opened
  for (const lane of [Q.light, Q.heavy]) {
    const k = lane.indexOf(image);
    if (k > 0) lane.unshift(...lane.splice(k, 1));
  }
  if (j.state === "none") {
    j.state = "queued";
    j.queuedAt = Date.now();
    Q.light.unshift(image);
  }
  pump();
  return true;
}

export async function status(images: string[]) {
  const out: Record<string, { state: State; kind?: string }> = {};
  for (const image of images) {
    const j = Q.jobs.get(image);
    if (j && j.state !== "none") out[image] = { state: j.state, ...(j.kind ? { kind: j.kind } : {}) };
    else {
      const have = await cachedTour(image);
      out[image] = have ? { state: have.stage === "quick" ? "quick" : "full", kind: kindOf(have) } : { state: "none" };
    }
  }
  return out;
}

/** The best tour for a request: full if on disk, else the quick one (built now if needed, about 2 to 9 s); never waits for the
 * heavy chart model. `fullOnly`: the full tour or null, plus whether one is still coming. */
export async function serve(image: string, fullOnly = false): Promise<{ tour: Tour | null; coming: boolean }> {
  const have = await cachedTour(image, true); // a tour saved before ring fitting is fitted here, once
  if (!have && !knownPicture(image)) return { tour: null, coming: false }; // never seen on a page: nothing is built (404)
  const j = job(image);
  j.asked = true;
  if (have && have.stage !== "quick") return { tour: have, coming: false };
  const failed = !!j.fullFailed;
  if (have) {
    prioritise(image);
    if (!Q.heavy.includes(image) && !j.full && !failed) {
      Q.heavy.unshift(image);
      pump();
    }
    return { tour: fullOnly ? null : have, coming: !failed && allowExtras() }; // a lean day reads no chart data
  }
  if (fullOnly) return { tour: null, coming: j.state !== "failed" && !failed && allowExtras() };
  const k = Q.light.indexOf(image);
  if (k >= 0) Q.light.splice(k, 1); // run it now rather than wait for its turn
  const tour = await runQuick(image); // a BudgetError goes to app/api/tour, which says the line
  return { tour, coming: tour?.stage === "quick" && allowExtras() };
}

/** For the timeline check: every stage run so far, one line each. */
export const calls = () => [...Q.calls];
