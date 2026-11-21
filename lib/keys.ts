// Arc's single keys and its fixed spoken cues. Pure (no DOM): components/Reader.tsx maps a key press with keyAct, speaks a figure
// with figureLines and numbers a section with sectionNo; components/AskButton.tsx and components/Landing.tsx share GREETING.
// Checked by scripts/checks/keys.ts.
import { numOf } from "./outline";
import type { TwinNode } from "./types";

export const GREETING = "Arc. Hold Space and say what you want to study, or paste a link.";
export const PAUSED = "Paused. Press Down to keep reading, or question mark for help.";
export const NOTHING_PLAYING = "Nothing is playing.";
export const UNKNOWN_KEY = "That key does nothing here. Press question mark for help.";
/** Said after a page's title and size: what one stop is, and the three essentials. */
export const OPENING = "Down arrow reads the next paragraph. H jumps by heading. Press question mark for help.";

/**
 * How the student has been acting lately (lib/client/command.ts inputStyle): by voice, by keys, or mixed and unknown.
 * Every prompt that names a key goes through cue: a student who only talks never hears "press", one who only uses keys hears
 * the key, and anyone else hears both, voice first.
 */
export type Style = "voice" | "keys" | "both";
export const cue = (s: Style, voice: string, keys: string, both = `${voice} Or ${keys.charAt(0).toLowerCase()}${keys.slice(1)}`) =>
  s === "voice" ? voice : s === "keys" ? keys : both;
/** The line after a page's title and size; by voice it comes with an offer: "yes" or "read" starts reading from the top. */
export const opening = (s: Style) =>
  cue(s, "Say read, and I will read it to you. Say help to hear what else you can say.", OPENING, "Say read, or press Down, to start reading. Say help, or press question mark, for more.");
export const paused = (s: Style) => cue(s, "Paused. Say go on when you are ready.", PAUSED, "Paused. Say go on, or press Down, to keep reading.");
/** On arriving at a figure the first time. */
export const tourOffer = (s: Style) => cue(s, "Say tour to explore it.", "Press Enter to explore it.", "Press Enter or say tour to explore it.");
/** A figure tour's first step ("begin") or the next one after the full tour arrives ("carry on"). */
export const tourStart = (s: Style, what = "begin") => cue(s, `Say next to ${what}.`, `Press Right Arrow to ${what}.`, `Say next, or press Right Arrow, to ${what}.`);
/** The tour introduction's last clause: it plays by itself, and how to take over. */
export const tourSelf = (s: Style) =>
  cue(s, "I will go through the parts. Say hold on to pause, or next to go at your own pace.", "I will go through the parts. Press P to pause, or Right Arrow to go at your own pace.", "I will go through the parts. Say hold on or press P to pause, or press Right Arrow to go at your own pace.");
/** After the last stop of a self-running tour. */
export const tourEnd = (s: Style) =>
  cue(s, "That is the end of the tour. Say again to hear a part again, or that's enough to go back to the page.", "That is the end of the tour. Left Arrow hears a part again; Escape goes back to the page.", "That is the end of the tour. Say again or press Left Arrow to hear a part again; say that's enough or press Escape to go back to the page.");
export type Auto = "on" | "paused" | "off";
/** The self-running tour, when stop k's line (k = -1: the introduction) has ended and the pause after it has passed. */
export const autoStep = (auto: Auto, k: number, stops: number): "next" | "end" | "wait" => (auto !== "on" ? "wait" : k + 1 < stops ? "next" : "end");

