"use client";
// Push-to-talk, mounted once in the page header. Hold Space anywhere outside a text field, or click to start and click
// again to stop. Escape stops both voices everywhere. Snap decides first ("Gemini should wrap around Snap"): when Snap is
// sure the command runs at once and Gemini's reply is dropped; otherwise Gemini answers, asks what was meant, or its command runs.
// Speed: the browser's own speech recognition runs while the key is held. Its words are pre-asked to Snap once stable,
// and on release a sure decision acts without waiting for Gemini Live's transcript ("heard").
// Kokoro reading the node where the cursor lands is the confirmation, so this control speaks none of its own.
import { useEffect, useRef, useState } from "react";
import { startMic } from "@/lib/client/audio";
import { act, describe, preDecide, submitUtterance } from "@/lib/client/command";
import { prefetchClip, speaker } from "@/lib/client/reader";
import { askAudio, askEnd, askStart, audioState, chime, dropAnswer, playAnswer, say, stop, type AskHooks } from "@/lib/client/voice";

const GREETING = "Arc. Hold Space and tell me what to study, or paste a link.";
const STABLE_MS = 350; // interim words unchanged this long are pre-asked to Snap
const TAP_MS = 200; // a Space tap shorter than this is not a question: nothing is sent to Gemini

type Args = Record<string, unknown>;
type Mic = (onChunk: (b64: string) => void) => Promise<() => void>;
interface Ask {
  id: string;
  t0: number; // key release
  owner?: "snap" | "gemini"; // who handles this ask; the other is ignored
  held: { name: string; args: Args }[]; // Gemini commands waiting for Snap's decision
  ran: boolean;
  gemini?: number;
  words: string; // browser transcript so far, final plus interim
  early?: Promise<void>; // the decision on the browser transcript; "heard" waits for it
  rec?: { stop(): void; abort(): void };
}

// Minimal shape of the browser's SpeechRecognition (input only; output never uses speechSynthesis).
interface Rec {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

const dispatch = (name: string, args: Args) => window.dispatchEvent(new CustomEvent("arc:command", { detail: { name, args } }));
const time = (ask: Ask, what: string, at = performance.now()) => console.info(`[arc-timing] ${ask.id} ${what} ${Math.round(at - ask.t0)} ms after release`);
const typing = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable='true']");

