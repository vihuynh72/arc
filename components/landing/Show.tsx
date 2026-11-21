"use client";
// A self-playing sequence of short scenes for the landing (components/Landing.tsx): the stage on which TODAY and ARC
// (components/landing/scenes.tsx) are played. A beat timer moves React state; everything that moves is CSS on transform and opacity.
// For the students Arc is for, the stage is decoration: aria-hidden and inert, silent, never focused, never scrolled, never announced.
// The controls outside it are plain buttons. It runs only while on screen in a visible tab, stops when the visitor asks Arc for
// anything, and under reduced motion (the system's, or Arc's own Display option) it shows still frames stepped by hand.
import { useEffect, useRef, useState } from "react";
import { submitUtterance } from "@/lib/client/command";
import { rove } from "./rove";
import { shown, type Line, type Scene, type You } from "./scenes";

type Go = { at: number; b: number; was: number[]; key: number[] };

const stillFrom = (s: Scene, b: number) => {
  const i = s.beats.findIndex((x, j) => j >= b && x.still);
  return i < 0 ? s.beats.length - 1 : i;
};

const Words = ({ text, pace }: { text: string; pace: number }) =>
  text.split(" ").map((w, i, all) => (
    <span key={i} className="lx-w" style={{ animationDelay: `${i * pace}ms` }}>
      {w}
      {i + 1 < all.length && " "}
    </span>
  ));

function Did({ you, held }: { you: You; held: boolean }) {
  return (
    <>
      {you.keys?.map((k) => (
        <kbd key={k} data-held={held || undefined}>
          {k}
        </kbd>
      ))}
      {you.say && <q>{you.done ? you.say : <Words text={you.say} pace={220} />}</q>}
      {you.does && <span>{you.does}</span>}
    </>
  );
}

function Said({ line }: { line: Line }) {
  return (
    <>
      {line.tone && (
        <i className="lx-tone">
          <i />
        </i>
      )}
      {line.cue && <em>({line.cue}) </em>}
      {line.text && <Words text={line.text} pace={70} />}
    </>
  );
}

