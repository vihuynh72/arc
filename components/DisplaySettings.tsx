"use client";
// The one "Display" button in the header, mounted by app/page.tsx, and its panel: five ready-made profiles first,
// each axis behind "More options". Also runs the "display" voice and typed command (lib/client/decide.ts dispatches it).
import { useEffect, useRef, useState } from "react";
import { applyCommand, load, PROFILES, save, SIZES, THEMES, type Display, type Profile } from "@/lib/client/display";
import { said, speaker } from "@/lib/client/reader";

type Axis = Exclude<keyof Display, "profile">;
const AXES: { key: Axis; legend: string; options: [string, string][] }[] = [
  { key: "theme", legend: "Colours", options: Object.entries(THEMES) },
  { key: "text", legend: "Text size", options: SIZES.map((s) => [s, `${s}%`]) },
  { key: "spacing", legend: "Spacing", options: [["", "Normal"], ["wide", "Wide"]] },
  { key: "font", legend: "Typeface", options: [["", "Default"], ["legible", "Legible (Atkinson Hyperlegible)"]] },
  { key: "focus", legend: "Focus line", options: [["", "Off"], ["on", "On: dim everything but the current item"]] },
  { key: "motion", legend: "Motion", options: [["", "Follow my system"], ["reduce", "Reduce motion"]] },
  { key: "pointer", legend: "Reading pointer", options: [["", "Normal"], ["large", "Large"], ["off", "Off"]] },
  { key: "hints", legend: "Hints", options: [["", "On"], ["off", "Off"]] },
  { key: "realPointer", legend: "Move my real mouse pointer (on this computer only)", options: [["", "Off"], ["on", "On"]] },
];

export default function DisplaySettings() {
  const [s, setS] = useState<Display>({});
  const dialog = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const live = useRef(s);
  const [shownTheme, setShownTheme] = useState(""); // the theme in use, also when it follows the system

  const set = (next: Display) => {
    live.current = next;
    setS(next);
    save(next);
    setShownTheme(document.documentElement.dataset.theme ?? "");
  };

  useEffect(() => {
    live.current = load();
    // localStorage and the <html> attributes are only readable after mount
    setS(live.current);
    setShownTheme(document.documentElement.dataset.theme ?? "");
    const onCommand = (e: Event) => {
      const { name, args } = (e as CustomEvent<{ name: string; args?: { setting?: string } }>).detail ?? {};
      if (name !== "display" || !args?.setting) return;
      const r = applyCommand(live.current, args.setting);
      if (!r) return;
      set(r[0]);
      said(r[1]);
      void speaker.say([r[1]]);
    };
    window.addEventListener("arc:command", onCommand);
    return () => window.removeEventListener("arc:command", onCommand);
  }, []);

  const value = (k: Axis) => (k === "theme" ? shownTheme : k === "text" ? (s.text ?? "100") : (s[k] ?? ""));

  return (
    <div className="display">
      <button ref={button} type="button" aria-haspopup="dialog" onClick={() => dialog.current?.showModal()}>
        Display
      </button>
      <dialog ref={dialog} className="display-panel" aria-labelledby="display-title" onClose={() => button.current?.focus()}
        onKeyDown={(e) => e.stopPropagation()} // arrow keys here never move the reading cursor behind the panel
      >
        <h2 id="display-title">Display</h2>
        <p>Or just say it: &ldquo;bigger text&rdquo;, &ldquo;high contrast&rdquo;, &ldquo;too bright&rdquo;.</p>
        <fieldset>
          <legend>Ready-made profile</legend>
          {(Object.keys(PROFILES) as Profile[]).map((p) => (
            <label key={p}>
              <input type="radio" name="display-profile" value={p} checked={(s.profile ?? "default") === p} onChange={() => set({ ...PROFILES[p].set, profile: p })} />
              {PROFILES[p].label}
            </label>
          ))}
        </fieldset>
        <details>
          <summary>More options</summary>
          {AXES.map((a) => (
            <fieldset key={a.key}>
              <legend>{a.legend}</legend>
              {a.options.map(([v, label]) => (
                <label key={v}>
                  <input type="radio" name={`display-${a.key}`} value={v} checked={value(a.key) === v} onChange={() => set({ ...s, [a.key]: v || undefined })} />
                  {label}
                </label>
              ))}
            </fieldset>
          ))}
        </details>
        <p className="display-actions">
          <button type="button" onClick={() => set({})}>
            Reset
          </button>
          <button type="button" onClick={() => dialog.current?.close()}>
            Close
          </button>
        </p>
      </dialog>
    </div>
  );
}
