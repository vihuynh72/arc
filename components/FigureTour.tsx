"use client";
// Guided spoken tour of one figure. Keys live on one focusable role="application" region; the same actions are also
// buttons, folded into one closed <details> so a screen reader user meets one stop, not eight.
import { useCallback, useEffect, useRef, useState } from "react";
import { pitch, pointLine, reading, seriesOfStop, stats, valueAt, xAtPointer } from "@/lib/chart";
import { boxDistance, correction, guideTick, hitStop, keepGoing, nearestHint, nextLine, stopLine, towards } from "@/lib/cues";
import type { Tour, TwinNode } from "@/lib/types";
import { chime, getTourSpeed, prefetch, say, setTourSpeed, setTouring, stop, tick, togglePause, tone } from "@/lib/client/voice";

const SHOW = new Set(["hand-fixed", "high"]);
const POINTER_HINT = "You can also move your pointer over the picture: I will guide you to each part.";
const ARRIVED = "Right here.";
const clock = () => performance.now(); // guidance timing, read only in handlers and timers
const beat = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CHART_HINT = "Move your pointer across the chart to hear its shape, or hold Shift with the arrow keys to step through values.";
const STILL_READING = "I am still reading the exact values. You can explore the layout now.";
const VALUES_READY = "The values are ready. Hold Shift with the arrow keys to step through them, or move your pointer across the chart.";

