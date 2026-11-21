"use client";
// The one place to ask, in the page header (also on the landing page), mounted by app/page.tsx: a text box with the microphone
// (components/AskButton.tsx) joined to its end. Typed, a link loads (a video link becomes an outline) and anything else goes through
// lib/client/command.ts, the same path the voice uses. One state for both ways: idle, listening, thinking, done.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import AskButton from "@/components/AskButton";
import { describe, submitUtterance, viaGemini } from "@/lib/client/command";
import { speaker } from "@/lib/client/reader";
import { askHelp } from "@/lib/client/focusVoice";
import { HELP_LOCAL } from "@/lib/keys";

// After a handled submit, focus leaves the box for the page (silent: #content has no name to read), so Space and
// the arrows work at once. "/" outside a text field, or Shift+Tab from there, comes back.
// During a figure tour, back to its key bar instead, where the arrows move between stops.
const leave = () =>
  (document.querySelector<HTMLElement>("[data-tour] [role='application']") ?? document.getElementById("content"))?.focus({ preventScroll: true });

// Arc cannot speak inside the computer's file chooser, so it says where the student is going first, and how to come back.
const CHOOSER = "Opening your computer's file chooser. Choose a PDF, or press Escape to come back.";
const CHOOSER_MS = 3500; // the chooser opens when the line ends or after this long: Chrome lets a key press or click open it for 5 s
const NO_FILE = "No file chosen. Back in Arc.";

