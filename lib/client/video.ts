// What Arc says for a video, and merging headings and descriptions that arrive late. Used by Twin.tsx and VideoPlayer.tsx.
import { clock, splitSentences } from "@/lib/client/reader";
import type { Twin, TwinNode } from "@/lib/types";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const TIME_LABEL = /^\d+:\d{2}$/; // a heading that is only a time, before the real heading arrives
// Descriptions that say nothing: never worth stopping the lecturer for.
const NOTHING = /^(the speaker, no slides|unclear on screen)\.?$/i;

export const segmentsOf = (nodes: TwinNode[]) => nodes.filter((n) => n.kind === "segment" && n.start != null && n.end != null);
export const worthSaying = (n: TwinNode) => !!n.shown && !NOTHING.test(n.shown.trim());
export const onScreen = (n: TwinNode) => splitSentences(`On screen: ${n.shown ?? ""}`);
export const where = (n: TwinNode) => (TIME_LABEL.test(n.heading) ? `At ${n.heading}.` : `${n.heading}.`);

// ---- what Arc has already said about the screen: a description repeats nothing ----
const STOP = new Set("the and that this with for are was were has have from its their they them then there here into onto over some each also but not all can will just which when what where how".split(" "));
const stem = (w: string) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w);
const words = (s: string) => (s.toLowerCase().match(/[a-z0-9%]+/g) ?? []).filter((w) => (w.length > 2 || /\d/.test(w)) && !STOP.has(w)).map(stem);
const LOWER = /^(the|a|an|then|it|he|she|they|and)\s/i;

/**
 * The lines to say for a part's description, given what was already said about the screen (its earlier descriptions, oldest first).
 * Clauses whose content words are almost all known are dropped: "On screen: ..." when nothing is dropped, "Now ..." with only what is new
 * when part of it repeats, nothing when all of it does. shortcut: content-word overlap, not meaning; upgrade if a rewording slips through.
 */
export function screenLines(shown: string, before: string[]): string[] {
  const seen = new Set(before.flatMap(words));
  const keep: string[] = [];
  let dropped = false;
  for (const s of splitSentences(shown)) {
    for (const c of s.split(/,\s+and\s+(?=the |a |an |then |it |he |she |they )|;\s+/i)) {
      const w = words(c);
      const fresh = w.filter((x) => !seen.has(x)).length;
      if (fresh > 0 && fresh / w.length >= 0.2) keep.push(c.trim().replace(/[.!?]+$/, ""));
      else dropped = true;
    }
  }
  if (!keep.length) return [];
  if (!dropped) return splitSentences(`On screen: ${shown}`);
  const first = LOWER.test(keep[0]) ? keep[0].charAt(0).toLowerCase() + keep[0].slice(1) : keep[0];
  return splitSentences(`Now ${[first, ...keep.slice(1)].join(", ")}.`);
}

/** The descriptions already said for the parts before n, in time order (what the student has in mind about the screen). */
export const saidBefore = (said: Map<string, string>, segs: TwinNode[], n: TwinNode) =>
  segs.filter((x) => x.id !== n.id && (x.start as number) < (n.start as number) && said.has(x.id)).map((x) => said.get(x.id)!);

/** Read to me: the heading, the words, then what is on screen when there is something new to say (`before`: what was said already). */
export const segSpeech = (n: TwinNode, before?: string[]): string[] => [where(n), ...splitSentences(n.text), ...(worthSaying(n) ? (before ? screenLines(n.shown!, before) : onScreen(n)) : [])];