export default function FigureTour({ node, onLeave }: { node: TwinNode; onLeave: () => void }) {
  // A chart's quick tour (stage "quick") is swapped for the data-built one when it arrives, without moving the student.
  const [tour, setTour] = useState<Tour>(node.tour!);
  const stops = tour.stops;
  const chart = tour.chart;
  const hint = chart ? CHART_HINT : POINTER_HINT;
  const base = `${tour.overview} ${stops.length} stops. Press Right Arrow to begin.`;
  const intro = `${base} ${tour.stage === "quick" ? STILL_READING : hint}`;
  const [i, setI] = useState(-1); // -1: overview
  const [speed, setSpeedState] = useState(getTourSpeed());
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
  // Guided seeking (pictures, not charts): the stop the pointer is being talked onto, whether the pointer has been used in
  // this tour, the pointer in picture units, the arrived stop whose box swallows movement while it is explained (and when
  // that ends after leaving it), when a stop's own line started (no ticks over its first second), the tick timer, the last
  // distance and since when it has grown, the last spoken correction, which run token is guidance speech, and pause.
  const goal = useRef(0);
  const guided = useRef(false);
  const here = useRef<{ x: number; y: number } | null>(null);
  const stuck = useRef(-1);
  const loose = useRef(0);
  const lineAt = useRef(-1e9);
  const pace = useRef({ timer: 0, last: -1e9, due: 0 });
  const trend = useRef({ d: -1, away: 0 });
  const said = useRef(-1e9);
  const guiding = useRef(0);
  const still = useRef(false);

  const line = useCallback((k: number) => (k < 0 ? intro : stopLine(stops, k)), [intro, stops]);
  const body = useCallback((k: number) => `${stops[k].label}. ${stops[k].says}`, [stops]);

  // `lead` ("Right here.") replaces the stop's movement cue on a pointer arrival. Once the pointer has been used, a stop ends
  // with the way to the next one, said only after the stop's own line.
  const speak = useCallback(
    async (k: number, withChime: boolean, lead = "") => {
      const my = ++run.current;
      talking.current = my;
      stop();
      lineAt.current = performance.now();
      if (k + 1 < stops.length) prefetch(guided.current ? body(k + 1) : line(k + 1)); // buffer the next stop while this one plays
      if (withChime && k >= 0) {
        await chime();
        if (my !== run.current) return;
      }
      if (lead) {
        await say(lead);
        await beat(250); // a short beat after "Right here."
        if (my !== run.current) return;
      }
      lineAt.current = performance.now();
      await say(lead ? body(k) : line(k));
      if (talking.current === my) talking.current = 0;
      if (my !== run.current) return;
      stuck.current = -1; // explained: guidance toward the next stop may start where the pointer is
      if (k < 0 || !guided.current) return;
      await beat(600); // let the line settle before the way on
      if (my !== run.current) return;
      talking.current = guiding.current = my;
      said.current = performance.now() + 1000; // the way on is not cut by a correction straight away
      await say(nextLine(stops, k + 1, here.current));
      if (talking.current === my) talking.current = 0;
    },
    [body, line, stops],
  );

  // The intro is spoken once on open; swapping in the full tour must not restart it or cut a sentence.
  const opening = useRef(speak);
  useEffect(() => {
    const r = run;
    pad.current?.focus();
    setTouring(true);
    opening.current(-1, false);
    return () => {
      r.current++;
      stop();
      setTouring(false);
    };
  }, []);

  // Build this figure next (the queue may be busy with others), and for a quick chart tour wait for the full one.
  const at = useRef({ i, stops });
  useEffect(() => {
    at.current = { i, stops };
  });
  useEffect(() => {
    const image = node.image?.url;
    if (!image) return;
    void fetch("/api/tour/prioritise", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image }) }).catch(() => null);
    if (node.tour?.stage !== "quick") return;
    let live = true;
    let timer = 0;
    const started = Date.now();
    const poll = async () => {
      const res = await fetch(`/api/tour?image=${encodeURIComponent(image)}&want=full`).catch(() => null);
      if (!live) return;
      if (res?.status === 200) {
        const full = (await res.json().catch(() => null)) as Tour | null;
        if (!live || !full?.stops?.length) return;
        // Same stop by label if it exists, else the same index clamped; the overview (-1) stays the overview.
        const { i: k, stops: old } = at.current;
        if (k >= 0) {
          const same = full.stops.findIndex((s) => s.label === old[k]?.label);
          setI(same >= 0 ? same : Math.min(k, full.stops.length - 1));
        }
        setTour(full);
        // Announce once, after whatever is being said now has finished.
        const announce = () => {
          if (!live) return;
          if (talking.current) return void (timer = window.setTimeout(announce, 300));
          const n = ++run.current;
          talking.current = n;
          say(VALUES_READY).then(() => {
            if (talking.current === n) talking.current = 0;
          });
        };
        announce();
        return;
      }
      // 202: still reading. Anything else (failed, offline) or 90 s: keep the quick tour and say nothing more.
      if (res?.status === 202 && Date.now() - started < 90_000) timer = window.setTimeout(poll, 2000);
    };
    timer = window.setTimeout(poll, 2000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [node.image?.url, node.tour?.stage]);

  // Short labels are fetched up front so entering a part by pointer answers at once. After the speak effect: its stop() would cancel them.
  useEffect(() => {
    stops.forEach((s) => prefetch(s.label));
    if (!chart) prefetch(ARRIVED);
    const b = pace.current;
    return () => {
      cancelAnimationFrame(frame.current);
      clearTimeout(rest.current);
      clearTimeout(b.timer);
    };
  }, [stops, chart]);
  useEffect(() => {
    still.current = paused;
  }, [paused]);

  const go = (k: number) => {
    const n = Math.max(0, Math.min(stops.length - 1, k));
    goal.current = n + 1; // the stop after this one is what the pointer is guided to
    stuck.current = -1;
    clearTimeout(rest.current);
    setI(n);
    setPaused(false);
    pt.current = -1;
    setReadout("");
    speak(n, true);
  };
  const sayRate = (v: number) => {
    setSpeedState(v);
    const n = ++run.current;
    talking.current = n;
    say(`Speed ${v}.`).then(() => {
      if (talking.current === n) talking.current = 0;
    });
  };
  const actions = {
    next: () => go(i + 1),
    prev: () => go(i < 0 ? 0 : i - 1),
    repeat: () => {
      setPaused(false);
      speak(i, false);
    },
    faster: () => sayRate(setTourSpeed(speed + 0.25)),
    slower: () => sayRate(setTourSpeed(speed - 0.25)),
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
        stuck.current = -1;
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
    // Charts keep their own exploration (scrubbing and the stop under the pointer); guided seeking is for pictures.
    here.current = inside ? { x, y } : null;
    if (!chart && inside && !guided.current) {
      guided.current = true;
      if (stops[goal.current]) prefetch(body(goal.current)); // the first arrival answers without waiting for the voice
    }
    if (!chart && guided.current && goal.current < stops.length) return guide(x, y, inside);
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
  // Guided seeking: ticks that quicken and rise as the pointer nears the next stop, a word when it drifts away or rests, and
  // on entering the stop a chime, "Right here.", its line, then the way on. Other stops passed on the way stay quiet.
  const guide = (x: number, y: number, inside: boolean) => {
    const now = clock();
    clearTimeout(rest.current);
    if (!inside) {
      stopBeat();
      trend.current = { d: -1, away: 0 };
      return;
    }
    const s = stuck.current;
    if (s >= 0) {
      // Just arrived: small movements inside the box, and the first 250 ms outside it, change nothing.
      if (boxDistance(stops[s].box_2d, y, x) === 0) return void (loose.current = 0);
      if (!loose.current) {
        loose.current = now + 250;
        window.setTimeout(() => (frame.current ||= requestAnimationFrame(explore)), 260);
      }
      if (now < loose.current) return;
      stuck.current = -1;
      loose.current = 0;
    }
    const g = goal.current;
    const target = stops[g];
    const d = boxDistance(target.box_2d, y, x);
    if (d === 0) return arrive(g);
    beatAt(d);
    const tr = trend.current;
    if (tr.d >= 0 && towards(tr.d, d)) tr.away = 0; // any move toward the target cancels a pending correction
    else if (tr.d >= 0 && d > tr.d + 1) {
      tr.away ||= now;
      if (now - tr.away > 700 && sayGuide(correction(target.box_2d, y, x))) tr.away = now;
    }
    tr.d = d;
    const k = hitStop(stops, y, x);
    const later = (text: () => string, ms: number) => {
      rest.current = window.setTimeout(() => {
        if (!sayGuide(text())) later(text, 600); // a stop's line or a recent correction: try again shortly
      }, ms);
    };
    if (k >= 0 && k !== g) later(() => `${stops[k].label.charAt(0).toUpperCase()}${stops[k].label.slice(1)}. ${nextLine(stops, g, { x, y })}`, 700);
    else later(() => keepGoing(target.box_2d, y, x), 1200);
  };
  const arrive = (k: number) => {
    stopBeat();
    clearTimeout(rest.current);
    goal.current = k + 1;
    trend.current = { d: -1, away: 0 };
    setI(k);
    setPaused(false);
    pt.current = -1;
    setReadout("");
    speak(k, true, ARRIVED).catch(() => null);
    stuck.current = k; // after speak: it runs synchronously up to the chime
    loose.current = 0;
  };
  // One soft tick per beat; the gap and pitch follow the distance at each beat, and moving closer brings the next one forward.
  const pulse = () => {
    const b = pace.current;
    b.timer = 0;
    const p = here.current;
    const target = stops[goal.current];
    if (!p || !target || stuck.current >= 0 || still.current) return;
    const d = boxDistance(target.box_2d, p.y, p.x);
    if (d === 0) return;
    const { ms, hz } = guideTick(d);
    const now = clock();
    // Not over a stop's own line (its first second at least, and the whole of these short lines): words first.
    if (now - lineAt.current >= 1000 && !(talking.current && talking.current !== guiding.current)) tick(hz, 30, 0.02);
    b.last = now;
    b.due = now + ms;
    b.timer = window.setTimeout(pulse, ms);
  };
  const beatAt = (d: number) => {
    const b = pace.current;
    const due = Math.max(b.last + guideTick(d).ms, clock());
    if (b.timer && due >= b.due) return;
    clearTimeout(b.timer);
    b.due = due;
    b.timer = window.setTimeout(pulse, due - clock());
  };
  const stopBeat = () => {
    clearTimeout(pace.current.timer);
    pace.current.timer = 0;
  };
  // Guidance speech: at most one phrase per 1.5 s, never over a stop's own line, never while paused.
  const sayGuide = (text: string) => {
    const now = clock();
    if (still.current || now - said.current < 1500 || (talking.current && talking.current !== guiding.current)) return false;
    said.current = now;
    const n = ++run.current;
    talking.current = guiding.current = n;
    say(text).then(() => {
      if (talking.current === n) talking.current = 0;
    });
    return true;
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
