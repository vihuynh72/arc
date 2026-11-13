"use client";
// Push-to-talk. Hold Space while focused, or click to start and click/Escape to stop.
// A spoken request becomes an "arc:command" window event; a question gets a short spoken answer.
// The page may speak a confirmation by dispatching "arc:said" {text}; otherwise a default one is said.
import { useEffect, useRef, useState } from "react";
import { startMic } from "@/lib/client/audio";
import { askAudio, askEnd, askStart, chime, playAnswer, say, stop } from "@/lib/client/voice";

type Args = Record<string, unknown>;
const confirm: Record<string, (a: Args) => string> = {
  next: () => "Next.",
  prev: () => "Previous.",
  goto: (a) => `Moved to ${a.query}.`,
  search: (a) => `Searching for ${a.query}.`,
  open: () => "Opening the page.",
  // read, stop and tour: the page's own speech or silence is the confirmation
};

export default function AskButton() {
  const [state, setState] = useState<"idle" | "listening" | "error">("idle");
  const mic = useRef<{ id: string; close: Promise<(() => void) | undefined> } | undefined>(undefined);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const onCommand = (e: Event) => {
      const { name, args } = (e as CustomEvent<{ name: string; args: Args }>).detail;
      if (name === "stop") stop();
      const text = confirm[name]?.(args ?? {});
      clearTimeout(pending.current);
      if (text) pending.current = setTimeout(() => say(text), 1200); // unless the page says something first
    };
    const onSaid = (e: Event) => {
      clearTimeout(pending.current);
      const text = (e as CustomEvent<{ text: string }>).detail?.text;
      if (text) say(text);
    };
    window.addEventListener("arc:command", onCommand);
    window.addEventListener("arc:said", onSaid);
    return () => {
      window.removeEventListener("arc:command", onCommand);
      window.removeEventListener("arc:said", onSaid);
      clearTimeout(pending.current);
    };
  }, []);

  const begin = () => {
    if (mic.current) return;
    clearTimeout(pending.current);
    const id = askStart(); // also cancels any speech
    chime();
    const close = startMic(askAudio).catch((err) => {
      console.warn("[ask] microphone", err);
      setState("error");
      return undefined;
    });
    mic.current = { id, close };
    setState("listening");
  };

  const end = async () => {
    const m = mic.current;
    if (!m) return;
    mic.current = undefined;
    (await m.close)?.();
    askEnd();
    setState((s) => (s === "error" ? s : "idle"));
    await chime();
    await playAnswer(m.id);
  };

  const label =
    state === "listening"
      ? "Listening. Release Space, or press again, to send."
      : state === "error"
        ? "Ask: microphone blocked. Allow it and try again."
        : "Ask a question. Hold Space to talk.";

  return (
    <button
      type="button"
      aria-pressed={state === "listening"}
      onKeyDown={(e) => {
        if (e.key === " ") {
          e.preventDefault();
          if (!e.repeat) begin();
        } else if (e.key === "Escape" && mic.current) {
          e.preventDefault();
          end();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " ") {
          e.preventDefault(); // no click from Space
          end();
        }
      }}
      onClick={() => {
        if (mic.current) end();
        else begin();
      }}
    >
      {label}
    </button>
  );
}