const SENTENCE_END = /[.!?]["')\]]*$/;
/** How long a description may wait past its part's end for the lecturer's sentence to finish. */
export const WAIT_S = 6;
/**
 * The second a part's description may start: the end of its last sentence. A part whose words stop mid-sentence (the model cut it
 * there) is held until the sentence finishes in the next part, estimated from the characters; when that is more than WAIT_S away,
 * at the last word gap before then instead (midSentence: say less). Never earlier than the part's end.
 * shortcut: no word timings exist, so times inside a part are proportional to characters; upgrade if word times arrive.
 */
function due(segs: TwinNode[], k: number): { at: number; cut: boolean } {
  const n = segs[k];
  const end = n.end as number;
  const nx = segs[k + 1];
  if (SENTENCE_END.test(n.text.trim()) || !nx || nx.start == null || nx.end == null || (nx.start as number) > end + 1) return { at: end, cut: false };
  const all = nx.text.trim();
  const first = /^.*?[.!?](?=\s|$)/.exec(all)?.[0] ?? all;
  const span = (nx.end as number) - (nx.start as number);
  // The later of the character share and the word share: a sentence cut off is worse than a short wait.
  const share = (chars: string) => Math.max(chars.length / Math.max(1, all.length), chars.split(/\s+/).length / Math.max(1, all.split(/\s+/).length));
  const at = Math.min(nx.end as number, (nx.start as number) + span * share(first));
  if (at <= end + WAIT_S) return { at, cut: false };
  // No sentence end near: the last word gap before the wait runs out.
  let gap = end;
  for (const m of all.matchAll(/\S+(?=\s)/g)) {
    const t = (nx.start as number) + span * share(all.slice(0, m.index + m[0].length));
    if (t > end + WAIT_S) break;
    gap = t;
  }
  return { at: gap, cut: true };
}
export const dueAt = (segs: TwinNode[], k: number) => due(segs, k).at;
/** True when part k's description has to stop the lecturer inside a sentence (no sentence ends near): it says less. */
export const midSentence = (segs: TwinNode[], k: number) => due(segs, k).cut;

/** The second a part's description shows: its picture's time (the frame it was written from), else the part's middle. */
const shownAt = (n: TwinNode) => {
  const at = n.image ? Number(new URL(n.image.url, "http://x").searchParams.get("at")) : NaN;
  return Number.isFinite(at) && n.image ? at : ((n.start as number) + (n.end as number)) / 2;
};
/**
 * "What is on the screen right now" at second t: of the parts with a description, the one shown latest at or before t (3 s of
 * slack); else the first one shown after t. -1 when none has a description. A part's description is of its end, so early in a
 * part the screen is still the one the part before described.
 */
export function screenAt(segs: TwinNode[], t: number): number {
  let best = -1;
  let next = -1;
  segs.forEach((n, k) => {
    if (!worthSaying(n)) return;
    if (shownAt(n) <= t + 3) {
      if (best < 0 || shownAt(n) >= shownAt(segs[best])) best = k;
    } else if (next < 0) next = k;
  });
  return best >= 0 ? best : next;
}

/** "1 minute 25", "40 seconds": for "Paused at 1 minute 25." */
export function saidTime(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  const mm = `${m} minute${m === 1 ? "" : "s"}`;
  return m ? (r ? `${mm} ${r}` : mm) : `${r} second${r === 1 ? "" : "s"}`;
}

// ---- what the question session may use about the open video ----
let open: Twin | null = null;
/** Called by VideoPlayer with the twin it follows on every render (null when it goes away). */
export const watchVideo = (t: Twin | null) => void (open = t);

const fit = (lines: string[], cap: number) => {
  const all = lines.join("\n");
  if (all.length <= cap) return all;
  const each = Math.max(60, Math.floor(cap / Math.max(1, lines.length)) - 1);
  return lines.map((l) => (l.length <= each ? l : `${l.slice(0, each).replace(/\s+\S*$/, "")}…`)).join("\n").slice(0, cap);
};

/**
 * Everything Arc knows about the open lecture video, as plain text at most `maxChars` long, for answering questions:
 * the title, every on-screen description with its time, for each picture whose tour has been built the tour's title, overview and
 * stops (the chart values), and the whole transcript with times. Empty when no video is open. Pictures first, because the values live there.
 */
export function videoContext(maxChars = 8000): string {
  const t = open;
  if (!t?.video) return "";
  const segs = segmentsOf(t.nodes);
  const head = `LECTURE VIDEO: ${t.source.title}.`;
  const tours = segs.filter((n) => n.tour).map((n) => `PICTURE AT ${clock(n.start as number)}: ${n.tour!.title}. ${n.tour!.overview}\n${n.tour!.stops.map((s, i) => `Stop ${i + 1}: ${s.label}. ${s.says}`).join("\n")}`);
  const screen = segs.filter(worthSaying).map((n) => `ON SCREEN AT ${clock(n.start as number)}: ${n.shown}`);
  const said = segs.filter((n) => n.text.trim()).map((n) => `[${clock(n.start as number)}] ${n.text.trim()}`);
  const a = fit(tours, Math.floor(maxChars * 0.4));
  const b = fit(screen, Math.min(Math.floor(maxChars * 0.3), maxChars - head.length - a.length));
  const c = fit(said, Math.max(0, maxChars - head.length - a.length - b.length - 40));
  return [head, a, b, c && `TRANSCRIPT:\n${c}`].filter(Boolean).join("\n\n").slice(0, maxChars);
}

/** The lines said when a video opens. No part count: the transcript may still be arriving. */
export function videoIntro(t: Twin): string[] {
  const v = t.video;
  if (!v) return [];
  const length = v.duration >= 90 ? ` It is ${plural(Math.round(v.duration / 60), "minute")} long.` : "";
  return [
    `Video: ${t.source.title}.${length}`,
    "Press P to play, or V to have me read it.",
    ...(v.captions === "auto" ? ["The words come from automatic captions and may have mistakes."] : []),
    ...(v.captions === "none" ? ["This video has no captions, so the words were written from the sound and may have mistakes."] : []),
    ...(v.enriched ? [] : ["The rest is still being prepared."]),
  ];
}

/** New headings and descriptions into the nodes. Returns the same array when nothing changed, so nothing re-renders. */
export function mergeShown(nodes: TwinNode[], headings: Record<string, string>, shown: Record<string, string>): TwinNode[] {
  let changed = false;
  const out = nodes.map((n) => {
    const h = headings[n.id];
    const s = shown[n.id];
    if ((h == null || h === n.heading) && (s == null || s === (n.shown ?? ""))) return n;
    changed = true;
    return { ...n, ...(h != null && { heading: h }), ...(s != null && { shown: s }) };
  });
  return changed ? out : nodes;
}

/** What /api/video/shown sends while a video is still being prepared. */
export type Frames = Record<string, { url: string; at: number; visual?: string }>;
export type Late = { headings?: Record<string, string>; shown?: Record<string, string>; segments?: TwinNode[]; duration?: number; frames?: Frames };

export const PICTURE_LINE = "There is a picture. Press Enter to explore it.";

/** A picture's address on this host, for the browser and for the tour route alike (the server fetches it back by this address). `at` rides along for the label. */
const frameUrl = (id: string, node: string, at: number) => `${location.origin}/api/video/frame?id=${id}&node=${node}&at=${Math.round(at)}`;

/** Pictures into their parts as `image`. Same array back when nothing is new. */
export function mergeFrames(nodes: TwinNode[], frames: Frames, id: string): TwinNode[] {
  let changed = false;
  const out = nodes.map((n) => {
    const f = frames[n.id];
    if (!f || n.image || n.kind !== "segment") return n;
    changed = true;
    return { ...n, image: { url: frameUrl(id, n.id, f.at), alt: n.shown || null } };
  });
  return changed ? out : nodes;
}

/** Late headings, descriptions, parts and length into the twin. Parts are added by id, in time order; the same twin comes back when nothing changed. */
export function mergeLate(t: Twin, d: Late): Twin {
  let nodes = mergeShown(t.nodes, d.headings ?? {}, d.shown ?? {});
  const have = new Set(nodes.map((n) => n.id));
  const fresh = (d.segments ?? []).filter((n) => n.kind === "segment" && !have.has(n.id));
  if (fresh.length) nodes = [...nodes, ...fresh].sort((a, b) => (a.start ?? a.order) - (b.start ?? b.order)); // stable: equal starts keep their order
  if (t.video && d.frames) nodes = mergeFrames(nodes, d.frames, t.video.id);
  const video = t.video && d.duration && d.duration > 0 && Math.round(d.duration) !== t.video.duration ? { ...t.video, duration: Math.round(d.duration) } : t.video;
  if (nodes === t.nodes && video === t.video) return t;
  return { ...t, nodes, video, counts: { ...t.counts, segments: segmentsOf(nodes).length } };
}
