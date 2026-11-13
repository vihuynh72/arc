"use client";
// Typed request box in the page header, mounted by app/page.tsx. Calls lib/client/command.ts, the same path the voice button uses.
import { useState } from "react";
import { describe, submitUtterance } from "@/lib/client/command";

export default function CommandBox() {
  const [text, setText] = useState("");
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="command"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim() || busy) return;
        setBusy(true);
        try {
          setLine(describe(await submitUtterance(text)));
        } catch {
          setLine("That did not work. Try again.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor="command">Tell Arc what to do</label>
      <input id="command" type="text" value={text} onChange={(e) => setText(e.target.value)} aria-describedby="command-hint" autoComplete="off" />
      <p id="command-hint" className="hint">
        For example: go to the results, tour figure one, find a paper about knee rehab. Press Enter.
      </p>
      <p className="decision">{line}</p>
    </form>
  );
}
