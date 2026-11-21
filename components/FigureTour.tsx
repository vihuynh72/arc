"use client";
// Guided spoken tour of one figure. It plays by itself (the pointer glides to each part, the ring follows, a chime, the line)
// until the student takes over: a move key, P, Space to ask, or their own pointer on the picture. Keys live on one focusable
// role="application" region; there are no buttons (keys and voice only).
import { useCallback, useEffect, useRef, useState } from "react";
import { pitch, pointLine, reading, seriesOfStop, stats, valueAt, xAtPointer } from "@/lib/chart";
import { boxDistance, correction, flat, guideTick, hitStop, keepGoing, nearestHint, nextLine, placed, stopLine, towards } from "@/lib/cues";
import type { Tour, TwinNode } from "@/lib/types";
import { speaker } from "@/lib/client/reader";
import { chime, getTourSpeed, prefetch, say, setTourSpeed, setTouring, stop, tick, tone } from "@/lib/client/voice";
import { inputStyle } from "@/lib/client/command";
import { realPointer } from "@/lib/client/pointer";
import { autoStep, cue, SPEED_KEYS, speedKey, tourEnd, tourSelf, tourStart, type Auto } from "@/lib/keys";

// The key named in a tour line, worded for how the student has been acting (by voice: "Say next to begin.").
const cueKeys = (line: string) => line.replace(/Press Right Arrow to (begin|carry on)\./, (__, what: string) => tourStart(inputStyle(), what));

const POINTER_HINT = "You can also move your pointer over the picture: I will guide you to each part.";
const hintsSaid = new Set<string>(); // a long hint is spoken in the first tour of a visit only; it stays on screen in every tour
let ownPace = false; // the student took over or paused a tour in this visit: the next one starts at their pace
// A stop's chime, unless one has just played with no words heard since (bare): never two chimes in a row.
let bare = false;
const ding = async () => {
  if (bare) return;
  bare = true;
  await chime();
};
const clock = () => performance.now(); // guidance timing, read only in handlers and timers
const beat = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STILL_MS = 900; // no guidance tick once the pointer has rested this long
const TOUR_UNKNOWN = "That key does nothing in the tour. P pauses, Escape leaves, question mark lists the keys.";
const TOUR_HELP = `Tour keys: Right or Down Arrow, next part. Left or Up Arrow, previous part. Enter repeats. P pauses, and plays the tour by itself again. ${SPEED_KEYS} changes speed. Escape leaves the tour.`;
const GLIDE_MS = 700; // the pointer and the ring travel to a stop in this long (app/globals.css .tour-pointer)
const NEXT_MS = 1500; // the self-running tour waits this long after a line
const PASS_MS = 150; // the pointer stays in a part this long before it is named: sweeping across parts makes no string of chimes
const pausedLine = () => cue(inputStyle(), "Paused. Say go on, or that's enough to leave.", "Paused. P goes on, Escape leaves.", "Paused. Say go on or press P; say that's enough or press Escape to leave.");
const leaveLine = () => cue(inputStyle(), "Say that's enough to leave.", "Escape leaves.", "Say that's enough, or press Escape, to leave.");
// The introduction's last clause at the student's own pace (they took over or paused in an earlier tour).
const paceLine = () =>
  cue(inputStyle(), "At your pace: say next for each part, or play it to have me go on by myself.", "At your pace: Right Arrow for each part, or P to play it by itself.", "At your pace: say next or press Right Arrow for each part; say play it or press P to play it by itself.");
// Parts the tour describes but cannot point to (no trusted place), said once in the introduction.
const NUM = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const num = (n: number) => NUM[n] ?? String(n);
const unplacedLine = (stops: Tour["stops"]) => {
  const n = stops.filter(placed).length;
  if (n === stops.length) return "";
  if (!n) return " I can't point to its parts on the picture; I will describe them.";
  return ` I can point to ${num(n)} of its ${num(stops.length)} parts; I will describe the other ${stops.length - n === 1 ? "one" : num(stops.length - n)}.`;
};
const CHART_HINT = "Move your pointer across the chart to hear its shape, or hold Shift with the arrow keys to step through values.";
const STILL_READING = "I am still reading the exact values.";
// The quick tour's stop count is about to change, so it is never said; the full tour's is said once, when it arrives.
const valuesReady = (n: number, begun: boolean) => `The values are ready. ${n} stops. Press Right Arrow to ${begun ? "carry on" : "begin"}.`;

