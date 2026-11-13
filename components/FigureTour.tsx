"use client";
// Guided spoken tour of one figure. Keys live in one role="application" bar; every key is also a button.
import { useCallback, useEffect, useRef, useState } from "react";
import { stopLine } from "@/lib/cues";
import type { TwinNode } from "@/lib/types";
import { chime, getSpeed, prefetch, say, setSpeed, stop, togglePause } from "@/lib/client/voice";

const SHOW = new Set(["hand-fixed", "high"]);

export default function FigureTour({ node, onLeave }: { node: TwinNode; onLeave: () => void }) {
  const tour = node.tour!;
  const stops = tour.stops;
  const intro = `${tour.overview} ${stops.length} stops. Press Right Arrow to begin.`;
  const [i, setI] = useState(-1); // -1: overview
  const [speed, setSpeedState] = useState(getSpeed());
  const [paused, setPaused] = useState(false);
  const run = useRef(0);
  const first = useRef<HTMLButtonElement>(null);

  const line = useCallback((k: number) => (k < 0 ? intro : stopLine(stops, k)), [intro, stops]);

  const speak = useCallback(
    async (k: number, withChime: boolean) => {
      const my = ++run.current;
      stop();
      if (k + 1 < stops.length) prefetch(line(k + 1)); // buffer the next stop while this one plays
      if (withChime && k >= 0) {
        await chime();
        if (my !== run.current) return;
      }
      await say(line(k));
    },
    [line, stops.length],
  );

  useEffect(() => {
    const r = run;
    first.current?.focus();
    speak(-1, false);
    return () => {
      r.current++;
      stop();
    };
  }, [speak]);

  const go = (k: number) => {
    const n = Math.max(0, Math.min(stops.length - 1, k));
    setI(n);
    setPaused(false);
    speak(n, true);
  };
  const actions = {
    next: () => go(i + 1),
    prev: () => go(i < 0 ? 0 : i - 1),
    repeat: () => {
      setPaused(false);
      speak(i, false);
    },
    faster: () => setSpeedState(setSpeed(speed + 0.25)),
    slower: () => setSpeedState(setSpeed(speed - 0.25)),
    pause: () => setPaused(togglePause()),
    leave: () => {
      run.current++;
      stop();
      onLeave();
    },
  };
  const keys: Record<string, keyof typeof actions> = {
    ArrowRight: "next",
    ArrowLeft: "prev",
    Enter: "repeat",
    ArrowUp: "faster",
    ArrowDown: "slower",
    p: "pause",
    P: "pause",
    Escape: "leave",
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const a = keys[e.key];
    if (a !== "pause" && e.key !== "Tab" && e.key !== " ") {
      run.current++; // any key cancels current audio at once
      stop();
      setPaused(false);
    }
    if (!a) return;
    e.preventDefault(); // Enter must not also click the focused button
    actions[a]();
  };

  const cur = i >= 0 ? stops[i] : undefined;
  const box = cur && SHOW.has(cur.confidence) ? cur.box_2d : undefined;
  const src = tour.image ?? node.image?.url;

  return (
    <section aria-label={`Figure tour: ${tour.title}`}>
      <div style={{ position: "relative", lineHeight: 0 }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- remote figure URLs, sized by the page */}
        <img src={src} alt={node.image?.alt ?? tour.title} style={{ width: "100%", height: "auto" }} />
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            top: `${(box?.[0] ?? 500) / 10}%`,
            left: `${(box?.[1] ?? 500) / 10}%`,
            height: `${box ? (box[2] - box[0]) / 10 : 0}%`,
            width: `${box ? (box[3] - box[1]) / 10 : 0}%`,
            opacity: box ? 1 : 0,
            border: "4px solid var(--ring)",
            borderRadius: 10,
            boxShadow: "0 0 0 4px rgba(255,255,255,.8), 0 0 18px var(--ring)",
            transition: "top .7s ease, left .7s ease, width .7s ease, height .7s ease, opacity .3s",
            pointerEvents: "none",
          }}
        />
      </div>

      <p>
        {cur ? (
          <>
            <strong>
              Stop {i + 1} of {stops.length}: {cur.label}.
            </strong>{" "}
            {cur.says}
          </>
        ) : (
          intro
        )}
      </p>

      <div
        role="application"
        aria-label="Figure tour. Right and Left Arrow move between stops, Enter repeats, Up and Down change speed, P pauses, Escape leaves."
        onKeyDown={onKeyDown}
        style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}
      >
        <button onClick={actions.prev}>Previous</button>
        <button ref={first} onClick={actions.next}>
          Next
        </button>
        <button onClick={actions.repeat}>Repeat</button>
        <button onClick={actions.slower}>Slower</button>
        <button onClick={actions.faster}>Faster</button>
        <span style={{ fontSize: "0.9rem" }}>Speed {speed}x</span>
        <button onClick={actions.pause}>{paused ? "Resume" : "Pause"}</button>
        <button onClick={actions.leave}>Leave tour</button>
      </div>
    </section>
  );
}
