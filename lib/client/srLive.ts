// Experimental "Use my screen reader" mode (data-sr="on" on <html>, lib/client/display.ts): Arc's reading lines are written to one hidden
// live region (app/layout.tsx) for the student's own screen reader instead of being spoken. Only lib/client/reader.ts writes here.
// Never tour text, answers or sounds: those stay Arc's audio.
let pending = 0; // the frame waiting to set the text; silence() or a newer announce() cancels it

const region = () => (typeof document === "undefined" ? null : document.getElementById("sr-live"));

/** Setting is on (a plain attribute, so it can be read anywhere without importing the display module). */
export const srOn = () => typeof document !== "undefined" && document.documentElement.dataset.sr === "on";

/** Clears, then sets on the next frame: the same sentence said twice is still a change, so it is announced twice. */
export function announce(text: string) {
  const r = region();
  if (!r) return;
  cancelAnimationFrame(pending);
  r.textContent = "";
  pending = requestAnimationFrame(() => void (r.textContent = text));
}

export function silence() {
  cancelAnimationFrame(pending);
  const r = region();
  if (r?.textContent) r.textContent = "";
}
