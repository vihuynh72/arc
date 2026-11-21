"use client";
// Arc is the screen reader: the student's own one is off. So focus speaks (Tab onto a control says its name and what it is), a
// keyboard toggle or choice is confirmed in words, and on the start page (no reading cursor yet) every key gets an answer.
// Through the speaker only, never an aria-live region. Mounted once by components/Twin.tsx.
import { useEffect } from "react";
import { answering } from "./voice";
import { prefetchClip, speaker } from "./reader";
import { HELP_LOCAL, keyAct, NOTHING_PLAYING, OPENING, PAUSED, UNKNOWN_KEY } from "@/lib/keys";

const LANDING_HELP = "Hold Space and say what you want to study, or paste a link. Press slash to type. Press Tab to move between the controls.";
const NOTHING_OPEN = "Nothing is open yet. Hold Space and say what you want to study, or paste a link.";

/** The help command (lib/intent.ts words it for the mode); if nobody has spoken 300 ms later, `fallback`. */
export function askHelp(fallback: string) {
  const t0 = performance.now();
  window.dispatchEvent(new CustomEvent("arc:command", { detail: { name: "help" } }));
  setTimeout(() => speaker.sayAt < t0 && !answering() && void speaker.say([fallback]), 300);
}

const clean = (s?: string | null) => (s ?? "").replace(/\s+/g, " ").trim();
const OWN: [string, string][] = [
  ["#command", "Ask box. Type, or hold Space to talk."],
  [".mic", "Microphone, button. Hold it, or hold Space, to talk."],
];

/** What focus on `el` says, or "" for what speaks for itself (the page, a figure, the tour keys). */
export function focusLine(el: HTMLElement): string {
  if (el.closest("#content") && !el.matches("button, a[href], summary, input")) return "";
  if (el.matches("[role='application']")) return "";
  for (const [sel, line] of OWN) if (el.matches(sel)) return line;
  const text = clean(el.getAttribute("aria-label") ?? el.textContent);
  if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")) {
    const group = clean(el.closest("fieldset")?.querySelector("legend")?.textContent);
    return `${clean(el.closest("label")?.textContent) || text}, ${el.checked ? "selected" : "not selected"}, ${el.type === "radio" ? "radio button" : "check box"}${group ? `, in ${group}` : ""}.`;
  }
  if (el.matches("summary")) {
    const open = (el.parentElement as HTMLDetailsElement | null)?.open;
    return `${text}, ${open ? "expanded" : "collapsed"}. Press Enter to ${open ? "close" : "open"}.`;
  }
  const fig = el.closest("figure")?.getAttribute("data-label");
  if (el.matches("a[href]")) return `${text}, link.`;
  if (el.matches("button")) return `${text}, button${fig ? `, ${fig}` : ""}${el.getAttribute("aria-haspopup") ? ". Opens its settings" : ""}.`;
  if (el.matches("input, textarea, select")) return `${clean((el as HTMLInputElement).labels?.[0]?.textContent) || text || "Text"}, edit box.`;
  return "";
}

export function useFocusVoice() {
  useEffect(() => {
    // Every fixed line is made ahead (the server keeps it), so a key's answer starts in well under a second.
    const fixed = [UNKNOWN_KEY, NOTHING_OPEN, NOTHING_PLAYING, PAUSED, LANDING_HELP, HELP_LOCAL, OPENING, "Expanded.", "Collapsed.", "End of the page."];
    const controls = [...document.querySelectorAll<HTMLElement>("header button, header input, header a[href], a[href^='#']")].map(focusLine);
    for (const line of [...fixed, ...controls]) if (line) prefetchClip(line);
    let pointerAt = -1e9;
    let unknownAt = -1e9;
    const byPointer = () => performance.now() - pointerAt < 600;
    const onPointer = () => void (pointerAt = performance.now());
    const onFocus = (e: FocusEvent) => {
      const el = e.target as HTMLElement;
      if (byPointer() || !(el instanceof HTMLElement)) return;
      const into = el.closest("dialog") && !(e.relatedTarget as HTMLElement | null)?.closest?.("dialog");
      // A moment later: an arrow key in a radio group moves focus before it checks the radio.
      setTimeout(() => {
        const line = document.activeElement === el ? focusLine(el) : "";
        if (!line) return;
        const name = clean(el.closest("dialog")?.querySelector("h2")?.textContent);
        void speaker.say([into && name ? `${name} settings. ${line}` : line]);
      }, 0);
    };
    // A details panel opened or closed from the keyboard, a choice made with the pointer: said in one word or line.
    const onToggle = (e: Event) => {
      const d = e.target as HTMLElement;
      if (d instanceof HTMLDetailsElement && !byPointer() && d.querySelector(":scope > summary") === document.activeElement) void speaker.say([d.open ? "Expanded." : "Collapsed."]);
    };
    const onChange = (e: Event) => {
      const el = e.target as HTMLInputElement;
      if (el.type === "radio" && byPointer()) void speaker.say([`${clean(el.closest("label")?.textContent)}, selected.`]);
    };
    // The start page has no reading cursor (components/Reader.tsx answers keys on a page): here every key still gets a word.
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".reader") || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.closest?.("input, textarea, select, [contenteditable='true'], dialog")) return;
      const a = keyAct(e);
      if (!a || a.act === "escape") return;
      if (t.closest?.("button, a, summary") && a.act !== "help") return; // a control keeps its own keys; the help key always answers
      e.preventDefault();
      if (a.act === "help") return askHelp(LANDING_HELP);
      if (performance.now() - unknownAt < 4000) return;
      unknownAt = performance.now();
      void speaker.say([a.act === "unknown" ? UNKNOWN_KEY : NOTHING_OPEN]);
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("toggle", onToggle, true);
    document.addEventListener("change", onChange, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("toggle", onToggle, true);
      document.removeEventListener("change", onChange, true);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
}
