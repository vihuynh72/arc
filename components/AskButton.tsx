"use client";
// Push-to-talk, mounted once in the page header. Hold Space anywhere outside a text field (or in the empty box), or
// press the backquote key once to start and again to send (anywhere, even in a box with text), or click to start and
// click again to stop. Escape stops both voices everywhere. Decision decides first ("Gemini should wrap around the decision step"): when Decision is
// sure the command runs at once and Gemini's reply is dropped; otherwise Gemini answers, asks what was meant, or its command runs.
// Speed: the relay sends Gemini's transcript about 0.2 s after release, and the local grammar or Decision acts on it.
// Early words (Gemini's interim transcription, while the key is held) only warm Decision: nothing is ever run from a
// partial transcript or while the key is down (lib/client/hearing.ts mayDispatch), because a fragment ("Go", "Move", "Next")
// can be the start of the opposite command.
// Kokoro reading the node where the cursor lands is the confirmation, so this control speaks none of its own.
import { useEffect, useRef, useState } from "react";
import { cutTail, startMic, type MicStats } from "@/lib/client/audio";
import { afterAnswer, answerAgain, currentCtx, describe, geminiCommand, geminiDown, notUnderstoodLine, preDecide, primeQuestion, submitUtterance, turnNow, unavailableLine, watchTurn } from "@/lib/client/command";
import { HEARD_NOTHING, LOST_LINE, mayDispatch, norm, NOT_CAUGHT, ONE_MOMENT, TOO_QUIET } from "@/lib/client/hearing";
import { mumbled, resolveLocal } from "@/lib/intent";
import { prefetchClip, speaker, startWaitTone } from "@/lib/client/reader";
import { answering, answerSounded, answerText, askAudio, askEnd, askResult, askStart, audioState, budgetOf, budgetSeen, chime, dropAnswer, playAnswer, say, stop, stopAnswer, type AskHooks } from "@/lib/client/voice";

import { GREETING, NOTHING_PLAYING } from "@/lib/keys";
const EMPTY_BOX = "Type a link or a question, or hold Space and talk.";
// With the model refused, nothing transcribes speech (Live does): say so, and what still works.
const NO_EARS = "I can't understand speech right now, because Arc's listening service is unavailable. Press slash, type what you want, and press Enter.";
const STABLE_MS = 350; // interim words unchanged this long are pre-asked to Decision
const TAP_MS = 300; // a Space tap shorter than this is an accident: nothing is said, nothing is sent on
const TOGGLE_MS = 12_000; // backquote listening sends itself after this (no silence detection here)
const MAX_HOLD_MS = 20_000; // a held key that never reports its release (focus lost, stuck key) ends itself
const HEARD_MS = 4000; // after release the transcript normally arrives in under 0.5 s; this long without one is a failure
const MIN_SPEECH_MS = 120; // less than this above the room's noise is silence
const WORKING_MS = 1500; // nothing said this long after release: a soft working sound
const MOMENT_MS = 4000; // and this long: "One moment." once
const UNSURE = 0.4; // a Decision below this, for anything but a question, is speech that was not caught

type Args = Record<string, unknown>;
type Mic = (onChunk: (b64: string) => void) => Promise<(now?: boolean) => void | MicStats | undefined | Promise<void | MicStats | undefined>>;
interface Ask {
  id: string;
  t0: number; // key release
  owner?: "snap" | "gemini"; // who handles this ask; the other is ignored
  held: { name: string; args: Args }[]; // Gemini commands waiting for Decision's decision
  ran: boolean;
  gemini?: number;
  words: string; // early transcript so far (Gemini's interim transcription): only ever used to warm Decision
  released: boolean; // the key is up
  heard: boolean; // the relay sent the transcript
  broken: boolean; // the relay or Live dropped while this ask was open: the request is not whole
  heardText: string; // what the live transcript said (empty: nothing)
  discard: boolean; // a tap, silence or a lost ask: no later reading of it may run
  watch?: ReturnType<typeof setTimeout>; // nothing came back after release
  cap?: ReturnType<typeof setTimeout>; // MAX_HOLD_MS
  quiet?: () => void; // ends the working sound and the "One moment." timer
}

