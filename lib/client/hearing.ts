// What Arc heard: the rules that turn several transcripts of one spoken request into the text to act on.
// Mishearing is the worst failure for a blind student, so a guess never acts on its own (see mayDispatch).

/** Lowercase words only, for comparing transcripts from different recognisers. */
export const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * The one rule that keeps a wrong move away from a blind student: nothing runs while the key is held (the voice already
 * stopped when the key went down, so a barge-in "stop" needs no transcript), and nothing runs from an early (partial)
 * transcript, which trails speech and is often a fragment ("Go" of "go back", "Move" of "move down", "Next" of "next
 * section"). Early words only warm the decision; a command runs after release, on the final transcript.
 */
export function mayDispatch(from: "partial" | "final", released: boolean): boolean {
  return from === "final" && released;
}

/**
 * The text to submit once the final transcripts are in. The context-aware reading (a stronger model that knew the
 * page) wins when it has words; otherwise Gemini's live transcript, then Chrome's.
 */
export function bestReading(sources: { gemini?: string; chrome?: string; context?: { text: string; alternatives: string[] } }): {
  text: string;
  alternatives: string[];
  source: "context" | "gemini" | "chrome" | "none";
} {
  const alts = (sources.context?.alternatives ?? []).filter((a) => a.trim());
  if (sources.context?.text.trim()) return { text: sources.context.text.trim(), alternatives: alts, source: "context" };
  if (sources.gemini?.trim()) return { text: sources.gemini.trim(), alternatives: alts, source: "gemini" };
  if (sources.chrome?.trim()) return { text: sources.chrome.trim(), alternatives: alts, source: "chrome" };
  return { text: "", alternatives: [], source: "none" };
}

export const HEARD_NOTHING = "I did not hear anything. Hold Space while you speak.";
export const NOT_CAUGHT = "Sorry, I didn't catch that. Could you say it again?";
export const ONE_MOMENT = "One moment.";
export const LOST_LINE = "I lost the connection. Hold Space and say it again.";
export const TOO_QUIET = "I can barely hear you. Move closer to the microphone.";
