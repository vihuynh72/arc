// Where the student was in a public link, kept in this tab's own sessionStorage so a reload (an accidental Cmd+R, a restored tab, a
// crash) opens the same link and puts the cursor back. Nothing leaves the browser. Every read and write is in try/catch: with storage
// refused or empty Arc works exactly the same, and a reload opens the link from the top. Private pages, uploaded files and
// assessments never reach here (components/Twin.tsx); a one-word marker is all that is kept of them, so the start page can say
// honestly that they were not kept. Used by components/Twin.tsx and components/VideoPlayer.tsx; checked by scripts/checks/place.ts.

/** id: the node under the cursor ("" before there is one); b: its block (-1 the heading); page: a PDF's page; t: a lecture's second. */
export type Place = { id: string; b: number; page?: number; t?: number };

export const placeKey = (url: string) => `arc-place:${url}`;
export const GONE = "arc-gone";
export const serialise = (p: Place) => JSON.stringify(p);

const ID = /^[\w.-]{0,40}$/;
const int = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/** A saved place from storage text, or null for anything that is not exactly one (missing, hand-edited, another version). */
export function parsePlace(raw: string | null | undefined): Place | null {
  try {
    const p = JSON.parse(raw ?? "") as Record<string, unknown>;
    if (!p || typeof p.id !== "string" || !ID.test(p.id) || !int(p.b, -1, 99999)) return null;
    if (p.page !== undefined && !int(p.page, 1, 99999)) return null;
    if (p.t !== undefined && !(typeof p.t === "number" && Number.isFinite(p.t) && p.t >= 0 && p.t < 1e6)) return null;
    return { id: p.id, b: p.b as number, ...(p.page !== undefined && { page: p.page as number }), ...(p.t !== undefined && { t: p.t as number }) };
  } catch {
    return null;
  }
}

/** A place worth going back to: past the very start (a lecture: past its first second). */
export const worthKeeping = (p: Place, first?: string) => (p.t ?? 0) >= 1 || (!!p.id && !(p.id === first && p.b < 0));

const store = <T>(f: (s: Storage) => T, none: T): T => {
  try {
    return f(sessionStorage);
  } catch {
    return none;
  }
};
export const readPlace = (url: string) => store((s) => parsePlace(s.getItem(placeKey(url))), null);
export const dropPlace = (url: string) => store((s) => s.removeItem(placeKey(url)), undefined);
/** Merges `patch` into the place kept for `url` (the cursor and the lecture's clock are written by different parts of the page). */
export const updatePlace = (url: string, patch: Partial<Place>) =>
  store((s) => s.setItem(placeKey(url), serialise({ id: "", b: -1, ...parsePlace(s.getItem(placeKey(url))), ...patch })), undefined);

/** "private" or "file": what was open that Arc deliberately did not keep. Said once, after a reload, on the start page. */
export const markGone = (kind: "private" | "file") => store((s) => s.setItem(GONE, kind), undefined);
export const clearGone = () => store((s) => s.removeItem(GONE), undefined);
export const takeGone = () => store<"private" | "file" | null>((s) => {
  const k = s.getItem(GONE);
  s.removeItem(GONE);
  return k === "private" || k === "file" ? k : null;
}, null);

/** A twin that may be written into the address bar and kept: a public link, never a private page, an assessment or an upload. */
export const isPublic = (s: { url: string; private?: boolean; assessment?: boolean }) => !s.private && !s.assessment && /^https?:\/\//i.test(s.url);
/** "/?url=<link>": what the address bar shows for an open public link. */
export const addressFor = (url: string) => `/?url=${encodeURIComponent(url)}`;

export const GONE_LINE = {
  private: "The private page you had open was not kept. Open it again in your own browser and send it to Arc with the Arc helper.",
  file: "The file you had open was not kept. Choose it again to read it.",
};