const dispatch = (name: string, args: Args) => window.dispatchEvent(new CustomEvent("arc:command", { detail: { name, args } }));
const time = (ask: Ask, what: string, at = performance.now()) => console.info(`[arc-timing] ${ask.id} ${what} ${Math.round(at - ask.t0)} ms after release`);
// An open dialog (the Display panel) also keeps Space for its own controls.
const typing = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable='true'], dialog");
// A focused control that Space activates (a button, link, summary, radio): Space clicks it, as everywhere; the microphone itself still talks.
const control = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("button:not(.mic), a[href], summary, input[type='radio'], input[type='checkbox']");
// Only the start page greets; a page opened by a link speaks its own first line.
const onLanding = () => !!document.querySelector(".landing") && !/[?&](url|q|doc|receive)=/.test(location.search);
// The one box with nothing typed in it: Space there talks too (focus often sits in the box).
const emptyBox = (t: EventTarget | null) => (t as HTMLInputElement | null)?.id === "command" && !(t as HTMLInputElement).value.trim();
const backquote = (e: KeyboardEvent) => (e.code === "Backquote" || e.key === "`") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;

export default function AskButton() {
  const [state, setState] = useState<"idle" | "listening" | "error">("idle");
  const [line, setLine] = useState("");
  const mic = useRef<{ ask: Ask; close: Promise<((now?: boolean) => void | MicStats | undefined | Promise<void | MicStats | undefined>) | undefined> } | undefined>(undefined);
  const current = useRef<Ask | undefined>(undefined);
  const lastCommand = useRef(0);
  const greeted = useRef(false);
  const nothingSaid = useRef(false); // "Nothing is playing." has been said (once a visit)
  const toggled = useRef<ReturnType<typeof setTimeout> | undefined>(undefined); // set while backquote listening runs
  const spaceDown = useRef(false); // the key is physically down (a press that waits for the last ask's tail can still be a tap)
  const ending = useRef<Promise<void> | undefined>(undefined); // the last ask's release is still finishing (its mic tail)
  const starting = useRef(false);

  // The greeting as soon as the start page is ready, where the browser lets a page sound before any gesture. A refused clip never
  // starts (lib/client/reader.ts skips it), so "greeted" is set only when its sound really began; until then the first gesture greets.
  useEffect(() => {
    prefetchClip(GREETING);
    const began = (e: Event) => {
      const d = (e as CustomEvent<{ kind: string; text?: string; phase?: string }>).detail;
      if (d?.kind === "speech" && d.phase === "start" && d.text === GREETING) greeted.current = true;
    };
    window.addEventListener("arc:heard", began);
    const t = setTimeout(() => onLanding() && !greeted.current && !speaker.busy && void speaker.say([GREETING]), 400);
    return () => {
      clearTimeout(t);
      window.removeEventListener("arc:heard", began);
    };
  }, []);

  useEffect(() => {
    const onCommand = (e: Event) => {
      lastCommand.current = performance.now();
      if ((e as CustomEvent<{ name: string }>).detail?.name === "stop") stop();
    };
    let warned = false;
    const onQuiet = () => {
      if (warned) return; // once per page: a quiet room is not news twice
      warned = true;
      void speaker.say([TOO_QUIET]);
    };
    window.addEventListener("arc:command", onCommand);
    window.addEventListener("arc:quiet", onQuiet);
    return () => {
      window.removeEventListener("arc:command", onCommand);
      window.removeEventListener("arc:quiet", onQuiet);
    };
  }, []);

  // A short line, because a blind student cannot read the "Heard" line. Audio only (never an aria-live region).
  const tell = (ask: Ask, line: string) => {
    if (current.current !== ask) return;
    ask.owner = "snap";
    dropAnswer(ask.id);
    void speaker.say([line]);
  };

  const runGemini = (ask: Ask, name: string, args: Args) => {
    if (ask.ran) return; // never run a command twice
    ask.ran = true;
    const c = geminiCommand(name, args);
    dispatch(c.name, c.args);
    time(ask, `gemini command "${name}" dispatched`);
  };

  // Decision was not sure, or it is a question: run Gemini's command if it sent one, else play its reply.
  const toGemini = (ask: Ask) => {
    if (ask.owner || current.current !== ask) return;
    if (geminiDown() && !ask.held.length) {
      // The question service refused lately: answer at once, in plain words, instead of waiting for its recorded refusal.
      ask.owner = "snap";
      askResult({ id: ask.id, decided: { source: "unavailable" } });
      dropAnswer(ask.id);
      return void speaker.say([unavailableLine()]);
    }
    ask.owner = "gemini";
    primeQuestion(ask.heardText); // before askResult: the words are known now, so the page parts that hold the answer go with it
    const c = ask.held.shift();
    if (c) {
      askResult({ id: ask.id, decided: { source: "gemini", action: c.name } });
      return runGemini(ask, c.name, c.args);
    }
    askResult({ id: ask.id, decided: { source: "gemini", action: "answer" } });
    console.info(`[arc-timing] ${ask.id} gemini audio played`);
    if (speaker.busy && speaker.recent.at(-1)?.text === ONE_MOMENT) speaker.cancel(); // the answer is here: never two voices
    const mine = turnNow();
    watchTurn(() => turnNow() !== mine && stopAnswer(ask.id)); // the student started something else: this answer is not played over it
    const played = playAnswer(ask.id);
    // The spoken answer, also as static text for a sighted helper (the decision line is not aria-live).
    void answerText(ask.id, 15000).then(async (a) => {
      time(ask, `answer ${a == null ? "failed" : a.trim() ? `ended: "${a.slice(0, 60)}"` : "came back empty"}`);
      if (current.current !== ask || turnNow() !== mine) return;
      afterAnswer(a, played, mine);
      if (budgetOf(ask.id)) return void speaker.say([unavailableLine()]);
      if (a?.trim()) return setLine((l) => `${l} · Gemini: "${a}"`);
      if (ask.ran || (a != null && answerSounded(ask.id))) return; // a command ran, or the answer was heard without its words
      // Failed, silent or empty: the same question once more, as text (the typed path), else one honest line.
      await played;
      if (current.current === ask && turnNow() === mine) void answerAgain(ask.heardText, mine);
    });
  };

  // Decision is sure: act now, drop Gemini's reply.
  const toSnap = (ask: Ask, why: string) => {
    ask.owner = "snap";
    ask.quiet?.(); // decided here: its own line or reading follows at once (or, for "stop", silence)
    askResult({ id: ask.id, decided: { source: why } });
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
    partial: (text) => {
      if (mic.current?.ask !== ask || !text.trim()) return;
      if (!ask.words) time(ask, `first gemini partial "${text}"`);
      early(ask, text);
    },
    failed: () => {
      if (ask.owner || ask.broken || current.current !== ask) return;
      ask.broken = true;
      console.warn(`[arc-timing] ${ask.id} relay dropped during the ask`);
      if (ask.released) tell(ask, LOST_LINE); // while the key is held the line waits for the release
    },
    command: (name, args) => {
      if (ask.owner === "gemini") runGemini(ask, name, args);
      else if (!ask.owner) ask.held.push({ name, args });
    },
    heard: async (text: string, alternatives?: string[]) => {
      time(ask, "live heard");
      clearTimeout(ask.watch);
      ask.heard = true;
      ask.heardText = text.trim();
      if (ask.owner || !mayDispatch("final", ask.released)) return; // taps, lost asks, and a transcript sent before release
      setLine(`Heard "${text}"`);
      if (!text.trim()) {
        askResult({ id: ask.id, decided: { source: "nothing heard" } });
        // The relay answers a refused ask with an empty transcript and its recorded refusal (lib/server/live.ts).
        return tell(ask, Date.now() - budgetSeen() < 3000 ? NO_EARS : HEARD_NOTHING);
      }
      let d;
      try {
        d = await submitUtterance(text, { quiet: true, alternatives }); // the local grammar first (0 ms), then Decision
      } catch {
        setLine(`Heard "${text}" · Decision failed · Gemini answers`);
        return toGemini(ask);
      }
      if (ask.owner) return;
      time(ask, `decision decided on live transcript (${Math.round(d.ms)} ms in the decision step)`);
      // A "none" Decision is unsure of (below its 0.6 act threshold) is unclear speech: Gemini asks what was meant.
      // Noise, or a Decision that is nearly a guess: asked for again, never echoed back.
      if (!d.act && (mumbled(text) || (d.confidence < UNSURE && d.action !== "question"))) {
        setLine(`Heard "${text}" · ${describe(d)} · not caught`);
        askResult({ id: ask.id, decided: { source: "not caught", action: d.action, confidence: d.confidence } });
        return tell(ask, NOT_CAUGHT);
      }
      const gemini = !d.act && !(d.action === "none" && d.confidence >= 0.6);
      setLine(`Heard "${text}" · ${describe(d)}${gemini ? " · Gemini answers" : ""}`);
      if (gemini) return toGemini(ask);
      if (!d.act) void speaker.say([notUnderstoodLine(text)]); // nothing happens: what could be said here instead
      toSnap(ask, "live transcript");
    },
    revised: (text, alternatives) => {
      time(ask, `context reading revised to "${text}"`);
      // The stronger reading arrives 1 to 2 s after release. It may rescue a request the live transcript got wrong, never one
      // that was a tap, silence or a lost connection, and never one the live transcript heard nothing of (a model asked to
      // transcribe silence can invent a command).
      if (ask.discard || !ask.heardText || ask.ran || lastCommand.current >= ask.t0 || current.current !== ask) return;
      // Once the answer has begun (its first sound came), only the student's next action may stop it. The same words: nothing.
      const begun = () => ask.gemini != null || answerSounded(ask.id);
      if (begun() || norm(text) === norm(ask.heardText)) return void time(ask, "revision ignored (answer begun, or same words)");
      // A dry look first: nothing runs, and the turn is not moved (that stopped the answer), unless the revision is a sure command.
      const local = resolveLocal(text, currentCtx());
      const sure = local ? local.name !== "none" : preDecide(text).then((d) => d.act, () => false);
      void Promise.resolve(sure).then((ok) => {
        if (!ok || begun() || current.current !== ask || ask.ran || lastCommand.current >= ask.t0) return;
        return submitUtterance(text, { quiet: true, alternatives }).then((d) => {
          if (!d.act || current.current !== ask) return;
          time(ask, "revision acted: the question back is dropped");
          stopAnswer(ask.id); // only this ask's own reply, which had not begun
          setLine(`Heard "${text}" · ${describe(d)} · revised`);
          askResult({ id: ask.id, decided: { source: "context revised", action: d.action, target: d.target, confidence: d.confidence, act: d.act } });
        });
      }).catch(() => {});
    },
  });

  // After release, while nothing has been said: a soft working sound after 1.5 s, "One moment." once after 4 s, the sound again
  // until the first words (or 25 s). Any speech, a new ask, or a decision made here ends it.
  const spokeAt = useRef(0);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ kind: string; phase?: string; text?: string; name?: string }>).detail;
      if ((d?.kind === "speech" && d.phase === "start" && d.text !== ONE_MOMENT) || (d?.kind === "sound" && d.name === "chime")) spokeAt.current = performance.now();
    };
    window.addEventListener("arc:heard", on);
    prefetchClip(ONE_MOMENT);
    prefetchClip(NOT_CAUGHT);
    return () => window.removeEventListener("arc:heard", on);
  }, []);
  const working = (ask: Ask) => {
    const t0 = performance.now();
    let tone = () => {};
    const timers: ReturnType<typeof setTimeout>[] = [];
    const end = () => {
      timers.forEach(clearTimeout);
      clearInterval(poll);
      tone();
      tone = () => {};
      if (ask.quiet === end) ask.quiet = undefined;
    };
    ask.quiet = end;
    const waiting = () => current.current === ask && !mic.current && spokeAt.current < t0;
    const sound = () => void (waiting() && (tone = startWaitTone()));
    timers.push(setTimeout(sound, WORKING_MS));
    timers.push(
      setTimeout(() => {
        if (!waiting()) return end();
        tone();
        tone = () => {};
        console.info(`[arc-timing] ${ask.id} nothing said ${MOMENT_MS} ms after release: "One moment."`);
        void speaker.say([ONE_MOMENT]).then(() => sound());
      }, MOMENT_MS),
    );
    timers.push(setTimeout(end, 25_000));
    const poll = setInterval(() => void (!waiting() && performance.now() - t0 > 300 && end()), 150);
  };

  // New early words while the key is held: pre-ask Decision once they stay unchanged for STABLE_MS. Never acts.
  const timers = useRef(new Map<Ask, ReturnType<typeof setTimeout>>());
  const early = (ask: Ask, text: string) => {
    const w = text.replace(/\s+/g, " ").trim();
    if (w === ask.words) return;
    ask.words = w;
    clearTimeout(timers.current.get(ask));
    if (w) timers.current.set(ask, setTimeout(() => mic.current?.ask === ask && void preDecide(w).catch(() => {}), STABLE_MS));
  };

  const finish = async () => {
    const m = mic.current;
    if (!m) return;
    mic.current = undefined;
    clearTimeout(toggled.current);
    toggled.current = undefined;
    setState((s) => (s === "error" ? s : "idle")); // at once: a pending microphone prompt must not leave it "Listening"
    const ask = m.ask;
    clearTimeout(ask.cap);
    clearTimeout(timers.current.get(ask));
    timers.current.delete(ask);
    ask.released = true;
    // A tap is an accident: nothing is sent on, said or chimed. Early words mean it was speech after all.
    const tap = performance.now() - ask.t0 < TAP_MS && !ask.words;
    if (tap) ask.owner = "snap";
    ask.discard = tap;
    const stats = (await (await m.close)?.(tap)) || undefined; // the microphone keeps sending up to 250 ms after release
    ask.t0 = performance.now();
    askEnd(ask.id);
    if (tap) return dropAnswer(ask.id);
    void chime("listening-off");
    if (ask.broken) return (ask.discard = true), tell(ask, LOST_LINE);
    if (stats && stats.speechMs < MIN_SPEECH_MS) {
      // Nothing above the room's noise: no need to wait for a transcript.
      time(ask, `no speech (${Math.round(stats.speechMs)} ms above the noise, ${Math.round(stats.db)} dBFS)`);
      ask.discard = true;
      return tell(ask, HEARD_NOTHING);
    }
    if (ask.words) time(ask, `released with early words "${ask.words}": nothing runs from them, the final transcript decides`);
    working(ask);
    ask.watch = setTimeout(() => {
      if (ask.heard || ask.owner) return;
      time(ask, "no transcript came back");
      tell(ask, ask.broken ? LOST_LINE : NOT_CAUGHT);
    }, HEARD_MS);
  };

  const end = () => {
    const run = finish();
    ending.current = run;
    void run.finally(() => ending.current === run && (ending.current = undefined));
    return run;
  };

  const open = (source: Mic) => {
    speaker.cancel(); // both voices stop at once: askStart stops the Live voice
    current.current?.quiet?.();
    const ask: Ask = { id: "", t0: performance.now(), held: [], ran: false, words: "", released: false, heard: false, broken: false, heardText: "", discard: false };
    ask.id = askStart(hooks(ask));
    current.current = ask;
    setLine("");
    // On a lecture a tap of Space is play or pause: the listening tone waits until the key is clearly held.
    if (document.querySelector("iframe[src*='youtube']")) setTimeout(() => current.current === ask && !ask.released && void chime("listening-on"), TAP_MS);
    else void chime("listening-on");
    ask.cap = setTimeout(() => mic.current?.ask === ask && void end(), MAX_HOLD_MS);
    const close = source(askAudio).catch((err) => {
      console.warn("[ask] microphone", err);
      setState("error");
      return undefined;
    });
    mic.current = { ask, close };
    setState("listening");
  };

  // Two asks back to back: the first one's microphone tail is cut short and its end is sent before the second starts, so
  // the second's first words never end the first and the first's end never closes the second. A press that was released
  // while waiting was a tap.
  const begin = (source: Mic = startMic, needHeld = false) => {
    if (mic.current || starting.current) return;
    if (!ending.current) return open(source);
    starting.current = true;
    cutTail();
    void ending.current.then(() => {
      starting.current = false;
      if (!mic.current && (!needHeld || spaceDown.current)) open(source);
    });
  };

  // Hold Space anywhere outside a text field; Escape stops both voices everywhere. Capture phase, so a focused
  // button never also gets the Space click.
  useEffect(() => {
    // The first key, click or touch on the start page, while the greeting has not been heard: it is the greeting, and only that
    // (browsers allow sound only after a gesture). Returns true when it took the event.
    const greet = (e: Event) => {
      if (greeted.current) return false;
      greeted.current = true;
      if (!onLanding()) return false; // a page is open: it has said its own first line
      if (e instanceof KeyboardEvent && ["Shift", "Control", "Alt", "Meta"].includes(e.key)) return (greeted.current = false); // the next key greets
      void speaker.say([GREETING]);
      e.preventDefault();
      e.stopImmediatePropagation();
      return true;
    };
    const down = (e: KeyboardEvent) => {
      if (greet(e)) return;
      // Enter on the empty box: CommandBox does nothing with it, so say what the box is for.
      // After this key's other listeners: the reader cancels speech on every key.
      if (e.key === "Enter" && emptyBox(e.target) && !e.repeat) setTimeout(() => void speaker.say([EMPTY_BOX]), 0);
      if (e.key === "Escape") {
        // Something playing: a silent stop. Nothing playing: say so, once (a tour, the video and a dialog have their own Escape).
        // A reading cut a moment ago (a Space tap) counts as playing.
        const idle = !speaker.busy && performance.now() - speaker.cutAt > 2000 && !answering() && !mic.current && !document.querySelector("[data-tour], iframe[src*='youtube'], dialog[open]");
        speaker.cancel();
        stop();
        if (mic.current) void end();
        if (idle && !nothingSaid.current && !typing(e.target)) {
          nothingSaid.current = true;
          void speaker.say([NOTHING_PLAYING]);
        }
      } else if (backquote(e)) {
        e.preventDefault(); // never types a backquote, in the box or anywhere
        if (e.repeat) return;
        if (mic.current) void end();
        else {
          begin();
          toggled.current = setTimeout(() => void end(), TOGGLE_MS);
        }
      } else if (e.key === " " && (!typing(e.target) || emptyBox(e.target)) && !control(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (!e.repeat) {
          spaceDown.current = true;
          begin(startMic, true);
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === " ") spaceDown.current = false;
      if (e.key !== " " || !mic.current || toggled.current || (typing(e.target) && !emptyBox(e.target))) return;
      e.preventDefault(); // no click from Space
      void end();
    };
    // The window lost focus while the key was down: its release will never arrive here.
    const lost = () => {
      spaceDown.current = false;
      if (mic.current && !toggled.current) void end();
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    const onPointer = (e: PointerEvent) => void greet(e);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("blur", lost);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("blur", lost);
    };
  });

  // Test only, on localhost: the same begin/end path with prepared 16 kHz PCM16 chunks instead of the microphone.
  // words stands in for early words; holdMs keeps the key "held" that long after the words arrive (pre-ask).
  useEffect(() => {
    if (location.hostname !== "localhost") return;
    (window as unknown as { __arcTest?: object }).__arcTest = {
      audioState,
      say,
      // Chunks are fed in real time (each one's own length), as a microphone would, so heard_partial timing is real.
      ask: async (chunks: string[], words = "", holdMs = 0) => {
        const ms = (b64: string) => (b64.length * 3) / 4 / 32; // 16 kHz PCM16: 32 bytes per ms
        let feeding = Promise.resolve();
        begin(async (onChunk) => {
          feeding = (async () => {
            const t = performance.now();
            let at = 0;
            for (const c of chunks) {
              await new Promise((r) => setTimeout(r, Math.max(0, t + at - performance.now())));
              onChunk(c);
              at += ms(c);
            }
          })();
          return () => {};
        });
        await new Promise((r) => setTimeout(r, 0));
        await feeding;
        const ask = mic.current!.ask;
        if (words) early(ask, words); // stand-in early words
        if (holdMs) await new Promise((r) => setTimeout(r, holdMs));
        await end();
      },
    };
  });

  // The microphone at the end of the one box (components/CommandBox.tsx). Press and hold talks until release; a short click
  // starts listening and the next click sends (for anyone who cannot hold). Keyboard: Space anywhere holds; Enter on it toggles.
  const held = useRef({ at: 0, stopOnUp: false });
  const label =
    state === "error"
      ? "Talk to Arc: the microphone is blocked. Allow it and try again."
      : "Talk to Arc. Hold Space anywhere, or press and hold this button.";

  return (
    <div className="ask">
      <button
        type="button"
        className="mic"
        aria-pressed={state === "listening"}
        aria-label={label}
        title={state === "listening" ? "Listening" : "Talk to Arc"}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault(); // focus stays where it is; a held press is not a click
          held.current = { at: performance.now(), stopOnUp: !!mic.current };
          if (!mic.current) begin();
        }}
        onPointerUp={() => {
          const h = held.current;
          if (!h.at) return;
          held.current = { at: 0, stopOnUp: false };
          if (h.stopOnUp || performance.now() - h.at >= 350) void end(); // a second click, or the end of a hold
        }}
        onPointerCancel={() => void (held.current.at && mic.current && end())}
        onClick={(e) => {
          if (e.detail !== 0) return; // a pointer press is handled above; this is Enter on the button
          if (mic.current) void end();
          else begin();
        }}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
          <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
          <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      <p className="decision">{line}</p>
    </div>
  );
}
