// One record of what the student actually hears, for scripts/blind (the blind-student test harness). It only dispatches
// "arc:heard" on window: nothing in the app listens, so in production it costs one event per sound and changes nothing.
export type Heard =
  | { kind: "speech"; voice: "arc" | "gemini"; text: string; phase: "start" | "end" | "cut"; frac?: number } // frac: how far a cut line got
  | { kind: "sound"; name: string; hz?: number } // chime, listening-on, listening-off, tick, tone, wait-tone
  | { kind: "lecture"; state: "playing" | "paused"; at: number } // the video's own audio; at: seconds into the video
  | { kind: "pause"; on: boolean }; // P paused (or resumed) the voice mid-line

/** `t` (performance.now() time) is when the sound is audible, if that is not now (Web Audio scheduled ahead). */
export function heard(d: Heard, t = performance.now()) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("arc:heard", { detail: { ...d, t } }));
}
