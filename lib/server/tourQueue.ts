// Background figure analysis while the student reads. Called by app/api/load and app/api/ingest (warmPage, never awaited)
// and app/api/tour (serve, status, prioritise). Two lanes: the light model (2 at a time) builds quick tours in page order;
// the heavy chart chain (1 at a time) then reads each chart's data. State lives on globalThis (one long-lived process).
import { cachedTour, fullTour, quickTour } from "./tour";
import type { Tour } from "../types";

export type State = "none" | "queued" | "building" | "quick" | "full" | "failed";
type Job = { state: State; kind?: string; fullFailed?: boolean; quick?: Promise<Tour | null>; full?: Promise<Tour | null> };

type Queue = { jobs: Map<string, Job>; light: string[]; heavy: string[]; busy: { light: number; heavy: number }; calls: string[] };
const g = globalThis as unknown as { __arcTours?: Queue };
const Q: Queue = (g.__arcTours ??= { jobs: new Map(), light: [], heavy: [], busy: { light: 0, heavy: 0 }, calls: [] });
const LIMIT = { light: 2, heavy: 1 };
const MAX_FIGURES = 30;

const kindOf = (t: Tour | null) => (!t ? undefined : t.stage === "quick" || t.chart ? "chart" : "figure");
const job = (image: string) => {
  let j = Q.jobs.get(image);
  if (!j) Q.jobs.set(image, (j = { state: "none" }));
  return j;
};

/** One timeout and one retry around a stage; a failure is one log line and is remembered (no retry loop). */
async function attempt(image: string, lane: "light" | "heavy", fn: (u: string) => Promise<Tour | null>): Promise<Tour | null> {
  const ms = lane === "light" ? 30_000 : 150_000;
  for (let k = 0; k < 2; k++) {
    const t = Date.now();
    try {
      const tour = await Promise.race([fn(image), new Promise<never>((_, no) => setTimeout(() => no(new Error(`timed out after ${ms} ms`)), ms))]);
      Q.calls.push(`${lane} ${tour ? "ok" : "none"} ${Date.now() - t}ms ${image.split("/").pop()}`);
      return tour;
    } catch (e) {
      Q.calls.push(`${lane} fail ${Date.now() - t}ms ${image.split("/").pop()}`);
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
    const t = await attempt(image, "light", quickTour);
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
    const t = await attempt(image, "heavy", fullTour);
    if (t && t.stage !== "quick") j.state = "full";
    else j.fullFailed = true; // the quick tour stays and is reported as "quick"; the full one is not retried in a loop
    pump();
    return t;
  })();
  return j.full;
}

function pump() {
  while (Q.busy.light < LIMIT.light && Q.light.length) {
    const image = Q.light.shift()!;
    Q.busy.light++;
    runQuick(image).finally(() => {
      Q.busy.light--;
      pump();
    });
  }
  while (Q.busy.heavy < LIMIT.heavy && Q.heavy.length) {
    const image = Q.heavy.shift()!;
    Q.busy.heavy++;
    runFull(image).finally(() => {
      Q.busy.heavy--;
      pump();
    });
  }
}

/** Queue the first 30 figures of a page, in page order, skipping cached and known ones. Returns at once. */
export function warmPage(images: string[]) {
  void (async () => {
    for (const image of [...new Set(images)].slice(0, MAX_FIGURES)) {
      if (Q.jobs.has(image)) continue;
      const have = await cachedTour(image);
      const j = job(image);
      if (have) {
        j.kind = kindOf(have);
        j.state = have.stage === "quick" ? "quick" : "full";
        if (have.stage === "quick") Q.heavy.push(image);
      } else {
        j.state = "queued";
        Q.light.push(image);
      }
    }
    console.log(`[tours] warming ${Q.light.length} figures (${Q.heavy.length} charts waiting for data)`);
    pump();
  })().catch((e) => console.log(`[tours] warm failed: ${(e as Error).message}`));
}

/** Move one figure to the front of its lane (the cursor is on it, or its tour was opened). */
export function prioritise(image: string) {
  const j = job(image);
  for (const lane of [Q.light, Q.heavy]) {
    const k = lane.indexOf(image);
    if (k > 0) lane.unshift(...lane.splice(k, 1));
  }
  if (j.state === "none") {
    j.state = "queued";
    Q.light.unshift(image);
  }
  pump();
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
  const have = await cachedTour(image);
  const j = job(image);
  if (have && have.stage !== "quick") return { tour: have, coming: false };
  const failed = !!j.fullFailed;
  if (have) {
    prioritise(image);
    if (!Q.heavy.includes(image) && !j.full && !failed) {
      Q.heavy.unshift(image);
      pump();
    }
    return { tour: fullOnly ? null : have, coming: !failed };
  }
  if (fullOnly) return { tour: null, coming: j.state !== "failed" && !failed };
  const k = Q.light.indexOf(image);
  if (k >= 0) Q.light.splice(k, 1); // run it now rather than wait for its turn
  const tour = await runQuick(image);
  return { tour, coming: tour?.stage === "quick" };
}

/** For the timeline check: every stage run so far, one line each. */
export const calls = () => [...Q.calls];
