// Model and voice ids: the only place they are defined.
export const GEMINI_VISION_MODEL = "gemini-3.5-flash-lite";
// Charts only: one call that reads the data (picked by measuring on Figures 20 to 22 of the lower-limb paper).
export const GEMINI_CHART_MODEL = "gemini-4-hydrogen";
// Chart reading falls back in this order on 429/500/503/timeout (lib/server/gemini.ts generateJsonChain). Order measured
// on Figures 20 and 21 of the lower-limb paper and a Wikimedia bar chart: see the HH-prebuild handoff.
export const GEMINI_CHART_MODELS = [GEMINI_CHART_MODEL, "gemini-3.6-flash"];
export const GEMINI_LIVE_MODEL = "gemini-3.8-live";
export const LIVE_VOICE = "Sulafat";
export const KOKORO_VOICE = "af_bella";
// Context-aware transcription of a finished spoken request (whole clip plus the page's names). Measured: gemini-3.8-flash
// timed out (over 15 s); gemini-4-hydrogen took 3 to 5 s and hit 429 (it shares quota with chart reading).
export const GEMINI_HEARING_MODEL = "gemini-3.5-flash-lite";
// Video outlines (a YouTube fileData part), through generateJsonChain so a failure falls back.
// Measured on the Khan atomic-weight video (EPvd-3712U8, 266 s): gemini-3.6-flash 20 s, quoted slide text; gemini-4-hydrogen 21 s,
// quoted more of it ("13C 1.110% 13.0034 amu", the final equation) and its last segment was specific where 3.6-flash's was generic.
export const GEMINI_VIDEO_MODELS = ["gemini-4-hydrogen", GEMINI_VISION_MODEL];