export default function Show({ scenes, label, voice, bar }: { scenes: Scene[]; label: string; voice: string; bar?: boolean }) {
  const [g, setG] = useState<Go>({ at: 0, b: 0, was: scenes.map(() => 0), key: scenes.map(() => 0) });
  const [playing, setPlaying] = useState(true); // the visitor's own choice
  const [live, setLive] = useState(false); // on screen, in a visible tab
  const [calm, setCalm] = useState(false); // reduced motion: stills only
  const [keyed, setKeyed] = useState(false); // keyboard focus is on a control...
  const [over, setOver] = useState(false); // ...or the pointer is: the scene plays to its end and waits there, so no label changes under a hand
  const held = keyed || over;
  const hover = { onPointerEnter: () => setOver(true), onPointerLeave: () => setOver(false) };
  const stage = useRef<HTMLDivElement>(null);
  const run = playing && live && !calm;
  const scene = scenes[g.at];
  const s = shown(scene, g.b);

  // Another scene: the one left keeps its last frame while it fades, the one entered is mounted fresh.
  const to = (x: Go, at: number, b: number): Go =>
    at === x.at ? { ...x, b } : { at, b, was: x.was.map((n, i) => (i === x.at ? x.b : n)), key: x.key.map((n, i) => (i === at ? n + 1 : n)) };
  const settle = (x: Go) => to(x, x.at, stillFrom(scenes[x.at], x.b));

  useEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    let seen = false;
    const sync = () => {
      const quiet = mq.matches || root.dataset.motion === "reduce";
      setCalm(quiet);
      setLive(seen && !document.hidden);
      if (quiet) setG(settle);
    };
    const io = new IntersectionObserver(([e]) => ((seen = e.isIntersecting), sync()), { threshold: 0.5 });
    io.observe(stage.current!);
    const mo = new MutationObserver(sync);
    mo.observe(root, { attributes: true, attributeFilter: ["data-motion"] });
    const stop = () => (setPlaying(false), setG(settle)); // the visitor asked Arc for something: the show is over
    document.addEventListener("visibilitychange", sync);
    mq.addEventListener("change", sync);
    window.addEventListener("arc:command", stop);
    return () => {
      io.disconnect();
      mo.disconnect();
      document.removeEventListener("visibilitychange", sync);
      mq.removeEventListener("change", sync);
      window.removeEventListener("arc:command", stop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mounted once; settle only reads the scenes it was given
  }, []);

  useEffect(() => {
    if (!run) return;
    const last = g.b + 1 === scene.beats.length;
    if (last && held) return;
    const id = setTimeout(() => setG((x) => to(x, last ? (x.at + 1) % scenes.length : x.at, last ? 0 : x.b + 1)), scene.beats[g.b].ms);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one timer per beat
  }, [run, held, g]);

  /** One still frame back or on, across scenes; stepping always pauses. */
  const step = (d: 1 | -1) => {
    setPlaying(false);
    setG((x) => {
      const all = scenes.flatMap((sc, i) => sc.beats.flatMap((beat, j) => (beat.still ? [[i, j]] : [])));
      const k = all.findIndex(([i, j]) => i > x.at || (i === x.at && j >= x.b));
      const cur = k < 0 ? all.length : k;
      const here = all[cur]?.[0] === x.at && all[cur]?.[1] === x.b;
      const [i, j] = all[(d > 0 ? (here ? cur + 1 : cur) : cur - 1 + all.length) % all.length];
      return to(x, i, j);
    });
  };

  /** The real thing behind the scene: the same load the ask box does, then (once the page is there) one typed-style request. */
  const open = () => {
    const o = scene.open!;
    window.dispatchEvent(new CustomEvent("arc:command", { detail: { name: "load", args: { url: o.url } } }));
    const root = document.getElementById("content");
    if (!o.then || !root) return;
    const off = () => {
      clearTimeout(t);
      mo.disconnect();
      window.removeEventListener("keydown", off, true);
      window.removeEventListener("pointerdown", off, true);
    };
    // The page is on screen once what the request needs is in it; half a second more and the page's own keys and commands are listening.
    const mo = new MutationObserver(() => {
      if (!root.querySelector(o.need!)) return;
      off();
      t = window.setTimeout(() => void submitUtterance(o.then!), 500);
    });
    let t = window.setTimeout(off, 60_000);
    mo.observe(root, { childList: true, subtree: true });
    window.addEventListener("keydown", off, true); // the visitor did something else first: leave them to it
    window.addEventListener("pointerdown", off, true);
  };

  return (
    <div
      className="lx"
      data-run={run || undefined}
      data-calm={calm || undefined}
      onFocus={(e) => setKeyed(e.target.matches(":focus-visible"))}
      onBlur={() => setKeyed(false)}
    >
      <div className="lx-rail" {...hover}>
        <div className="lx-list" role="toolbar" aria-label={label} aria-orientation="vertical" onKeyDown={rove}>
          {scenes.map((sc, i) => (
            <button key={sc.id} type="button" aria-label={`${sc.name}: ${sc.what}`} aria-pressed={i === g.at} tabIndex={i === g.at ? 0 : -1} onClick={() => setG((x) => to(x, i, run ? 0 : stillFrom(sc, 0)))}>
              <span>{sc.name}</span>
              <small>{sc.what}</small>
            </button>
          ))}
        </div>
        <i className="lx-band" aria-hidden="true" style={{ transform: `translateY(${g.at * 100}%)` }}>
          <i style={{ transform: `scaleX(${g.b ? (g.b + (run ? 1 : 0)) / scene.beats.length : 0})`, transitionDuration: `${!g.b ? 0 : run ? scene.beats[g.b].ms : 200}ms` }} />
        </i>
      </div>

      <div ref={stage} className="lx-stage" aria-hidden="true" inert>
        {bar && (
          <div className="lx-bar" data-ask={s.ask || undefined}>
            <b>Arc</b>
            <span className="lx-ask">
              <span key={s.ask + s.typed}>{s.ask === "listening" ? "Listening…" : s.ask === "thinking" ? "Thinking…" : s.typed && <Words text={s.typed} pace={260} />}</span>
              <i className="lx-mic">
                <svg viewBox="0 0 24 24" focusable="false">
                  <rect x="9" y="3" width="6" height="11" rx="3" />
                  <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
                </svg>
              </i>
            </span>
          </div>
        )}
        <div className="lx-view">
          {scenes.map((sc, i) => (
            <div key={`${sc.id}:${g.key[i]}`} className="lx-scene" data-scene={sc.id} data-on={i === g.at ? "" : undefined}>
              <sc.View s={i === g.at ? s : shown(sc, g.was[i])} />
            </div>
          ))}
        </div>
        <div className="lx-lanes">
          <div>
            <b>You</b>
            <span key={`${g.at}:${s.youAt}`}>{s.you && <Did you={s.you} held={s.ask === "listening"} />}</span>
          </div>
          <div>
            <b>{s.arc?.who ?? voice}</b>
            <span key={`${g.at}:${s.arcAt}`}>{s.arc && <Said line={s.arc} />}</span>
          </div>
        </div>
      </div>

      <div className="lx-ctl" {...hover}>
        {!calm && (
          <button type="button" aria-label={`${playing ? "Pause" : "Play"}: ${label}`} onClick={() => (setPlaying(!playing), setG(settle))}>
            {playing ? "Pause" : "Play"}
          </button>
        )}
        <button type="button" className="lx-step" aria-label={`Step back: ${label}`} onClick={() => step(-1)}>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M14.5 6l-6 6 6 6" />
          </svg>
        </button>
        <button type="button" className="lx-step" aria-label={`Step on: ${label}`} onClick={() => step(1)}>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M9.5 6l6 6-6 6" />
          </svg>
        </button>
        {scene.open ? (
          <>
            <button type="button" className="lx-try" onClick={open}>
              Try it: {scene.open.label.replace(/^./, (c) => c.toLowerCase())}
            </button>
            <span className="lx-note">{scene.open.next}</span>
          </>
        ) : (
          <span className="lx-note">{scene.source}</span>
        )}
      </div>
    </div>
  );
}
