"use client";
// The one box, in the page header, mounted by app/page.tsx. A link loads (a video link becomes an outline);
// anything else goes through lib/client/command.ts, the same path the voice uses.
import { useEffect, useRef, useState } from "react";
import { describe, submitUtterance } from "@/lib/client/command";
import { speaker } from "@/lib/client/reader";

// After a handled submit, focus leaves the box for the page (silent: #content has no name to read), so Space and
// the arrows work at once. "/" outside a text field, or Shift+Tab from there, comes back.
// During a figure tour, back to its key bar instead, where the arrows move between stops.
const leave = () =>
  (document.querySelector<HTMLElement>("[data-tour] [role='application'] button") ?? document.getElementById("content"))?.focus({ preventScroll: true });

// A web address with no spaces, with or without http(s)://.
const LINK = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(:\d+)?([/?#]\S*)?$/i;

export default function CommandBox() {
  const [text, setText] = useState("");
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLInputElement>(null);

  useEffect(() => void fetch("/api/decide").catch(() => {}), []); // warm the decision route and its SubQ connection

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement;
      const inText = !!t.closest?.("input, textarea, select, [contenteditable='true']");
      const onPage = t === document.body || t.id === "content";
      if ((e.key === "/" && !inText) || (e.key === "Tab" && e.shiftKey && onPage)) {
        e.preventDefault();
        box.current?.focus();
      } else if (e.key === "Escape" && t === box.current) leave();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <form
      className="command"
      onSubmit={async (e) => {
        e.preventDefault();
        const t = text.trim();
        if (!t || busy) return;
        if (LINK.test(t)) {
          setLine("");
          setText("");
          const url = /^https?:\/\//i.test(t) ? t : `https://${t}`;
          window.dispatchEvent(new CustomEvent("arc:command", { detail: { name: "load", args: { url } } }));
          leave();
          return;
        }
        setBusy(true);
        try {
          const d = await submitUtterance(t);
          setLine(describe(d));
          if (d.act) {
            setText("");
            leave();
          } else if (d.action === "question") {
            // shortcut: typed questions have no text path to Gemini Live yet; point to the voice instead of staying silent.
            leave(); // out of the box, so Space works at once
            void speaker.say(["Hold Space and ask that out loud."]);
          }
        } catch {
          setLine("That did not work. Try again.");
          void speaker.say(["That did not work. Try again, or hold Space and ask."]);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor="command">Paste a link, or tell Arc what you want</label>
      <input ref={box} id="command" type="text" value={text} onChange={(e) => setText(e.target.value)} aria-describedby="command-hint" autoComplete="off" />
      <p id="command-hint" className="hint">
        Press Enter. Outside this box, hold Space and speak. Press slash to come back here.
      </p>
      <p className="decision">{line}</p>
    </form>
  );
}
