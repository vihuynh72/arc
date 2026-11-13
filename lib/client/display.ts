// Display profiles: how the page looks for a student with some vision. Each axis is one attribute on <html>
// (data-theme, data-text, data-spacing, data-font, data-focus, data-motion); app/profiles.css styles them, so they combine.
// Used by components/DisplaySettings.tsx (the panel and the "display" voice command) and app/layout.tsx (paint before first paint).

export const THEMES = { paper: "Paper", contrast: "High contrast light", "contrast-dark": "High contrast dark", "low-glare": "Low glare dark", cream: "Soft cream" } as const;
export const SIZES = ["100", "125", "150", "200"] as const;
export type Theme = keyof typeof THEMES;
export type Profile = "default" | "low-vision" | "light-sensitive" | "dyslexia" | "narrow-field";

/** What the student chose; a missing axis means the default (theme and motion: follow the system). */
export interface Display {
  profile?: Profile;
  theme?: Theme;
  text?: (typeof SIZES)[number];
  spacing?: "wide";
  font?: "legible";
  focus?: "on";
  motion?: "reduce";
  voiceFirst?: true; // "I am blind": everything shown is also said, reading runs on, moves say where they land
}

export const PROFILES: Record<Profile, { label: string; set: Display }> = {
  default: { label: "Default", set: {} },
  "low-vision": { label: "Low vision", set: { theme: "contrast", text: "150", font: "legible" } },
  "light-sensitive": { label: "Light sensitive", set: { theme: "low-glare", motion: "reduce" } },
  dyslexia: { label: "Dyslexia friendly", set: { theme: "cream", spacing: "wide", font: "legible" } },
  "narrow-field": { label: "Narrow field of view", set: { focus: "on", text: "125" } },
};

/** The fixed list the decision step chooses from for the "display" action (lib/server/decide.ts). */
export const DISPLAY_COMMANDS: Record<string, string> = {
  bigger: "make the text bigger or larger, zoom in",
  smaller: "make the text smaller, zoom out",
  contrast: "high contrast, black text on white, sharper colours",
  "contrast-dark": "dark mode, white text on black",
  "low-glare": "it is too bright, the light hurts, dim the screen, low glare",
  cream: "cream or off-white background, softer colours",
  paper: "normal colours, light mode",
  wide: "wider spacing between letters, words and lines",
  normal: "normal spacing",
  legible: "an easier to read font or typeface",
  "default-font": "the normal font",
  "focus-on": "turn on the focus line, dim everything except where I am reading",
  "focus-off": "turn off the focus line",
  "reduce-motion": "stop the motion or animation, reduce motion",
  reset: "reset the display, back to the default look",
  "low-vision": "the low vision profile, I have low vision",
  "light-sensitive": "the light sensitive profile, I am sensitive to light",
  dyslexia: "the dyslexia friendly profile, I have dyslexia",
  "narrow-field": "the narrow field of view profile, I have tunnel vision",
  "voice-first": "I am blind, I cannot see the screen, voice first, blind mode",
  "voice-first-off": "turn off voice first",
};

export const VOICE_FIRST_ON = "Okay. I will tell you everything out loud. Hold Space to talk, arrow keys to move.";
/** Voice first is on (persisted with the display settings). */
export const voiceFirst = () => typeof window !== "undefined" && load().voiceFirst === true;

const KEY = "arc-display";

/**
 * Sets the attributes on <html>. Self-contained (no imports, no closures): app/layout.tsx inlines its source to run
 * before first paint, so there is no flash of the wrong theme.
 */
export function paint(s: Display) {
  const d = document.documentElement;
  const m = (q: string) => window.matchMedia(q).matches;
  const dark = m("(prefers-color-scheme: dark)");
  d.dataset.theme = s.theme || (m("(prefers-contrast: more)") ? (dark ? "contrast-dark" : "contrast") : dark ? "low-glare" : "paper");
  d.dataset.text = s.text || "100";
  d.dataset.spacing = s.spacing || "normal";
  d.dataset.font = s.font || "default";
  d.dataset.focus = s.focus || "off";
  d.dataset.motion = s.motion || (m("(prefers-reduced-motion: reduce)") ? "reduce" : "auto");
}

export const BOOT = `try{(${paint.toString()})(JSON.parse(localStorage.getItem(${JSON.stringify(KEY)})||"{}"))}catch(e){}`;

export function load(): Display {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") as Display;
  } catch {
    return {};
  }
}

export function save(s: Display) {
  paint(s);
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {} // private window: the look still applies for this visit
}

/** Pure: the new choice and the one short sentence that confirms it, for one display command. */
export function applyCommand(s: Display, cmd: string): [Display, string] | null {
  if (cmd === "voice-first") return [{ ...s, voiceFirst: true }, VOICE_FIRST_ON];
  if (cmd === "voice-first-off") {
    const rest = { ...s };
    delete rest.voiceFirst;
    return [rest, "Voice first off."];
  }
  if (cmd in PROFILES) return [{ ...PROFILES[cmd as Profile].set, profile: cmd as Profile, ...(s.voiceFirst ? { voiceFirst: true as const } : {}) }, `${PROFILES[cmd as Profile].label}.`];
  if (cmd === "reset") return [{}, "Display reset."];
  if (cmd in THEMES) return [{ ...s, theme: cmd as Theme }, `${THEMES[cmd as Theme]}.`];
  const at = SIZES.indexOf(s.text ?? "100");
  if (cmd === "bigger" || cmd === "smaller") {
    const text = SIZES[Math.max(0, Math.min(SIZES.length - 1, at + (cmd === "bigger" ? 1 : -1)))];
    return [{ ...s, text }, `Text size ${text} percent.`];
  }
  const one: Record<string, [Partial<Display>, string]> = {
    wide: [{ spacing: "wide" }, "Wide spacing."],
    normal: [{ spacing: undefined }, "Normal spacing."],
    legible: [{ font: "legible" }, "Legible typeface."],
    "default-font": [{ font: undefined }, "Default typeface."],
    "focus-on": [{ focus: "on" }, "Focus line on."],
    "focus-off": [{ focus: undefined }, "Focus line off."],
    "reduce-motion": [{ motion: "reduce" }, "Motion reduced."],
  };
  return one[cmd] ? [{ ...s, ...one[cmd][0] }, one[cmd][1]] : null;
}
