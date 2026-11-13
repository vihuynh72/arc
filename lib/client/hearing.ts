// What Arc heard: the rules that turn several transcripts of one spoken request into the text to act on.
// Mishearing is the worst failure for a blind student, so a guess never acts on its own (see actNow).

/** Lowercase words only, for comparing transcripts from different recognisers. */
export const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Single words that mean one thing on every page; anything longer needs two sources or the final transcript.
const SURE_WORDS = new Set(["next", "back", "again", "stop"]);

export interface Early {
  gemini?: { text: string; at: number }; // Gemini transcription session, interim
  chrome?: { text: string; at: number }; // the browser's speech recognition, interim
}

/**
 * At key release: the text to act on at once, or undefined to wait for the relay's final "heard".
 * Acts only when Gemini and Chrome agree, or one source has said exactly one unambiguous command word for stableMs.
 */
export function actNow(e: Early, now: number, stableMs = 350): { text: string; source: string } | undefined {
  const g = e.gemini && norm(e.gemini.text);
  const c = e.chrome && norm(e.chrome.text);
  if (g && c && g === c) return { text: g, source: "gemini+chrome" };
  for (const [source, s] of [["gemini", e.gemini], ["chrome", e.chrome]] as const) {
    if (s && SURE_WORDS.has(norm(s.text)) && now - s.at >= stableMs) return { text: norm(s.text), source };
  }
  return undefined;
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
export const heardUnsure = (text: string) => `I heard: ${text}. I am not sure what to do.`;
export const TOO_QUIET = "I can barely hear you. Move closer to the microphone.";