const MAC = typeof navigator !== "undefined" && /Mac|iP(?:hone|ad|od)/.test(navigator.platform ?? "");
/** The speed keys: Command (Control off a Mac) with Right Arrow faster, with Left Arrow slower. No other modifier. */
export function speedKey(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }, mac = MAC): "faster" | "slower" | null {
  if (!(mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) || e.altKey || e.shiftKey) return null;
  return e.key === "ArrowRight" ? "faster" : e.key === "ArrowLeft" ? "slower" : null;
}
/** How the speed keys are said. */
export const SPEED_KEYS = `${MAC ? "Command" : "Control"} with Right or Left Arrow`;
/** After search results are read out; `more`: there are results not read yet. */
export const resultsTail = (s: Style, more: boolean) =>
  cue(
    s,
    more ? "Say open and a number, or say more." : "Say open and a number.",
    "Press Down to hear each one, and Enter or its number to open it.",
    more ? "Say open and a number, or say more. Or press Down, then Enter or a number." : "Say open and a number. Or press Down, then Enter or a number.",
  );
/** A video's first line about playing it. */
export const videoPlay = (s: Style) => cue(s, "Say play to play it.", "Press P to play, or V to have me read it.", "Say play, or press P, to play it.");
/** After a figure that has no tour. */
export const hearAgain = (s: Style) => cue(s, "Say again to hear it again.", "Press R to hear it again.", "Say again, or press R, to hear it again.");
/** Spoken when nobody else answers the "help" command (lib/intent.ts owns the full wording). */
export const HELP_LOCAL =
  `Keys: Down and Up move one paragraph. H and Shift H, next and previous heading. F, figure. T, table. E, equation. 1 to 4, heading at that level. Home and End, top and end. R reads again. Enter tours a figure. ${SPEED_KEYS} changes speed. Escape stops. Hold Space to ask.`;
export const HINTS = {
  heading: "Tip: H jumps to the next heading.",
  page: "Tip: say go to page and a number.",
} as const;
export const RATE_MIN = 1;
export const RATE_MAX = 2;
/** "Slower. Speed 1.2, on a scale from 1 to 2." */
export const rateLine = (dir: "faster" | "slower" | "normal", r: number) =>
  dir === "normal"
    ? `Normal speed. ${r.toFixed(1)}, on a scale from ${RATE_MIN} to ${RATE_MAX}.`
    : (dir === "faster" && r >= RATE_MAX) || (dir === "slower" && r <= RATE_MIN)
      ? `That is the ${dir === "faster" ? "fastest" : "slowest"}: speed ${r.toFixed(1)}, on a scale from ${RATE_MIN} to ${RATE_MAX}.`
      : `${dir === "faster" ? "Faster" : "Slower"}. Speed ${r.toFixed(1)}, on a scale from ${RATE_MIN} to ${RATE_MAX}.`;

/** Escape out of the ask box while a tour is open: focus is back on the tour's keys. */
export const BACK_TO_TOUR = "Back to the tour. Right Arrow goes on, Escape leaves the tour.";

// Arc's own status and control lines: what a key, a setting or focus did, never page words or an answer.
const STATUS = [
  /^(?:faster|slower|normal speed|that is the (?:fastest|slowest))\b.*\bon a scale from\b/i,
  /^speed \d/i,
  /^paused\b/i,
  /^back to (?:the page|the tour)\b/i,
  /^(?:top of page|end of page|end of the page|that is the (?:first|last) one|stopped|nothing is playing|expanded|collapsed)\b/i,
  /^that key does nothing\b/i,
  /^(?:ask box|microphone, button)\b/i,
  /, (?:button|link|edit box|check box|radio button)(?:\.|, )/i, // what focus said: "Tour this figure, button, Figure 8.2."
];
/** True for a line that only reports what Arc did ("Slower. Speed 1.2, on a scale from 1 to 2."): "say that again" skips it. */
export const isStatusLine = (line: string) => STATUS.some((re) => re.test(line.trim()));

export type Jump ="heading" | "figure" | "table" | "equation";
export type KeyAct =
  | { act: "next" | "prev" | "nextSection" | "prevSection" | "top" | "end" | "enter" | "again" | "faster" | "slower" | "help" | "escape" | "play" | "mode" | "unknown" }
  | { act: "jump"; what: Jump; by: 1 | -1 }
  | { act: "level"; level: number };

const JUMPS: Record<string, Jump> = { h: "heading", f: "figure", t: "table", e: "equation" };

