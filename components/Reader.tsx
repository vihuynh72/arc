"use client";
// The reading cursor, mounted by components/Twin.tsx. Arrow keys move it by node like VoiceOver; a visible ring travels to each node.
import { useCallback, useEffect, useRef, useState } from "react";
import type { TwinNode } from "@/lib/types";
import { voiceFirst } from "@/lib/client/display";
import { findNode, nodeSpeech, said, speaker } from "@/lib/client/reader";

type Props = {
  items: TwinNode[];
  paused: boolean; // a figure tour is open: keys only stop speech
  onTour: (node: TwinNode) => void;
};

const nodeEl = (id: string) => document.querySelector<HTMLElement>(`[data-node-id="${id}"]`);

// A figure parks by its card top (image above, ringed caption below); anything else parks by its ringed element.
const OFFER = "Press Enter or say tour to explore it.";

const parkEl = (el: HTMLElement, kind: string) => (kind === "figure" ? el : (el.querySelector<HTMLElement>("[data-cursor]") ?? el));

export default function Reader({ items, paused, onTour }: Props) {
  const [index, setIndex] = useState(-1);
  const [rate, setRate] = useState(1.5);
  useEffect(() => setRate(speaker.rate), []); // the saved speed (localStorage) is only known in the browser
  const ring = useRef<HTMLDivElement>(null);
  const readOnRef = useRef<(from?: number) => Promise<void>>(async () => {}); // moveTo is defined before readOn
  // progUntil: Arc's own scroll is under way, ignore scroll events. settled: the index last announced. raf/timer: the scroll follower.
  // hist: places before each jump, for "go back". reading: bumped by any key or command, ends "keep reading".
  const live = useRef({ items, index: -1, paused, onTour, progUntil: 0, settled: -1, raf: 0, timer: 0, hist: [] as number[], reading: 0, userAt: -1e9, keyAt: 0 });
  useEffect(() => {
    live.current.items = items;
    live.current.paused = paused;
    live.current.onTour = onTour;
  });

  const place = useCallback((animate: boolean) => {
    const r = ring.current;
    const { items: list, index: i } = live.current;
    const el = list[i] && nodeEl(list[i].id);
    if (!r || !el) return;
    const box = (el.querySelector("[data-cursor]") ?? el).getBoundingClientRect();
    const pad = 8;
    r.style.transition = animate ? "" : "none";
    r.style.top = `${box.top + window.scrollY - pad}px`;
    r.style.left = `${box.left + window.scrollX - pad}px`;
    r.style.width = `${box.width + pad * 2}px`;
    r.style.height = `${box.height + pad * 2}px`;
    r.dataset.on = "true";
  }, []);

  const moveTo = useCallback(
    (i: number, opts: { read?: boolean; scroll?: boolean; from?: "scroll" } = {}) => {
      const { items: list } = live.current;
      const node = list[i];
      const el = node && nodeEl(node.id);
      if (!node || !el) return;
      document.querySelectorAll('[aria-current="true"]').forEach((o) => o.removeAttribute("aria-current"));
      el.setAttribute("aria-current", "true");
      live.current.index = i;
      setIndex(i);
      if (opts.from === "scroll") return place(true); // the user's own scroll: the ring follows, the settle timer announces
      live.current.settled = i;
      if (opts.scroll !== false) {
        live.current.progUntil = performance.now() + 2500; // a long smooth scroll ("start", "end") outlasts 0.7 s; scrollend clears it sooner
        const calm = document.documentElement.dataset.motion === "reduce"; // system setting or the Display panel (lib/client/display.ts)
        parkEl(el, node.kind).scrollIntoView({ block: "start", behavior: calm ? "auto" : "smooth" });
      }
      place(true);
      const figureIndex = node.kind === "figure" ? list.slice(0, i + 1).filter((n) => n.kind === "figure").length : undefined;
      window.dispatchEvent(new CustomEvent("arc:cursor", { detail: { id: node.id, kind: node.kind, heading: node.heading, figureIndex, back: live.current.hist.length > 0 } }));
      if (opts.read === false) return;
      // Arriving on a figure by any means: its caption, then the tour offer ("yes", "tour", Enter start it).
      const fig = node.kind === "figure" && !!node.image && !live.current.paused;
      if (fig) window.dispatchEvent(new CustomEvent("arc:offer", { detail: { name: "tour", args: { id: node.id } } }));
      if (!voiceFirst()) return void speaker.say([...nodeSpeech(node), ...(fig ? [OFFER] : [])]);
      // Voice first: where it landed, the item, the tour offer on a figure; then reading runs on to the next items.
      const mine = live.current.reading;
      void speaker.say([`${i + 1} of ${list.length}.`, ...nodeSpeech(node), ...(fig ? [OFFER] : [])]).then((ok) => {
        if (!fig && ok && mine === live.current.reading && live.current.index === i) void readOnRef.current(i + 1);
      });
    },
    [place],
  );

  const step = useCallback(
    (by: 1 | -1, heading: boolean | "figure" = false, steps = 1) => {
      const { items: list, index: from } = live.current;
      let i = from + by;
      if (heading) {
        const h2 = heading === "figure" ? (n: TwinNode) => n.kind === "figure" : list.some((n) => n.level === 2) ? (n: TwinNode) => n.level === 2 : (n: TwinNode) => n.kind !== "figure";
        while (i >= 0 && i < list.length && !h2(list[i])) i += by;
      }
      if (i < 0 || i >= list.length) {
        const end = heading === "figure" ? (by > 0 ? "No more figures." : "No figures before this.") : by > 0 ? "That is the last one." : "That is the first one.";
        void speaker.say([end]);
        return null;
      }
      if (steps > 1) i = Math.min(Math.max(from + by * steps, 0), list.length - 1); // one combined move; read only where it lands
      moveTo(i);
      return list[i];
    },
    [moveTo],
  );

  const readAgain = useCallback(() => {
    const n = live.current.items[live.current.index];
    if (n) void speaker.say(nodeSpeech(n));
    else step(1);
  }, [step]);

  // "more": read on from the current item until anything else happens.
  // Stops when a reading is cancelled (any key, Escape, "stop"), when the cursor moves some other way, and in voice
  // first at a figure (its caption, then the tour offer).
  const readOn = useCallback(async (from?: number) => {
    const L = live.current;
    const mine = ++L.reading;
    for (let i = from ?? Math.max(L.index, 0); i < L.items.length && mine === L.reading; i++) {
      moveTo(i, { read: false });
      const n = L.items[i];
      const fig = n.kind === "figure" && !!n.image;
      const ok = await speaker.say(fig ? [...nodeSpeech(n), OFFER] : nodeSpeech(n));
      if (fig && ok) window.dispatchEvent(new CustomEvent("arc:offer", { detail: { name: "tour", args: { id: n.id } } }));
      if (!ok || fig || L.index !== i) break;
    }
  }, [moveTo]);
  useEffect(() => {
    readOnRef.current = readOn;
  }, [readOn]);

  const faster = useCallback((by: number) => {
    const r = speaker.setRate(speaker.rate + by);
    setRate(r);
    void speaker.say([`Speed ${r.toFixed(1)}.`]);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      const t = e.target as HTMLElement;
      const typing = !!t.closest?.("input, textarea, select, [contenteditable='true']");
      if (["PageUp", "PageDown"].includes(e.key) && !typing) live.current.userAt = performance.now(); // the user scrolls by key
      const arrow = e.key.startsWith("Arrow");
      // A held arrow: act on the first press, then at most every 350 ms, so a press held a little long never moves two.
      if (arrow && e.repeat && !live.current.paused && !typing && performance.now() - live.current.keyAt < 350) return void e.preventDefault();
      speaker.cancel(); // any key stops the voice at once
      live.current.reading++;
      if (live.current.paused && (e.key === "r" || e.key === "R") && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        window.dispatchEvent(new CustomEvent("arc:command", { detail: { name: "read" } })); // R in a tour repeats the stop
        return void e.preventDefault();
      }
      if (live.current.paused || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (typing) return;
      const k = e.key;
      if (arrow) live.current.keyAt = performance.now();
      if (k === "Enter" && t.closest("button, a, summary")) return; // let the control act
      if (k === "ArrowDown" || k === "ArrowRight") step(1, e.shiftKey && k === "ArrowDown");
      else if (k === "ArrowUp" || k === "ArrowLeft") step(-1, e.shiftKey && k === "ArrowUp");
      else if (k === "Enter") {
        const n = live.current.items[live.current.index];
        if (n?.kind === "figure" && n.image) live.current.onTour(n); // Enter on a figure starts its tour
        else readAgain();
      }
      else if (k === "r" || k === "R") readAgain(); // replay on every kind of item, figures too
      else if (k === "+" || k === "=") faster(0.1);
      else if (k === "-" || k === "_") faster(-0.1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, readAgain, faster]);

  // Focus landing in a node (Tab, or leaving a tour) moves the cursor there without speaking.
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      const id = (e.target as HTMLElement).closest?.("[data-node-id]")?.getAttribute("data-node-id");
      const i = live.current.items.findIndex((n) => n.id === id);
      if (i < 0 || i === live.current.index) return;
      live.current.progUntil = performance.now() + 700; // the browser may scroll the focused node into view
      moveTo(i, { read: false, scroll: false });
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, [moveTo]);

  // A click or tap on an item makes it current and reads it, in place: no scroll. Controls, drags, selections, modified clicks and tours are left alone.
  useEffect(() => {
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => void (down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null);
    const onUp = (e: PointerEvent) => {
      const start = down;
      down = null;
      if (!start || e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || live.current.paused) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6 || !(window.getSelection()?.isCollapsed ?? true)) return;
      const t = e.target as HTMLElement;
      if (!t.closest?.("#content") || t.closest("a, button, summary, input, textarea, select, label, [contenteditable='true'], [data-tour]")) return;
      const i = live.current.items.findIndex((n) => n.id === t.closest("[data-node-id]")?.getAttribute("data-node-id"));
      if (i < 0) return; // blank space between items
      speaker.cancel();
      live.current.reading++;
      moveTo(i, { scroll: false });
    };
    const onCancel = () => void (down = null); // a touch that turned into a scroll
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
    };
  }, [moveTo]);

  // The user scrolls (wheel, touch, bar, Page keys, screen reader): the cursor follows the item nearest the arrow-key landing line.
  // The page is never scrolled back and focus never moves. Once still for 450 ms the item is read, once.
  useEffect(() => {
    const L = live.current;
    const born = performance.now() + 1000;
    L.progUntil = born; // a new page may clamp the scroll position
    // Only a scroll the user is making moves the cursor: a wheel, touch, Page key or scrollbar press in the last 250 ms.
    // Arc's own smooth scrolls, images and figures loading, panels resizing and anchor jumps never do (they skipped items).
    const idle = () => L.paused || performance.now() - L.userAt > 250 || performance.now() < L.progUntil || !!document.activeElement?.closest("input, textarea, select, [contenteditable='true']");
    const mark = () => void (L.userAt = performance.now());
    const onBar = (e: PointerEvent) => void (e.clientX >= document.documentElement.clientWidth && mark()); // the scrollbar sits outside clientWidth
    const follow = () => {
      L.raf = 0;
      let best = -1;
      let gap = Infinity;
      const hd = document.querySelector("header");
      const clear = hd && getComputedStyle(hd).position === "sticky" ? hd.getBoundingClientRect().bottom + 24 : -Infinity; // ring (8px out) stays 16px below a sticky header
      L.items.forEach((n, i) => {
        const el = nodeEl(n.id);
        const c = el && (el.querySelector("[data-cursor]") ?? el); // the ringed element
        const p = el && parkEl(el, n.kind); // the element a move parks at the top
        if (!c || !p) return;
        const land = (parseFloat(getComputedStyle(p).scrollMarginTop) || 0) + (parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0); // where a move parks it
        const d = Math.abs(p.getBoundingClientRect().top - land) + (c.getBoundingClientRect().top < clear ? 1e6 : 0); // a ring under the header only wins when nothing else is on screen
        if (d < gap) [best, gap] = [i, d];
      });
      if (best >= 0 && best !== L.index) {
        speaker.cancel(); // the user scrolled to another item; a scroll that stays on the item (late smooth scroll, images loading) must not cut its reading
        moveTo(best, { from: "scroll" });
      }
    };
    const onScroll = () => {
      if (idle()) return;
      L.userAt = performance.now(); // keep following while the user's scroll is still moving (momentum, a dragged bar)
      L.raf ||= requestAnimationFrame(follow);
      clearTimeout(L.timer);
      L.timer = window.setTimeout(() => {
        if (!idle() && L.index >= 0 && L.index !== L.settled) moveTo(L.index, { scroll: false });
      }, 450);
    };
    // The clamp's own scrollend must not lift the new-page guard early: that moved the cursor and cut the load line.
    const done = () => void (performance.now() > born && (L.progUntil = 0));
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scrollend", done);
    window.addEventListener("wheel", mark, { passive: true });
    window.addEventListener("touchmove", mark, { passive: true });
    window.addEventListener("pointerdown", onBar);
    return () => {
      window.removeEventListener("wheel", mark);
      window.removeEventListener("touchmove", mark);
      window.removeEventListener("pointerdown", onBar);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("scrollend", done);
      cancelAnimationFrame(L.raf);
      clearTimeout(L.timer);
    };
  }, [moveTo]);

  // Keep the ring on its node when the layout changes (zoom, images loading).
  useEffect(() => {
    const again = () => place(false);
    window.addEventListener("resize", again);
    const ro = new ResizeObserver(again);
    ro.observe(document.body);
    return () => {
      window.removeEventListener("resize", again);
      ro.disconnect();
    };
  }, [place]);

  // Voice commands.
  useEffect(() => {
    const onCommand = (e: Event) => {
      const { name, args } = (e as CustomEvent<{ name: string; args?: Record<string, unknown> }>).detail ?? {};
      const { items: list, index: at } = live.current;
      if (live.current.paused && name !== "stop") return;
      live.current.reading++;
      const jump = (i: number) => void (i !== at && at >= 0 && live.current.hist.push(at));
      // Landing on a figure by a jump: read its caption, then offer the tour ("yes" or "tour" starts it).
      const land = (i: number) => moveTo(i); // a figure reads its caption and offers the tour
      if (name === "next" || name === "prev") {
        const n = step(name === "next" ? 1 : -1, false, Math.min(Number(args?.steps) || 1, 10));
        said(n ? `Moved to ${n.heading}.` : name === "next" ? "That is the last one." : "That is the first one.");
      } else if (name === "nextFigure" || name === "prevFigure" || name === "nextHeading" || name === "prevHeading") {
        const by = name.startsWith("next") ? 1 : -1;
        const figure = name.endsWith("Figure");
        const from = at;
        const n = step(by, figure ? "figure" : true);
        if (n) {
          if (from >= 0) live.current.hist.push(from);
          said(`Moved to ${n.heading}.`);
        } else said(figure ? "No more figures." : by > 0 ? "That is the last one." : "That is the first one.");
      } else if (name === "return") {
        const back = live.current.hist.pop();
        if (back == null || !list[back]) {
          said("There is nowhere to go back to yet.");
          void speaker.say(["There is nowhere to go back to yet."]);
        } else {
          moveTo(back, { read: false });
          said(`Back to ${list[back].heading}.`);
          void speaker.say([`Back to ${list[back].heading}.`]);
        }
      } else if (name === "continue") {
        void readOn();
      } else if (name === "faster" || name === "slower") {
        const r = speaker.setRate(args?.normal ? 1 : speaker.rate + (name === "faster" ? 0.1 : -0.1));
        setRate(r);
        const line = args?.normal ? "Speed 1.0." : name === "faster" && r >= 2 ? "That is the fastest." : name === "slower" && r <= 1 ? "That is the slowest." : `Speed ${r.toFixed(1)}.`;
        said(line);
        void speaker.say([line]);
      } else if (name === "goto") {
        const byId = args?.id ? list.findIndex((n) => n.id === args.id) : -1;
        const byAt = typeof args?.at === "number" && list[args.at] ? args.at : -1;
        const i = byAt >= 0 ? byAt : byId >= 0 ? byId : findNode(list, String(args?.query ?? ""));
        if (i < 0) {
          said(`I could not find ${String(args?.query ?? "that")}.`);
          void speaker.say([`I could not find ${String(args?.query ?? "that")}.`]);
        }
        else if (args?.silent) moveTo(i, { read: false }); // Twin places the cursor on new content and speaks its own line
        else {
          jump(i);
          land(i);
          said(`Moved to ${list[i].heading}.`);
        }
      } else if (name === "read") {
        readAgain();
        said("Reading again.");
      } else if (name === "stop") {
        speaker.cancel();
        said("Stopped.");
      } else if (name === "tour") {
        const figs = list.filter((n) => n.kind === "figure");
        const byId = args?.id ? figs.find((n) => n.id === args.id) : undefined;
        const wanted = args?.figure != null ? figs.find((n) => n.heading.toLowerCase() === `figure ${args.figure}`) : undefined;
        const near = list[at]?.kind === "figure" ? list[at] : figs[0];
        const fig = byId ?? wanted ?? (args?.figure != null || args?.id ? undefined : near);
        const none = args?.figure != null ? `There is no figure ${args.figure}.` : args?.id ? "I could not find that figure." : "There are no figures on this page.";
        if (!fig) {
          said(none);
          void speaker.say([none]);
        }
        else {
          jump(list.indexOf(fig));
          moveTo(list.indexOf(fig), { read: false });
          live.current.onTour(fig);
        }
      }
    };
    window.addEventListener("arc:command", onCommand);
    return () => window.removeEventListener("arc:command", onCommand);
  }, [step, moveTo, readAgain, readOn]);

  const here = items[index];
  return (
    <>
      <div ref={ring} className="arc-ring" data-on="false" />
      <div
        role="application"
        aria-label="Reading controls. Down and Up arrows move, with Shift by heading. Enter reads again, or tours a figure. R replays. Plus and minus change speed."
        className="reader"
      >
        <p className="reader-pos">
          {here ? `${index + 1} of ${items.length}: ${here.heading}` : `${items.length} items. Press the down arrow to start.`}
        </p>
        {/* Every key works with this closed; the buttons are for a pointer. */}
        <details>
          <summary>Buttons for these controls</summary>
          <div className="reader-buttons">
          <button type="button" onClick={() => step(-1)}>Previous</button>
          <button type="button" onClick={() => step(1)}>Next</button>
          <button type="button" onClick={() => step(-1, true)}>Previous heading</button>
          <button type="button" onClick={() => step(1, true)}>Next heading</button>
          <button type="button" onClick={readAgain}>Read again</button>
          <button type="button" onClick={() => speaker.cancel()}>Stop</button>
          <button type="button" onClick={() => faster(-0.1)}>Slower</button>
          <button type="button" onClick={() => faster(0.1)}>Faster</button>
          <span className="reader-rate">Speed {rate.toFixed(1)}</span>
          </div>
        </details>
      </div>
    </>
  );
}