export default function AskButton() {
  const [state, setState] = useState<"idle" | "listening" | "error">("idle");
  const [line, setLine] = useState("");
  const mic = useRef<{ ask: Ask; close: Promise<(() => void) | undefined> } | undefined>(undefined);
  const current = useRef<Ask | undefined>(undefined);
  const lastCommand = useRef(0);
  const greeted = useRef(false);

  useEffect(() => prefetchClip(GREETING), []);

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

  // Snap is sure: act now, drop Gemini's reply.
  const toSnap = (ask: Ask, why: string) => {
    ask.owner = "snap";
    dropAnswer(ask.id);
    console.info(`[arc-timing] ${ask.id} gemini reply dropped (${why})`);
    if (lastCommand.current >= ask.t0) time(ask, "cursor command dispatched", lastCommand.current);
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
      time(ask, "live heard");
      await ask.early;
      if (ask.owner) return; // the early transcript already decided this ask
      setLine(`Heard "${text}"`);
      if (!text.trim()) return toGemini(ask);
      let d;
      try {
        d = await submitUtterance(text, { quiet: true });
      } catch {
        setLine(`Heard "${text}" · Snap failed · Gemini answers`);
        return toGemini(ask);
      }
      if (ask.owner) return;
      time(ask, `snap decided on live transcript (${Math.round(d.ms)} ms in Snap)`);
      // A "none" Snap is unsure of (below its 0.6 act threshold) is unclear speech: Gemini asks what was meant.
      const gemini = !d.act && !(d.action === "none" && d.confidence >= 0.6);
      setLine(`Heard "${text}" · ${describe(d)}${gemini ? " · Gemini answers" : ""}`);
      if (gemini) return toGemini(ask);
      toSnap(ask, "live transcript");
    },
  });

  // Browser speech recognition while the key is held. Missing or failing, it simply yields no words.
  const listen = (ask: Ask) => {
    const W = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
    const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!Ctor) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const rec = new Ctor();
      rec.lang = "en-US";
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (e) => {
        ask.words = Array.from(e.results, (r) => r[0]?.transcript ?? "").join(" ").replace(/\s+/g, " ").trim();
        clearTimeout(timer);
        const w = ask.words;
        if (w) timer = setTimeout(() => mic.current?.ask === ask && void preDecide(w).catch(() => {}), STABLE_MS);
      };
      rec.onerror = () => {};
      rec.start();
      ask.rec = rec;
    } catch {
      // recognition unavailable: the Live path runs unchanged
    }
  };

  const begin = (source: Mic = startMic) => {
    if (mic.current) return;
    speaker.cancel(); // both voices stop at once: askStart stops the Live voice
    const ask: Ask = { id: "", t0: performance.now(), held: [], ran: false, words: "" };
    ask.id = askStart(hooks(ask));
    current.current = ask;
    setLine("");
    void chime();
    if (source === startMic) listen(ask);
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
    setState((s) => (s === "error" ? s : "idle")); // at once: a pending microphone prompt must not leave it "Listening"
    const ask = m.ask;
    const words = ask.words; // taken at release; later results are ignored
    const tap = performance.now() - ask.t0 < TAP_MS && !words;
    if (tap) ask.owner = "snap"; // nobody answers a tap: "heard" and Gemini's reply are ignored
    ask.rec?.[tap ? "abort" : "stop"]();
    (await m.close)?.();
    ask.t0 = performance.now();
    askEnd();
    if (tap) dropAnswer(ask.id);
    void chime();
    if (!words) return;
    time(ask, `browser transcript "${words}"`);
    ask.early = preDecide(words).then(
      (d) => {
        time(ask, `snap decided on browser transcript (${Math.round(d.ms)} ms in Snap, ${d.action}, act ${d.act})`);
        if (ask.owner || !d.act) return; // not sure: Live's transcript decides, as before
        setLine(`Heard "${words}" · ${describe(d)}`);
        act(d);
        toSnap(ask, "browser transcript");
      },
      () => {},
    );
  };

  // Hold Space anywhere outside a text field; Escape stops both voices everywhere. Capture phase, so a focused
  // button never also gets the Space click.
  useEffect(() => {
    const greet = (e: Event) => {
      if (greeted.current) return;
      greeted.current = true; // browsers allow audio only after a gesture: the first one is it
      // Not over a request (Space, typing in the box) and not when the first key is Escape ("be quiet").
      const quiet = e instanceof KeyboardEvent && (e.key === " " || e.key === "Escape");
      if (!quiet && !typing(e.target)) void speaker.say([GREETING]);
    };
    const down = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        speaker.cancel();
        stop();
        if (mic.current) void end();
      } else if (e.key === " " && !typing(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (!e.repeat) begin();
      }
      greet(e);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key !== " " || !mic.current || typing(e.target)) return;
      e.preventDefault(); // no click from Space
      void end();
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("pointerdown", greet, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("pointerdown", greet, true);
    };
  });

  // Test only, on localhost: the same begin/end path with prepared 16 kHz PCM16 chunks instead of the microphone.
  // words stands in for the browser transcript; holdMs keeps the key "held" that long after the words arrive (pre-ask).
  useEffect(() => {
    if (location.hostname !== "localhost") return;
    (window as unknown as { __arcTest?: object }).__arcTest = {
      audioState,
      say,
      ask: async (chunks: string[], words = "", holdMs = 0) => {
        begin(async (onChunk) => {
          chunks.forEach(onChunk);
          return () => {};
        });
        const ask = mic.current!.ask;
        if (words && holdMs > STABLE_MS) {
          ask.words = words;
          setTimeout(() => void preDecide(words).catch(() => {}), STABLE_MS);
        }
        if (holdMs) await new Promise((r) => setTimeout(r, holdMs));
        ask.words = words;
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