/** What a key does on the reading page, or null when it belongs to someone else (Space, slash, backquote, Tab) or is not a character. */
export function keyAct(k: { key: string; shiftKey?: boolean }, video = false): KeyAct | null {
  const { key } = k;
  const shift = !!k.shiftKey;
  if (key === "ArrowDown") return { act: shift ? "nextSection" : "next" };
  if (key === "ArrowUp") return { act: shift ? "prevSection" : "prev" };
  if (key === "ArrowRight") return { act: "next" };
  if (key === "ArrowLeft") return { act: "prev" };
  if (key === "Home") return { act: "top" };
  if (key === "End") return { act: "end" };
  if (key === "Enter") return { act: "enter" };
  if (key === "Escape") return { act: "escape" };
  if (key === "?") return { act: "help" };
  if (key === "+" || key === "=") return { act: "faster" };
  if (key === "-" || key === "_") return { act: "slower" };
  if (key.length !== 1 || key === " " || key === "/" || key === "`") return null;
  const low = key.toLowerCase();
  if (video && (/^[jkl]$/.test(low) || key === "<" || key === ">")) return null; // media keys: components/VideoPlayer.tsx acts on them (K pause, J and L 10 s, < and > speed)
  if (low === "r") return { act: "again" };
  if (video && low === "p") return { act: "play" };
  if (video && low === "v") return { act: "mode" };
  if (JUMPS[low]) return { act: "jump", what: JUMPS[low], by: shift ? -1 : 1 };
  if (/^[1-4]$/.test(key)) return { act: "level", level: Number(key) };
  return { act: "unknown" };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const firstSentence = (s: string) => s.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? s;
/** A PDF paragraph's `heading` is the section it sits under, except the page's own fillers ("Page 4", "Equation"). */
export const sectionName = (h: string) => (/^(page \d+|equation|table|figure)$/i.test(h.trim()) ? "" : h.trim());

/**
 * What the voice says on arriving at a figure: its label, then one description (Arc's description, else the caption; the caption
 * too only when it adds something, after "Caption:"). On a later arrival only the label and the first sentence.
 */
export function figureLines(n: Pick<TwinNode, "heading" | "text" | "image">, first: boolean): string[] {
  const label = n.heading.trim();
  const strip = (s: string) => s.replace(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[.:\\-–]?\\s*`, "i"), "").trim();
  const text = strip(n.text ?? "");
  const alt = strip(n.image?.alt ?? "");
  // The alt holds Arc's description and the caption after it (PDFs), or only the caption (web pages).
  const caption = alt && norm(alt) !== norm(text) && norm(alt).startsWith(norm(text)) ? alt.slice(text.length).trim() : "";
  const main = text || alt;
  if (!first) return [label, firstSentence(main)].filter(Boolean);
  return [label, main, ...(caption && !norm(main).includes(norm(caption)) ? [`Caption: ${caption}`] : [])].filter(Boolean);
}

/**
 * "2.1" for a heading numbered 2.1, else its place among the headings ("3", or "" on a page whose other headings are numbered); and how many sections there are at the top level
 * (numbered ones when the page numbers them). shortcut: swap for lib/outline.ts's own numbering once it exports one.
 */
export function sectionNo(heads: { heading: string }[], i: number): { no: string; of: number; name: string } {
  const nums = heads.map((h) => numOf(h.heading));
  const n = nums[i];
  const strip = (h: string) => h.replace(/^\s*(?:(?:appendix|chapter|section|part)\s+)?[\dA-Z]+(?:\.\d+)*\.?\s+/i, "").trim() || h.trim();
  if (n) return { no: n.num.join("."), of: nums.filter((x) => x && x.num.length === 1).length || heads.length, name: strip(heads[i].heading) };
  // An unnumbered heading on a numbered page ("Abstract", "References") gets no number: a made-up one would clash with the real ones.
  if (nums.some(Boolean)) return { no: "", of: nums.filter((x) => x && x.num.length === 1).length, name: heads[i].heading.trim() };
  return { no: String(i + 1), of: heads.length, name: heads[i].heading.trim() };
}
