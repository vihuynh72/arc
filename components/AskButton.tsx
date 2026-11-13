"use client";
// Push-to-talk, mounted once in the page header. Hold Space while focused, or click to start and click/Escape to stop.
// Snap decides first ("Gemini should wrap around Snap"): when Snap is sure the command runs at once and Gemini's
// reply is dropped; for a question or an unclear request Gemini answers (or asks what was meant), or its command runs.
// Kokoro reading the node where the cursor lands is the confirmation, so this control speaks none of its own.
import { useEffect, useRef, useState } from "react";
import { startMic } from "@/lib/client/audio";
import { describe, submitUtterance } from "@/lib/client/command";
import { speaker } from "@/lib/client/reader";
import { askAudio, askEnd, askStart, audioState, chime, dropAnswer, playAnswer, say, stop, type AskHooks } from "@/lib/client/voice";

type Args = Record<string, unknown>;
type Mic = (onChunk: (b64: string) => void) => Promise<() => void>;
interface Ask {
  id: string;
  t0: number; // key release
  owner?: "snap" | "gemini"; // who handles this ask; the other is ignored
  held: { name: string; args: Args }[]; // Gemini commands waiting for Snap's decision
  ran: boolean;
  gemini?: number;
}

const dispatch = (name: string, args: Args) => window.dispatchEvent(new CustomEvent("arc:command", { detail: { name, args } }));
const time = (ask: Ask, what: string, at = performance.now()) => console.info(`[arc-timing] ${ask.id} ${what} ${Math.round(at - ask.t0)} ms after release`);

export default function AskButton() {
  const [state, setState] = useState<"idle" | "listening" | "error">("idle");
  const [line, setLine] = useState("");
  const mic = useRef<{ ask: Ask; close: Promise<(() => void) | undefined> } | undefined>(undefined);
  const current = useRef<Ask | undefined>(undefined);
  const lastCommand = useRef(0);

  useEffect(() => {
    const onCommand = (e: Event) => {
      lastCommand.current = performance.now();
      if ((e as CustomEvent<{ name: string }>).detail?.name === "stop") stop();
    };
    window.addEventListener("arc:command", onCommand);
    return () => window.removeEventListener("arc:command", onCommand);
  }, []);

  const runGemini = (ask: Ask, name: string, args: Args) => {
    if (ask.ran) return; // never run a command twice
    ask.ran = true;
    dispatch(name, args);
    time(ask, `gemini command "${name}" dispatched`);
  };

  // Snap was not sure, or it is a question: run Gemini's command if it sent one, else play its reply.
  const toGemini = (ask: Ask) => {
    if (ask.owner || current.current !== ask) return;
    ask.owner = "gemini";
    const c = ask.held.shift();
    if (c) return runGemini(ask, c.name, c.args);
    console.info(`[arc-timing] ${ask.id} gemini audio played`);
    void playAnswer(ask.id);
  };

  const hooks = (ask: Ask): AskHooks => ({
    first: () => {
      if (ask.gemini != null) return;
      ask.gemini = performance.now();
      time(ask, "gemini first audio or command");
    },
    command: (name, args) => {
      if (ask.owner === "gemini") runGemini(ask, name, args);
      else if (!ask.owner) ask.held.push({ name, args });
    },
    heard: async (text) => {
      time(ask, "heard");
      setLine(`Heard "${text}"`);
      if (!text.trim()) return toGemini(ask);
      let d;
      try {
        d = await submitUtterance(text, { quiet: true });
      } catch {
        setLine(`Heard "${text}" · Snap failed · Gemini answers`);
        return toGemini(ask);
      }
      time(ask, `snap decided (${Math.round(d.ms)} ms in Snap)`);
      // A "none" Snap is unsure of (below its 0.6 act threshold) is unclear speech: Gemini asks what was meant.
      const gemini = !d.act && !(d.action === "none" && d.confidence >= 0.6);
      setLine(`Heard "${text}" · ${describe(d)}${gemini ? " · Gemini answers" : ""}`);
      if (gemini) return toGemini(ask);
      ask.owner = "snap";
      dropAnswer(ask.id);
      console.info(`[arc-timing] ${ask.id} gemini reply dropped`);
      if (d.act && lastCommand.current >= ask.t0) time(ask, "cursor command dispatched", lastCommand.current);
    },
  });

  const begin = (source: Mic = startMic) => {
    if (mic.current) return;
    speaker.cancel(); // both voices stop at once: askStart stops the Live voice
    const ask: Ask = { id: "", t0: performance.now(), held: [], ran: false };
    ask.id = askStart(hooks(ask));
    current.current = ask;
    setLine("");
    void chime();
    const close = source(askAudio).catch((err) => {
      console.warn("[ask] microphone", err);
      setState("error");
      return undefined;
    });
    mic.current = { ask, close };
    setState("listening");
  };

  const end = async () => {
    const m = mic.current;
    if (!m) return;
    mic.current = undefined;
    (await m.close)?.();
    m.ask.t0 = performance.now();
    askEnd();
    setState((s) => (s === "error" ? s : "idle"));
    void chime();
  };

  // Test only, on localhost: the same begin/end path with prepared 16 kHz PCM16 chunks instead of the microphone.
  useEffect(() => {
    if (location.hostname !== "localhost") return;
    (window as unknown as { __arcTest?: object }).__arcTest = {
      audioState,
      say,
      ask: async (chunks: string[]) => {
        begin(async (onChunk) => {
          chunks.forEach(onChunk);
          return () => {};
        });
        await end();
      },
    };
  });

  const label =
    state === "listening"
      ? "Listening. Release Space, or press again, to send."
      : state === "error"
        ? "Ask: microphone blocked. Allow it and try again."
        : "Ask a question. Hold Space to talk.";

  return (
    <div className="ask">
      <button
        type="button"
        aria-pressed={state === "listening"}
        onKeyDown={(e) => {
          if (e.key === " ") {
            e.preventDefault();
            if (!e.repeat) begin();
          } else if (e.key === "Escape" && mic.current) {
            e.preventDefault();
            void end();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === " ") {
            e.preventDefault(); // no click from Space
            void end();
          }
        }}
        onClick={() => {
          if (mic.current) void end();
          else begin();
        }}
      >
        {label}
      </button>
      <p className="decision">{line}</p>
    </div>
  );
}
