// The public pages the student opened lately and where they stopped, kept in this browser's own localStorage (never sent anywhere)
// so tomorrow "continue" opens the paper again at the same place. Newest first, at most MAX_RECENT. Only a public link is ever written
// (isPublic, lib/client/place.ts): never a private page, an assessment or an uploaded file. Every read and write is in try/catch: with
// storage refused or empty Arc works exactly the same, and the list is just empty. Used by components/Twin.tsx, lib/client/command.ts,
// components/AskButton.tsx and components/landing/Recent.tsx; the words are matched in lib/intent.ts; checked by scripts/checks/recent.ts.
import { GREETING } from "../keys";
import { isPublic, parsePlace, readPlace, type Place } from "./place";

export type Recent = { url: string; title: string; kind: "page" | "pdf" | "video"; at: number; place?: Place };
export const RECENT_KEY = "arc-recent";
export const MAX_RECENT = 30;
const KINDS = new Set(["page", "pdf", "video"]);

/** The kept list from storage text: every entry that is exactly one, nothing else (missing, hand-edited, another version). */
export function parseRecent(raw: string | null | undefined): Recent[] {
  try {
    const list = JSON.parse(raw ?? "");
    if (!Array.isArray(list)) return [];
    const out: Recent[] = [];
    for (const e of list as Record<string, unknown>[]) {
      if (!e || typeof e.url !== "string" || e.url.length > 2000 || !isPublic({ url: e.url }) || typeof e.title !== "string" || !e.title.trim()) continue;
      if (typeof e.kind !== "string" || !KINDS.has(e.kind) || typeof e.at !== "number" || !Number.isFinite(e.at)) continue;
      const place = e.place === undefined ? undefined : parsePlace(JSON.stringify(e.place));
      if (e.place !== undefined && !place) continue;
      out.push({ url: e.url, title: e.title.slice(0, 300), kind: e.kind as Recent["kind"], at: e.at, ...(place && { place }) });
    }
    return out.slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/** `e` at the top (a link already there moves up and keeps its place unless `e` has one), the oldest dropped past the cap. */
export const withEntry = (list: Recent[], e: Recent): Recent[] => {
  const place = e.place ?? list.find((x) => x.url === e.url)?.place;
  return [{ ...e, ...(place && { place }) }, ...list.filter((x) => x.url !== e.url)].slice(0, MAX_RECENT);
};
/** The place for `url`'s entry, which keeps its position; nothing changes when there is no such entry. */
export const withPlace = (list: Recent[], url: string, place: Place): Recent[] => list.map((x) => (x.url === url ? { ...x, place } : x));
export const without = (list: Recent[], url: string): Recent[] => list.filter((x) => x.url !== url);

// Words that say nothing about which title is meant.
const SKIP = new Set(["my", "the", "a", "an", "paper", "that", "this", "one"]);
const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => w.replace(/s$/, ""));
/** The entry whose title holds most of the words said ("my biology paper"), the newest on a tie; null when none holds any. */
export function findRecent(list: Recent[], said: string): Recent | null {
  const q = words(said).filter((w) => !SKIP.has(w));
  let best: Recent | null = null;
  let top = 0;
  for (const e of list) {
    const t = new Set(words(e.title));
    const score = q.filter((w) => t.has(w)).length;
    if (score > top) [best, top] = [e, score];
  }
  return best;
}

/** A title for the ear: its first part, at most eight words, no dangling "of" or "and". */
export const saidTitle = (title: string) =>
  title.split(/[:–—|]| - /)[0].trim().split(/\s+/).slice(0, 8).join(" ").replace(/(\s+(?:a|an|and|at|by|for|from|in|of|on|the|to|with))+$/i, "") || title.slice(0, 60);

const store = <T>(f: (s: Storage) => T, none: T): T => {
  try {
    return f(localStorage);
  } catch {
    return none;
  }
};
const write = (list: Recent[]) => {
  store((s) => (list.length ? s.setItem(RECENT_KEY, JSON.stringify(list)) : s.removeItem(RECENT_KEY)), undefined);
  try {
    window.dispatchEvent(new Event("arc:recent")); // the start page's list follows
  } catch {}
};
export const recentRaw = () => store((s) => s.getItem(RECENT_KEY) ?? "", "");
export const readRecent = () => parseRecent(recentRaw());
/** A public link just opened (or showing under a better title): at the top. Anything private is refused here, not by the caller. */
export const rememberRecent = (s: { url: string; title: string; kind: Recent["kind"]; private?: boolean; assessment?: boolean }) =>
  void (isPublic(s) && s.title.trim() && write(withEntry(readRecent(), { url: s.url, title: s.title, kind: s.kind, at: Date.now() })));
/** Copies where this tab's place for `url` is now into its entry (written no oftener than every few seconds: components/Twin.tsx). */
export const keepRecentPlace = (url: string) => {
  const p = readPlace(url);
  if (p) write(withPlace(readRecent(), url, p));
};
export const clearRecent = () => write([]);

/** The start page's opening words: the greeting, and when something is kept one sentence about going back to it. */
export const greeting = () => {
  const r = readRecent()[0];
  return r ? `${GREETING} Say continue to go back to ${saidTitle(r.title)}.` : GREETING;
};
