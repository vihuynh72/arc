"use client";
// The one box, in the page header, mounted by app/page.tsx. A link loads (a video link becomes an outline);
// anything else goes through lib/client/command.ts, the same path the voice uses.
import { useEffect, useState } from "react";
import { describe, submitUtterance } from "@/lib/client/command";

// A web address with no spaces, with or without http(s)://.
const LINK = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(:\d+)?([/?#]\S*)?$/i;

export default function CommandBox() {
  const [text, setText] = useState("");
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => void fetch("/api/decide").catch(() => {}), []); // warm the decision route and its SubQ connection

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
          return;
        }
        setBusy(true);
        try {
          const d = await submitUtterance(t);
          setLine(describe(d));
          if (d.act) setText("");
        } catch {
          setLine("That did not work. Try again.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor="command">Paste a link, or tell Arc what you want</label>
      <input id="command" type="text" value={text} onChange={(e) => setText(e.target.value)} aria-describedby="command-hint" autoComplete="off" />
      <p id="command-hint" className="hint">
        Press Enter. Outside this box, hold Space and speak.
      </p>
      <p className="decision">{line}</p>
    </form>
  );
}