// A web address with no spaces, with or without http(s)://.
const LINK = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(:\d+)?([/?#]\S*)?$/i;

// What a command did, in plain words, for the one line under the box. The raw decision (action, confidence, ms) is only shown with ?debug=1.
const PLAIN: Record<string, (a: Record<string, unknown>) => string> = {
  next: () => "Next",
  prev: () => "Previous",
  nextHeading: () => "Next section",
  prevHeading: () => "Previous section",
  nextFigure: () => "Next figure",
  prevFigure: () => "Previous figure",
  return: () => "Went back",
  goto: (a) => (a.query ? `Went to ${String(a.query)}` : "Moved"),
  page: (a) => (a.n ? `Page ${String(a.n)}` : a.by === 1 ? "Next page" : a.by === -1 ? "Previous page" : "Page"),
  read: () => "Reading again",
  continue: () => "Reading on",
  stop: () => "Stopped",
  faster: () => "Faster",
  slower: () => "Slower",
  tour: () => "Figure tour",
  search: (a) => `Searching for ${String(a.query ?? "")}`,
  open: () => "Opening",
  display: () => "Display changed",
  load: () => "Opening the page",
};
const debug = () => typeof document !== "undefined" && document.documentElement.dataset.debug != null;
// The answer strip sits just above the reader bar, whatever its height (its button panel may be open).
const above = () => {
  const bar = document.querySelector(".reader")?.getBoundingClientRect();
  return bar && bar.top < window.innerHeight ? `${Math.round(window.innerHeight - bar.top + 12)}px` : "1rem";
};

export default function CommandBox() {
  const [text, setText] = useState("");
  const [line, setLine] = useState("");
  const [detail, setDetail] = useState(""); // the raw decision, shown only with ?debug=1
  const [answer, setAnswer] = useState(""); // Gemini's answer to a question, as static text (the voice speaks it), in its own strip
  const [bottom, setBottom] = useState("6rem");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"idle" | "listening" | "thinking" | "done">("idle");
  const phaseTimer = useRef(0);
  const settle = () => {
    // Something happened (a move, an answer): "done" for a moment, then idle.
    clearTimeout(phaseTimer.current);
    setPhase((p) => (p === "listening" ? p : "done"));
    phaseTimer.current = window.setTimeout(() => setPhase((p) => (p === "done" ? "idle" : p)), 1500);
  };
  const box = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const pick = useRef<HTMLButtonElement>(null);
  const answerPending = useRef(false);
  const from = useRef<HTMLElement | null>(null); // where focus was when "/" took it: Escape gives it back
  const picking = useRef(false); // the file chooser is open: the browser re-focuses the button when it closes, and that is not announced
  const back = useRef<HTMLElement | null>(null); // where focus was when the chooser was asked for
  const opening = useRef(0); // the chooser is about to open (its line is being said)
  const [drop, setDrop] = useState(false); // a file is being dragged over the bar

  // Say the line, then open the chooser while the key press or click that asked for it still counts (user activation).
  const choose = (e?: { detail?: number }) => {
    if (opening.current) return; // its line is being said already
    picking.current = true;
    back.current = document.activeElement as HTMLElement | null;
    let done = false;
    const open = () => {
      if (done) return;
      done = true;
      clearTimeout(opening.current);
      opening.current = 0;
      if (!picking.current) return; // Escape before it opened
      if (navigator.userActivation?.isActive === false) {
        picking.current = false;
        pick.current?.focus({ preventScroll: true });
        return void speaker.say(["Press Enter on the upload button to choose a file."]);
      }
      file.current?.click();
    };
    // A mouse click (a key press on the button has detail 0): the student can see the chooser, so it opens at once and the line is
    // said as it opens. A wait there only looks broken.
    if ((e?.detail ?? 0) > 0) {
      void speaker.say([CHOOSER]);
      return open();
    }
    opening.current = window.setTimeout(open, CHOOSER_MS);
    void speaker.say([CHOOSER]).then((ok) => ok && open()); // cut by a key: Escape cancels (below), any other key waits for the timer
  };

  useEffect(() => void fetch("/api/decide").catch(() => {}), []); // warm the decision route and its connection to the decision service

  useEffect(() => {
    if (new URLSearchParams(location.search).has("debug")) document.documentElement.dataset.debug = "1";
    // Any command, typed or spoken, gets its plain line; the answer strip goes on the next move.
    const onCommand = (e: Event) => {
      const d = (e as CustomEvent<{ name: string; args?: Record<string, unknown> }>).detail;
      if (!d || d.args?.silent || !PLAIN[d.name]) return;
      if (d.name === "goto" && performance.now() - pageAt < 15_000) return; // "go to page 4" then lands on its first stop: keep "Page 4"
      pageAt = d.name === "page" ? performance.now() : 0;
      setLine(PLAIN[d.name](d.args ?? {}));
      settle();
      named = d.name === "goto" && !d.args?.query ? performance.now() : 0;
    };
    let pageAt = 0;
    let named = 0; // a goto by position ("skip this section"): the line names where the cursor lands
    const clear = () => setAnswer("");
    const onCursor = (e: Event) => {
      clear();
      const h = (e as CustomEvent<{ heading?: string }>).detail?.heading;
      if (named && performance.now() - named < 1500 && h) setLine(`Went to ${h}`);
      named = 0;
    };
    const onKey = (e: KeyboardEvent) => void (e.key === "Escape" && clear());
    // A spoken question's answer: the Ask button writes it into its own line (shown only with ?debug=1); mirrored into the strip.
    // shortcut: reads AskButton's line format (· Gemini: "..."); a dedicated event from AskButton would be sturdier.
    const askLine = document.querySelector("header .ask .decision");
    const mo = new MutationObserver(() => {
      const m = /· Gemini: "([\s\S]+)"$/.exec(askLine?.textContent ?? "");
      if (m) {
        setLine("Answer");
        setAnswer(m[1]);
        settle();
      }
    });
    // The microphone is pressed while Arc listens; released, Arc thinks until something happens (at most 6 s).
    const micEl = document.querySelector(".command .mic");
    const mo2 = new MutationObserver(() => {
      clearTimeout(phaseTimer.current);
      if (micEl?.getAttribute("aria-pressed") === "true") return setPhase("listening");
      setPhase("thinking");
      phaseTimer.current = window.setTimeout(() => setPhase((p) => (p === "thinking" ? "idle" : p)), 6000);
    });
    if (micEl) mo2.observe(micEl, { attributes: true, attributeFilter: ["aria-pressed"] });
    if (askLine) mo.observe(askLine, { childList: true, characterData: true, subtree: true });
    window.addEventListener("arc:command", onCommand);
    window.addEventListener("arc:cursor", onCursor);
    window.addEventListener("arc:block", clear);
    window.addEventListener("keydown", onKey);
    return () => {
      mo.disconnect();
      mo2.disconnect();
      window.removeEventListener("arc:command", onCommand);
      window.removeEventListener("arc:cursor", onCursor);
      window.removeEventListener("arc:block", clear);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  useEffect(() => {
    if (!answer) return;
    const place = () => setBottom(above());
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, { passive: true }); // the bar is sticky: it can sit higher at the end of the page
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place);
    };
  }, [answer]);

  // Focus anywhere in the header keeps the bar on screen, so the browser never scrolls the page to show it. Wide windows: the header is
  // already sticky, and html's scroll-padding (see globals.css) is lifted meanwhile. Narrow or zoomed windows: the header sticks, with the
  // bar at the top of the window, only while it has focus (sticky changes no layout: nothing below moves).
  useEffect(() => {
    const head = document.querySelector("header");
    const pin = (on: boolean) => {
      if (!head || (on && (head.hasAttribute("data-pin") || getComputedStyle(head).position !== "static"))) return;
      if (on) head.style.setProperty("--pin", `-${Math.max(0, (document.querySelector(".command .bar")?.getBoundingClientRect().top ?? 8) - head.getBoundingClientRect().top - 8)}px`);
      head.toggleAttribute("data-pin", on);
    };
    const onIn = (e: FocusEvent) => pin(!!(e.target as HTMLElement).closest?.("header"));
    const onOut = (e: FocusEvent) => void (e.relatedTarget || pin(false));
    const button = pick.current;
    const quiet = (e: Event) => void (picking.current && e.stopImmediatePropagation()); // before focus speech (a document listener) hears it
    const closed = () => setTimeout(() => (picking.current = false), 1000); // shortcut: a browser with no "cancel" event keeps its button silent once; upgrade if one matters
    // Closed with no file: back where the student was, and said so.
    const cancelled = () => {
      closed();
      (back.current?.isConnected ? back.current : pick.current)?.focus({ preventScroll: true });
      void speaker.say([NO_FILE]);
    };
    const input = file.current;
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    button?.addEventListener("focusin", quiet);
    input?.addEventListener("cancel", cancelled);
    input?.addEventListener("change", closed);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
      button?.removeEventListener("focusin", quiet);
      input?.removeEventListener("cancel", cancelled);
      input?.removeEventListener("change", closed);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (e.key === "Escape" && opening.current) {
        // Escape while the line is said: the chooser does not open after all.
        picking.current = false;
        clearTimeout(opening.current);
        opening.current = 0;
        return void setTimeout(() => void speaker.say([NO_FILE]), 0);
      }
      const inText = !!t.closest?.("input, textarea, select, [contenteditable='true']");
      const onPage = t === document.body || t.id === "content";
      if ((e.key === "/" && !inText) || (e.key === "Tab" && e.shiftKey && onPage)) {
        e.preventDefault();
        from.current = t === document.body || t.id === "content" ? null : t;
        box.current?.focus({ preventScroll: true }); // the page stays where the student left it
      } else if (e.key === "Escape" && t === box.current) {
        if (from.current?.isConnected) from.current.focus({ preventScroll: true });
        else leave();
      }
    };
    // "open a file", "upload a PDF": the browser opens the chooser only soon after a key press. When it is too late, the button takes focus instead.
    const onCommand = (e: Event) => {
      if ((e as CustomEvent<{ name: string }>).detail?.name !== "upload") return;
      if (navigator.userActivation?.isActive !== false) return void choose();
      pick.current?.focus({ preventScroll: true });
      void speaker.say(["Press Enter on the upload button."]);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("arc:command", onCommand);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("arc:command", onCommand);
    };
  }, []);

  return (
    <form
      className="command"
      data-state={phase}
      data-drop={drop || undefined}
      onDragOver={(e) => setDrop([...e.dataTransfer.items].some((i) => i.kind === "file"))} // the page itself takes the drop (lib/client/pdf.ts watchPdfFiles)
      onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget as Node | null) || setDrop(false)}
      onDrop={() => setDrop(false)}
      onSubmit={async (e) => {
        e.preventDefault();
        const t = text.trim();
        if (!t || busy) return;
        if (LINK.test(t)) {
          setLine("Opening the page");
          setDetail("");
          setText("");
          const url = /^https?:\/\//i.test(t) ? t : `https://${t}`;
          window.dispatchEvent(new CustomEvent("arc:command", { detail: { name: "load", args: { url } } }));
          leave();
          return;
        }
        setBusy(true);
        setPhase("thinking");
        setAnswer("");
        try {
          const d = await submitUtterance(t, {
            onAnswer: (a) => {
              setLine("Answer");
              setAnswer(a);
              settle();
            },
          });
          setDetail(describe(d));
          answerPending.current = viaGemini(d);
          if (viaGemini(d)) setLine("Thinking about your question");
          else if (!d.act) setLine(describe(d).split(" · ")[0].replace(/^./, (c) => c.toUpperCase())); // "I could not find …", "Not a request"
          if (d.act) {
            setText("");
            leave();
          } else if (viaGemini(d)) {
            setText(""); // else the next paste is appended to the old question
            leave(); // the answer is spoken and shown here; out of the box, so Space works at once
          }
        } catch {
          setLine("That did not work. Try again.");
          setDetail("");
          void speaker.say(["That did not work. Try again, or hold Space and ask."]);
        } finally {
          setBusy(false);
          setPhase((p) => (p === "thinking" && !answerPending.current ? "done" : p));
          window.dispatchEvent(new Event("arc:recenter")); // whatever was asked, the student's place is back on screen
        }
      }}
    >
      <label htmlFor="command">Ask Arc anything, or paste a link</label>
      <div className="bar">
        <input
          ref={box}
          id="command"
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => (from.current = null)}
          aria-describedby="command-hint"
          autoComplete="off"
          placeholder={drop ? "Drop the PDF here" : phase === "listening" ? "Listening…" : phase === "thinking" ? "Thinking…" : ""}
        />
        <button ref={pick} type="button" className="pick" aria-label="Upload a PDF file" onClick={choose}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
            <path d="M12 16V4M7 9l5-5 5 5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>Upload</span>
        </button>
        <AskButton />
      </div>
      <p id="command-hint" className="hint">
        Hold Space to talk, or press / to type.{" "}
        <button type="button" className="upload" onClick={() => askHelp(document.querySelector(".reader") ? HELP_LOCAL : "Hold Space and say what you want to study, or paste a link. Press slash to type.")}>
          Help
        </button>
      </p>
      <input
        ref={file}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = ""; // the same file can be chosen again
          if (!f) return; // cancelled: nothing said, focus stays on the button
          window.dispatchEvent(new CustomEvent("arc:command", { detail: { name: "pdf-file", args: { file: f } } })); // the page says "Opening <name>." and opens it, as for a drop
          leave(); // so Space talks at once, not "press the button again"
        }}
      />
      <p className="decision">
        {line}
        {detail && debug() && <small> · {detail}</small>}
      </p>
      {answer && createPortal(
        <section className="answer" aria-label="Answer" style={{ ["--answer-bottom" as string]: bottom }}>
          <p>Answer</p>
          <p>{answer}</p>
          <button type="button" onClick={() => setAnswer("")}>
            Close
          </button>
        </section>,
        document.body, // not inside the header: its blur makes it the frame for fixed children
      )}
    </form>
  );
}