export default function FigureTour({ node, onLeave }: { node: TwinNode; onLeave: () => void }) {
  // A chart's quick tour (stage "quick") is swapped for the data-built one when it arrives, without moving the student.
  const [tour, setTour] = useState<Tour>(node.tour!);
  const stops = tour.stops;
  const chart = tour.chart;
  const hint = chart ? CHART_HINT : POINTER_HINT;
  const quick = tour.stage === "quick";
  const base = quick ? (tour.overview.includes("still reading") ? tour.overview : `${tour.overview} ${STILL_READING}`) : `${tour.overview} ${stops.length} stops.`;
  const [spokenHint] = useState(() => {
    const h = inputStyle() === "voice" ? POINTER_HINT : hint;
    return hintsSaid.has(h) ? "" : h;
  });
  // The self-running tour: on, paused (P, Space, "hold on"), or off (the student goes at their own pace). A quick chart tour waits
  // for its values; a student who took over or paused an earlier tour in this visit starts at their own pace.
  const [start] = useState<Auto>(() => (quick || ownPace ? "off" : "on"));
  // How to leave, then how to pause (or go on) is the last clause before the first part.
  const intro = quick
    ? `${base} You can explore the layout now.`
    : `${base}${chart ? "" : unplacedLine(stops)}${spokenHint ? ` ${spokenHint}` : ""} ${leaveLine()} ${start === "on" ? tourSelf(inputStyle()) : paceLine()}`;
  const [i, setI] = useState(-1); // -1: overview
  const [speed, setSpeedState] = useState(getTourSpeed());
  const [paused, setPaused] = useState(false);
  const auto = useRef<Auto>(start);
  const [autoNow, setAutoNow] = useState<Auto>(start);
  const setAuto = (a: Auto) => void ((auto.current = a), setAutoNow(a));
  const [tip, setTip] = useState({ x: 500, y: 500 }); // where the drawn pointer points, in picture units: the last stop with a box shown
  const [byHand, setByHand] = useState(false); // the student's own pointer took over: the drawn one steps aside
  const real = useRef<ReturnType<typeof realPointer> | null>(null);
  const run = useRef(0);
  const pad = useRef<HTMLDivElement>(null);
  // Chart scrubbing: when the last tone played, the point Shift+Arrow is on, and the reading last spoken (shown on screen too).
  const toned = useRef(0);
  const pt = useRef(-1);
  const [readout, setReadout] = useState("");
  // Pointer exploration: the latest pointer position, the rAF handle, whether it is inside the image, the part under it,
  // the one rest timer (full line, or where to go), which run token is speaking, and where the pointer was when that line began
  // (moving well away from there cuts it: the student has moved on).
  const img = useRef<HTMLImageElement>(null);
  const aim = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef(0);
  const within = useRef(false);
  const over = useRef(-1);
  const rest = useRef(0);
  const talking = useRef(0);
  const anchor = useRef({ run: 0, x: 0, y: 0 });
  const told = useRef(new Set<number>()); // parts with no trusted place already said to be unplaceable
  // Guided seeking (pictures, not charts): the stop the pointer is being talked onto (the next one with a trusted place, see
  // goalOf), whether the pointer has been used in this tour, the pointer in picture units, when a stop's own line started (no
  // ticks over its first second), the tick timer, the last distance and since when it has grown, the last spoken correction,
  // which run token is guidance speech, and pause.
  const goal = useRef(0);
  const guided = useRef(false);
  const here = useRef<{ x: number; y: number } | null>(null);
  const lineAt = useRef(-1e9);
  const pace = useRef({ timer: 0, last: -1e9, due: 0 });
  const trend = useRef({ d: -1, away: 0 });
  const said = useRef(-1e9);
  const guiding = useRef(0);
  const still = useRef(false);
  const movedAt = useRef(0); // the pointer's last move: guidance ticks stop about a second after it goes still
  // The actions as of the last commit (set in an effect below, never during render): timers, the self-running tour and the
  // window listeners act through it on the current stop and stops. Declared before speak uses it.
  const latest = useRef<typeof actions>(null);

  const line = useCallback((k: number) => (k < 0 ? intro : stopLine(stops, k)), [intro, stops]);
  const body = useCallback((k: number) => `${stops[k].label}. ${stops[k].says}`, [stops]);

  // Charts: every part can be found by hand (their boxes come from the data). Pictures: only parts with a trusted place.
  const findable = (t: Tour["stops"][number]) => !!chart || placed(t);
  // The next part the pointer is guided to: from goal on, the first with a trusted place (the others are described, not found).
  const goalOf = () => {
    let g = goal.current;
    while (g < stops.length && !placed(stops[g])) g++;
    return g;
  };

  // A stop Arc moves to: its place on the picture and its line (stopLine). Once the pointer has been used, it ends with the way
  // to the next part, said only after the stop's own line.
  const speak = useCallback(
    async (k: number, withChime: boolean) => {
      const my = ++run.current;
      talking.current = my;
      stop();
      lineAt.current = performance.now();
      if (k + 1 < stops.length) prefetch(line(k + 1)); // buffer the next stop while this one plays
      if (withChime && k >= 0 && auto.current === "on" && placed(stops[k])) {
        await beat(GLIDE_MS); // the pointer and the ring arrive first
        if (my !== run.current) return;
      }
      if (withChime && k >= 0) {
        await ding();
        if (my !== run.current) return;
      }
      lineAt.current = performance.now();
      await say(line(k));
      if (talking.current === my) talking.current = 0;
      if (my !== run.current) return;
      if (auto.current === "on") {
        await beat(NEXT_MS);
        if (my !== run.current) return;
        const step = autoStep(auto.current, k, stops.length);
        if (step === "next") latest.current?.auto(k + 1);
        else if (step === "end") latest.current?.end();
        return;
      }
      if (k < 0 || !guided.current || chart) return;
      await beat(600); // let the line settle before the way on
      if (my !== run.current) return;
      talking.current = guiding.current = my;
      said.current = performance.now() + 1000; // the way on is not cut by a correction straight away
      await say(nextLine(stops, latest.current?.goalOf() ?? k + 1, here.current));
      if (talking.current === my) talking.current = 0;
    },
    [line, stops, chart],
  );

  // The intro is spoken once on open; swapping in the full tour must not restart it or cut a sentence.
  const opening = useRef(speak);
  useEffect(() => {
    const r = run;
    const rp = (real.current = realPointer(true)); // the real mouse pointer, only when the server and Display allow it (lib/client/pointer.ts)
    pad.current?.focus({ preventScroll: true });
    // The picture and its ring are the point of the tour: bring the picture just under the header (html has scroll-padding-top).
    requestAnimationFrame(() => img.current?.closest("[data-tour]")?.scrollIntoView({ block: "start", behavior: "smooth" }));
    setTouring(true);
    bare = false;
    // Words were heard: the next stop may chime again (lib/client/heard.ts).
    const words = (e: Event) => void ((e as CustomEvent<{ kind: string; phase?: string }>).detail?.phase === "start" && (bare = false));
    window.addEventListener("arc:heard", words);
    opening.current(-1, false);
    if (spokenHint) hintsSaid.add(spokenHint);
    return () => {
      r.current++;
      stop();
      setTouring(false);
      rp.stop();
      window.removeEventListener("arc:heard", words);
    };
  }, [spokenHint]); // fixed for the tour's life (its state is never set): runs once on open

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
        const count = full.stops.length;
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
          say(cueKeys(valuesReady(count, k >= 0))).then(() => {
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
    const b = placed(stops[n]) ? flat(stops[n].box_2d) : null; // no trusted place: no ring, and the pointer stays where it is
    if (b && !byHand) {
      const c = { x: (b[1] + b[3]) / 2, y: (b[0] + b[2]) / 2 };
      setTip(c);
      // After the new stop's line has laid out: the browser's scroll anchoring may shift the page (and the picture) when it does.
      const aim = () => {
        const r = img.current?.getBoundingClientRect();
        if (r) real.current?.to(r.left + (c.x / 1000) * r.width, r.top + (c.y / 1000) * r.height, GLIDE_MS);
      };
      requestAnimationFrame(() => requestAnimationFrame(aim));
    }
    goal.current = n + 1; // the stop after this one is what the pointer is guided to
    clearTimeout(rest.current);
    setI(n);
    setPaused(false);
    pt.current = -1;
    setReadout("");
    speak(n, true);
  };
  const sayRate = (v: number, dir: "Faster" | "Slower") => {
    setSpeedState(v);
    const n = ++run.current;
    talking.current = n;
    stop();
    say(v === speed ? `That is the ${dir === "Faster" ? "fastest" : "slowest"}: speed ${v}.` : `${dir}. Speed ${v}.`).then(() => {
      if (talking.current === n) talking.current = 0;
      if (n === run.current && auto.current === "on") speak(i, i >= 0); // the self-running tour carries on with the line the change cut
    });
  };
  // A move by the student: the rest of this tour goes at their pace, with no words about it; so does the next tour in this visit.
  const own = (f: () => void) => {
    if (auto.current !== "off") setAuto("off");
    ownPace = true;
    f();
  };
  // "Paused. Say go on." after a pause by voice or Space, and after P.
  const hold = () => {
    if (auto.current === "on") setAuto("paused");
    ownPace = true;
    const n = ++run.current;
    stop();
    setPaused(false);
    talking.current = n;
    say(pausedLine()).then(() => void (talking.current === n && (talking.current = 0)));
  };
  // P, "go on" or "play it": the self-running tour plays (again), from the next stop. From the student's own pace, it is their new taste.
  const resume = () => {
    if (auto.current === "off") ownPace = false;
    setAuto("on");
    if (i + 1 < stops.length) go(i + 1);
    else latest.current?.end();
  };
  const actions = {
    next: () => own(() => go(i + 1)),
    to: (k: number) => own(() => go(Math.min(k, stops.length - 1))),
    prev: () => own(() => go(i < 0 ? 0 : i - 1)),
    repeat: () =>
      own(() => {
        setPaused(false);
        speak(i, false);
      }),
    faster: () => sayRate(setTourSpeed(speed + 0.25), "Faster"),
    slower: () => sayRate(setTourSpeed(speed - 0.25), "Slower"),
    pause: () => (auto.current === "on" ? hold() : resume()), // at the student's own pace, P plays the tour by itself
    hold,
    resume,
    auto: (k: number) => go(k), // the self-running tour's own step: not the student's
    goalOf,
    end: () => {
      setAuto("off");
      const n = ++run.current;
      talking.current = n;
      say(tourEnd(inputStyle())).then(() => void (talking.current === n && (talking.current = 0)));
    },
    leave: () => {
      run.current++;
      stop();
      onLeave();
    },
  };
  // Spoken and typed commands drive the tour while it is open; "stop" only silences it.
  useEffect(() => {
    latest.current = actions;
  });
  useEffect(() => {
    const onCommand = (e: Event) => {
      const { name, args } = (e as CustomEvent<{ name: string; args?: { at?: number | "last"; steps?: number } }>).detail ?? {};
      if (name === "goto" && args?.at != null) latest.current?.to(args.at === "last" ? Infinity : Number(args.at)); // "the first stop", "skip to the end"
      else if (name === "next" || name === "prev" || name === "faster" || name === "slower") latest.current?.[name]();
      else if (name === "read") latest.current?.repeat();
      else if (name === "continue" || name === "play") latest.current?.resume(); // "go on", "keep going", "play it"
      else if (name === "stop") latest.current?.hold(); // "hold on", "stop": paused, and said so at once
    };
    // Anywhere on the page while the tour is open: the speed keys (components/Reader.tsx leaves them to the tour), and Space to ask pauses it.
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest?.("input, textarea, select, [contenteditable='true']")) return;
      const sp = speedKey(e);
      if (sp) {
        e.preventDefault();
        latest.current?.[sp]();
      } else if (e.key === " " && !e.repeat && auto.current === "on") {
        setAuto("paused"); // it stays paused after the answer, until P or "go on"
        run.current++;
        stop();
      }
    };
    window.addEventListener("arc:command", onCommand);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("arc:command", onCommand);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Exploring by hand: entering a part that can be found chimes and says its name at once (prefetched); resting in it 700 ms
  // says its whole line, then (pictures) the way to the next part. Resting 1.2 s anywhere else always says something: where to
  // go, where the nearest part is, or that the current part cannot be placed. Moving to another part, or well away from where a
  // line began, cuts that line: the student has moved on. Edges of the picture get a quiet tick.
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
    here.current = inside ? { x, y } : null;
    if (!chart && inside) guided.current = true;
    let k = inside ? hitStop(stops, y, x, findable) : -1;
    const was = over.current;
    if (k < 0 && was >= 0 && inside && boxDistance(stops[was].box_2d, y, x) < 15) k = was; // a shaky hand at the edge stays in the part
    if (talking.current && anchor.current.run !== talking.current) anchor.current = { run: talking.current, x, y };
    const far = inside && Math.hypot(x - anchor.current.x, y - anchor.current.y) > 40;
    if (k >= 0 && k === was) return; // moving inside the same part keeps its timer and its line
    clearTimeout(rest.current);
    if (talking.current && (k !== was || (far && talking.current !== guiding.current))) {
      run.current++; // moved on: the line being said (or fetched) stops at once
      stop();
      talking.current = 0;
    }
    over.current = k;
    if (k >= 0) return void (rest.current = window.setTimeout(() => enter(k), PASS_MS)); // a part only passed over stays quiet
    if (!inside) {
      stopBeat();
      trend.current = { d: -1, away: 0 };
      return;
    }
    if (!chart) seek(x, y);
    rest.current = window.setTimeout(() => restLine(y, x), 1200);
  };
  const enter = (k: number) => {
    stopBeat();
    const my = ++run.current;
    talking.current = my;
    stop();
    setI(k); // the ring follows the part the pointer is in
    setPaused(false);
    pt.current = -1;
    setReadout("");
    const s = stops[k];
    prefetch(body(k)); // ready by the end of the rest
    prefetch(s.label); // a stop() since the tour opened may have dropped it
    const t0 = clock() - PASS_MS;
    (async () => {
      await chime();
      if (my !== run.current) return;
      await say(s.label);
      if (my !== run.current) return;
      talking.current = 0;
      rest.current = window.setTimeout(async () => {
        if (my !== run.current) return;
        talking.current = my;
        lineAt.current = performance.now();
        if (!chart) goal.current = k + 1; // heard: guidance goes on from here
        await say(body(k));
        if (my !== run.current || chart) return void (talking.current === my && (talking.current = 0));
        await beat(400);
        if (my !== run.current) return;
        talking.current = guiding.current = my;
        said.current = performance.now() + 1000;
        await say(nextLine(stops, goalOf(), here.current));
        if (talking.current === my) talking.current = 0;
      }, Math.max(0, 700 - (clock() - t0)));
    })();
  };
  // After resting in empty space: always one line.
  const restLine = (y: number, x: number) => {
    const g = goalOf();
    const cur = stops[i];
    const near = nearestHint(stops, y, x, findable);
    let text: string;
    if (!near) text = `I can't point to the parts of this picture. ${tourStart(inputStyle(), "hear the next one")}`;
    else if (!chart && cur && !placed(cur) && !told.current.has(i)) {
      told.current.add(i);
      text = `I can't place ${cur.label} on the picture. ${near}`;
    } else text = !chart && stops[g] ? keepGoing(stops[g].box_2d, y, x) : near;
    const n = ++run.current;
    talking.current = n;
    stop();
    say(text).then(() => {
      if (talking.current === n) talking.current = 0;
    });
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
  // Guided seeking, while the pointer moves in empty space: ticks that quicken and rise as it nears the next part, and a word
  // when it drifts away from it.
  const seek = (x: number, y: number) => {
    const target = stops[goalOf()];
    if (!target) return stopBeat();
    const now = clock();
    const d = boxDistance(target.box_2d, y, x);
    beatAt(d);
    const tr = trend.current;
    if (tr.d >= 0 && towards(tr.d, d)) tr.away = 0; // any move toward the target cancels a pending correction
    else if (tr.d >= 0 && d > tr.d + 1) {
      tr.away ||= now;
      if (now - tr.away > 700 && sayGuide(correction(target.box_2d, y, x))) tr.away = now;
    }
    tr.d = d;
  };
  // One soft tick per beat; the gap and pitch follow the distance at each beat, and moving closer brings the next one forward.
  const pulse = () => {
    const b = pace.current;
    b.timer = 0;
    const p = here.current;
    const target = stops[goalOf()];
    if (!p || !target || over.current >= 0 || still.current || clock() - movedAt.current > STILL_MS) return; // the next move starts them again
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
  const track = (e: React.PointerEvent) => {
    // The student's own hand on the picture ends the self-running tour (the guidance below takes over); moves Arc made, and the
    // still pointer a scroll passes under, are not a hand.
    const hand = e.type === "pointerdown" || (e.type === "pointermove" && (e.movementX || e.movementY) && !real.current?.ours());
    if (auto.current !== "off") {
      if (!hand) return;
      setAuto("off");
      run.current++;
      stop();
    }
    if (hand && !byHand) setByHand(true);
    const out = e.type === "pointerleave";
    if (out && e.pointerType === "touch") return; // a lifted finger is not leaving the picture
    if (e.type === "pointerdown") over.current = -1; // touching the same part again chimes again
    aim.current = out ? null : { x: e.clientX, y: e.clientY };
    movedAt.current = clock();
    frame.current ||= requestAnimationFrame(explore);
  };

  const keys: Record<string, "next" | "prev" | "repeat" | "pause" | "leave"> = {
    ArrowRight: "next",
    ArrowLeft: "prev",
    Enter: "repeat",
    ArrowDown: "next",
    ArrowUp: "prev",
    p: "pause",
    P: "pause",
    Escape: "leave",
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || ["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
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
      if (!a && auto.current === "on") setAuto("paused"); // another key stops the self-running tour where it is; P or "go on" resumes it
    }
    if (!a) {
      // Arc is the screen reader: a character that does nothing here still gets an answer (in Arc's own voice, at once).
      // After this key reaches components/Reader.tsx, which stops the voice on every key.
      const line = e.key === "?" ? TOUR_HELP : e.key.length === 1 && !" /`".includes(e.key) ? TOUR_UNKNOWN : "";
      if (line) setTimeout(() => void speaker.say([line]), 0);
      return;
    }
    e.preventDefault(); // Enter must not also click the focused button
    actions[a]();
  };

  const cur = i >= 0 ? stops[i] : undefined;
  const box = cur && placed(cur) ? flat(cur.box_2d) : undefined; // the same box the place words come from (stopLine)
  const src = tour.image ?? node.image?.url;

  return (
    <section aria-label={`Figure tour: ${tour.title}`} onKeyDown={onKeyDown} data-stops={stops.length}>
      <div
        onPointerMove={track}
        onPointerDown={track}
        onPointerLeave={track}
        onMouseDown={(e) => e.preventDefault()} // a click on the picture must not move focus off the tour keys
        style={{ position: "relative", lineHeight: 0, touchAction: "none" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- remote figure URLs, sized by the page */}
        <img
          ref={img}
          draggable={false}
          src={src}
          alt={node.image?.alt ?? tour.title}
          style={{ width: "100%", height: "auto" }}
          onLoad={(e) => {
            const p = e.currentTarget;
            if (p.naturalWidth && p.naturalHeight) p.parentElement?.style.setProperty("--ar", String(p.naturalWidth / p.naturalHeight)); // its shape sizes the frame (app/globals.css)
            p.closest("[data-tour]")?.scrollIntoView({ block: "start" }); // its height is known only now
          }}
        />
        {/* Arc's own pointer: glides to each stop's middle (the real one follows when allowed). Hidden once the student's hand takes over. */}
        {/* A span: the ring's rules style the picture's aria-hidden divs (app/profiles.css). */}
        <span className="tour-pointer" aria-hidden="true" data-on={!byHand && !chart} style={{ left: `${tip.x / 10}%`, top: `${tip.y / 10}%` }}>
          <svg viewBox="0 0 32 32" width="100%" height="100%">
            <path d="M3 2 L3 26 L9.5 20 L14 30 L18.5 28 L14 18.5 L23 18.5 Z" />
          </svg>
        </span>
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
        aria-label="Figure tour keys. Escape leaves, question mark lists the keys." // short: a screen reader says it on focus, over Arc's intro
      >
        Tour keys are on{autoNow === "on" ? ", playing by itself" : ""}. Speed {speed}x{paused || autoNow === "paused" ? ", paused" : ""}.
      </div>
    </section>
  );
}
