"use client";
// Guided spoken tour of one figure. Keys live on one focusable role="application" region; the same actions are also
// buttons, folded into one closed <details> so a screen reader user meets one stop, not eight.
import { useCallback, useEffect, useRef, useState } from "react";
import { pitch, pointLine, reading, seriesOfStop, stats, valueAt, xAtPointer } from "@/lib/chart";
import { hitStop, nearestHint, stopLine } from "@/lib/cues";
import type { TwinNode } from "@/lib/types";
import { chime, getSpeed, prefetch, say, setSpeed, stop, tick, togglePause, tone } from "@/lib/client/voice";

const SHOW = new Set(["hand-fixed", "high"]);
const POINTER_HINT = "You can also move your pointer over the picture to feel where each part is.";
const CHART_HINT = "Move your pointer across the chart to hear its shape, or hold Shift with the arrow keys to step through values.";

export default function FigureTour({ node, onLeave }: { node: TwinNode; onLeave: () => void }) {
  const tour = node.tour!;
  const stops = tour.stops;
  const chart = tour.chart;
  const hint = chart ? CHART_HINT : POINTER_HINT;
  const base = `${tour.overview} ${stops.length} stops. Press Right Arrow to begin.`;
  const intro = `${base} ${hint}`;
  const [i, setI] = useState(-1); // -1: overview
  const [speed, setSpeedState] = useState(getSpeed());
  const [paused, setPaused] = useState(false);
  const run = useRef(0);
  const pad = useRef<HTMLDivElement>(null);
  // Chart scrubbing: when the last tone played, the point Shift+Arrow is on, and the reading last spoken (shown on screen too).
  const toned = useRef(0);
  const pt = useRef(-1);
  const [readout, setReadout] = useState("");
  // Pointer exploration: the latest pointer position, the rAF handle, whether it is inside the image, the stop under it,
  // the one rest timer (full line, or direction hint), and which run token is speaking (a hint never talks over a line).
  const img = useRef<HTMLImageElement>(null);
  const aim = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef(0);
  const within = useRef(false);
  const over = useRef(-1);
  const rest = useRef(0);
  const talking = useRef(0);
  const hinting = useRef(0);

  const line = useCallback((k: number) => (k < 0 ? intro : stopLine(stops, k)), [intro, stops]);

  const speak = useCallback(
    async (k: number, withChime: boolean) => {
      const my = ++run.current;
      talking.current = my;
      stop();
      if (k + 1 < stops.length) prefetch(line(k + 1)); // buffer the next stop while this one plays
      if (withChime && k >= 0) {
        await chime();
        if (my !== run.current) return;
      }
      await say(line(k));
      if (talking.current === my) talking.current = 0;
    },
    [line, stops.length],
  );

  useEffect(() => {
    const r = run;
    pad.current?.focus();
    speak(-1, false);
    return () => {
      r.current++;
      stop();
    };
  }, [speak]);

  // Short labels are fetched up front so entering a part by pointer answers at once. After the speak effect: its stop() would cancel them.
  useEffect(() => {
    stops.forEach((s) => prefetch(s.label));
    return () => {
      cancelAnimationFrame(frame.current);
      clearTimeout(rest.current);
    };
  }, [stops]);

  const go = (k: number) => {
    const n = Math.max(0, Math.min(stops.length - 1, k));
    setI(n);
    setPaused(false);
    pt.current = -1;
    setReadout("");
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
  // Spoken and typed commands drive the tour while it is open; "stop" only silences it.
  const latest = useRef(actions);
  useEffect(() => {
    latest.current = actions;
  });
  useEffect(() => {
    const onCommand = (e: Event) => {
      const name = (e as CustomEvent<{ name: string }>).detail?.name;
      if (name === "next" || name === "prev") latest.current[name]();
      else if (name === "read") latest.current.repeat();
      else if (name === "stop") {
        run.current++;
        stop();
        setPaused(false);
      }
    };
    window.addEventListener("arc:command", onCommand);
    return () => window.removeEventListener("arc:command", onCommand);
  }, []);

  // Touch exploration: entering a part chimes and speaks its label; resting 700 ms speaks the full line; resting in empty
  // space for 1.2 s says where the nearest part is. Edges of the picture get a quiet tick.
  const explore = () => {
    frame.current = 0;
    const p = aim.current;
    const r = img.current?.getBoundingClientRect();
    const x = p && r ? ((p.x - r.left) / r.width) * 1000 : -1;
    const y = p && r ? ((p.y - r.top) / r.height) * 1000 : -1;
    const inside = x >= 0 && x <= 1000 && y >= 0 && y <= 1000;
    if (inside !== within.current) {
      within.current = inside;
      tick(inside ? 330 : 220);
    }
    const xv = chart && inside ? xAtPointer(chart, x, y) : null;
    if (chart && xv !== null) return scrub(xv);
    const k = inside ? hitStop(stops, y, x) : -1;
    if (k >= 0 && k === over.current) return; // resting in the same part keeps its timer
    clearTimeout(rest.current);
    if (hinting.current === run.current && talking.current === run.current) {
      run.current++; // moving again cancels the direction hint
      stop();
    }
    over.current = k;
    if (k < 0) {
      if (inside) hintLater(y, x, 1200);
      return;
    }
    const my = ++run.current;
    talking.current = my;
    stop();
    setI(k);
    setPaused(false);
    const s = stops[k];
    const t0 = performance.now();
    (async () => {
      await chime();
      if (my !== run.current) return;
      await say(s.label);
      if (my !== run.current) return;
      talking.current = 0;
      rest.current = window.setTimeout(() => {
        if (my !== run.current) return;
        talking.current = my;
        say(`${s.label}. ${s.says}`).then(() => {
          if (talking.current === my) talking.current = 0;
        });
      }, Math.max(0, 700 - (performance.now() - t0)));
    })();
  };
  // Inside a chart's plot area the horizontal position is the x value: a quiet tone whose pitch follows the active series
  // (the series stop the student is on, else the first), and after 600 ms at rest the values there in words.
  const scrub = (xv: number) => {
    clearTimeout(rest.current);
    over.current = -1;
    if (talking.current) {
      run.current++; // moving cancels whatever was being said
      stop();
      talking.current = 0;
    }
    const si = seriesOfStop(chart!, stops[i]);
    const s = chart!.series[si];
    const now = performance.now();
    if (s && now - toned.current >= 83) {
      toned.current = now;
      const st = stats(s.points);
      tone(pitch(valueAt(s.points, xv), st.min.y, st.max.y));
    }
    const my = run.current;
    rest.current = window.setTimeout(() => {
      if (my !== run.current) return;
      const n = ++run.current;
      talking.current = n;
      const text = reading(chart!, xv, si);
      setReadout(text);
      say(text).then(() => {
        if (talking.current === n) talking.current = 0;
      });
    }, 600);
  };
  // Shift+Right/Left step through the active series' points, Home/End jump to its ends: a tone, then the value in words.
  const step = (key: string) => {
    const si = seriesOfStop(chart!, stops[i]);
    const s = chart!.series[si];
    if (!s) return;
    const last = s.points.length - 1;
    const k = key === "Home" ? 0 : key === "End" ? last : Math.max(0, Math.min(last, pt.current < 0 ? 0 : pt.current + (key === "ArrowRight" ? 1 : -1)));
    pt.current = k;
    const st = stats(s.points);
    tone(pitch(s.points[k].y, st.min.y, st.max.y), 120);
    const text = pointLine(chart!, si, k);
    setReadout(text);
    const my = ++run.current;
    talking.current = my;
    window.setTimeout(() => {
      if (my !== run.current) return;
      say(text).then(() => {
        if (talking.current === my) talking.current = 0;
      });
    }, 150);
  };
  const hintLater = (y: number, x: number, ms: number) => {
    const my = run.current;
    rest.current = window.setTimeout(() => {
      if (my !== run.current) return;
      if (talking.current === my) return hintLater(y, x, 600); // never talk over a line
      const n = ++run.current;
      talking.current = hinting.current = n;
      say(nearestHint(stops, y, x)).then(() => {
        if (talking.current === n) talking.current = 0;
      });
    }, ms);
  };
  const track = (e: React.PointerEvent) => {
    const out = e.type === "pointerleave";
    if (out && e.pointerType === "touch") return; // a lifted finger is not leaving the picture
    if (e.type === "pointerdown") over.current = -1; // touching the same part again chimes again
    aim.current = out ? null : { x: e.clientX, y: e.clientY };
    frame.current ||= requestAnimationFrame(explore);
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
    // Enter and Space on a button or the summary inside the details keep their own meaning.
    if ((e.key === "Enter" || e.key === " ") && e.target !== pad.current) return;
    if (chart && ((e.shiftKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) || e.key === "Home" || e.key === "End")) {
      e.preventDefault();
      stop();
      setPaused(false);
      return step(e.key);
    }
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
    <section aria-label={`Figure tour: ${tour.title}`} onKeyDown={onKeyDown}>
      <div
        onPointerMove={track}
        onPointerDown={track}
        onPointerLeave={track}
        onMouseDown={(e) => e.preventDefault()} // a click on the picture must not move focus off the tour keys
        style={{ position: "relative", lineHeight: 0, touchAction: "none" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- remote figure URLs, sized by the page */}
        <img ref={img} draggable={false} src={src} alt={node.image?.alt ?? tour.title} style={{ width: "100%", height: "auto" }} />
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
          base
        )}
        {readout && (
          <>
            <br />
            <span data-readout>{readout}</span>
          </>
        )}
      </p>
      <small>{hint}</small>

      <div
        ref={pad}
        tabIndex={0}
        role="application"
        aria-label={`Figure tour keys. Right and Left Arrow: next and previous stop. Enter: repeat. Up and Down Arrow: speed. P: pause. Escape: leave.${
          chart ? " Shift with Right or Left Arrow: step through the values of the current series. Home and End: first and last value." : ""
        }`}
      >
        Tour keys are on. Speed {speed}x{paused ? ", paused" : ""}.
      </div>

      <details>
        <summary>Buttons for these controls</summary>
        <div>
          <button onClick={actions.prev}>Previous</button>
          <button onClick={actions.next}>Next</button>
          <button onClick={actions.repeat}>Repeat</button>
          <button onClick={actions.slower}>Slower</button>
          <button onClick={actions.faster}>Faster</button>
          <span>Speed {speed}x</span>
          <button onClick={actions.pause}>{paused ? "Resume" : "Pause"}</button>
          <button onClick={actions.leave}>Leave tour</button>
        </div>
      </details>
    </section>
  );
}
