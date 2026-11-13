"use client";
// The reading cursor, mounted by components/Twin.tsx. Arrow keys move it by node like VoiceOver; a visible ring travels to each node.
import { useCallback, useEffect, useRef, useState } from "react";
import type { TwinNode } from "@/lib/types";
import { findNode, nodeSpeech, said, speaker } from "@/lib/client/reader";

type Props = {
  items: TwinNode[];
  paused: boolean; // a figure tour is open: keys only stop speech
  onTour: (node: TwinNode) => void;
};

const nodeEl = (id: string) => document.querySelector<HTMLElement>(`[data-node-id="${id}"]`);

// A figure parks by its card top (image above, ringed caption below); anything else parks by its ringed element.
const parkEl = (el: HTMLElement, kind: string) => (kind === "figure" ? el : (el.querySelector<HTMLElement>("[data-cursor]") ?? el));

export default function Reader({ items, paused, onTour }: Props) {
  const [index, setIndex] = useState(-1);
  const [rate, setRate] = useState(1);
  const ring = useRef<HTMLDivElement>(null);
  // progUntil: Arc's own scroll is under way, ignore scroll events. settled: the index last announced. raf/timer: the scroll follower.
  const live = useRef({ items, index: -1, paused, onTour, progUntil: 0, settled: -1, raf: 0, timer: 0 });
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
        live.current.progUntil = performance.now() + 700; // smooth scroll takes up to ~0.6 s; scrollend clears it sooner
        const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        parkEl(el, node.kind).scrollIntoView({ block: "start", behavior: calm ? "auto" : "smooth" });
      }
      place(true);
      const figureIndex = node.kind === "figure" ? list.slice(0, i + 1).filter((n) => n.kind === "figure").length : undefined;
      window.dispatchEvent(new CustomEvent("arc:cursor", { detail: { id: node.id, kind: node.kind, heading: node.heading, figureIndex } }));
      if (opts.read !== false) void speaker.say(nodeSpeech(node));
    },
    [place],
  );

  const step = useCallback(
    (by: 1 | -1, heading = false) => {
      const { items: list, index: from } = live.current;
      let i = from + by;
      if (heading) {
        const h2 = list.some((n) => n.level === 2) ? (n: TwinNode) => n.level === 2 : (n: TwinNode) => n.kind !== "figure";
        while (i >= 0 && i < list.length && !h2(list[i])) i += by;
      }
      if (i < 0 || i >= list.length) {
        void speaker.say([by > 0 ? "End of the page." : "Top of the page."]);
        return null;
      }
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

  const faster = useCallback((by: number) => setRate(speaker.setRate(speaker.rate + by)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      speaker.cancel(); // any key stops the voice at once
      if (live.current.paused || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable='true']")) return;
      const k = e.key;
      if (k === "Enter" && t.closest("button, a, summary")) return; // let the control act
      if (k === "ArrowDown" || k === "ArrowRight") step(1, e.shiftKey && k === "ArrowDown");
      else if (k === "ArrowUp" || k === "ArrowLeft") step(-1, e.shiftKey && k === "ArrowUp");
      else if (k === "Enter") readAgain();
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

  // The user scrolls (wheel, touch, bar, Page keys, screen reader): the cursor follows the item nearest the arrow-key landing line.
  // The page is never scrolled back and focus never moves. Once still for 450 ms the item is read, once.
  useEffect(() => {
    const L = live.current;
    const born = performance.now() + 1000;
    L.progUntil = born; // a new page may clamp the scroll position
    const idle = () => L.paused || performance.now() < L.progUntil || !!document.activeElement?.closest("input, textarea, select, [contenteditable='true']");
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
      if (best >= 0 && best !== L.index) moveTo(best, { from: "scroll" });
    };
    const onScroll = () => {
      if (idle()) return;
      speaker.cancel(); // a new scroll stops the voice, like a key
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
    return () => {
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
      if (name === "next" || name === "prev") {
        const n = step(name === "next" ? 1 : -1);
        said(n ? `Moved to ${n.heading}.` : name === "next" ? "End of the page." : "Top of the page.");
      } else if (name === "goto") {
        const byId = args?.id ? list.findIndex((n) => n.id === args.id) : -1;
        const i = byId >= 0 ? byId : findNode(list, String(args?.query ?? ""));
        if (i < 0) {
          said(`I could not find ${String(args?.query ?? "that")}.`);
          void speaker.say([`I could not find ${String(args?.query ?? "that")}.`]);
        }
        else if (args?.silent) moveTo(i, { read: false }); // Twin places the cursor on new content and speaks its own line
        else {
          moveTo(i);
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
          moveTo(list.indexOf(fig), { read: false });
          live.current.onTour(fig);
        }
      }
    };
    window.addEventListener("arc:command", onCommand);
    return () => window.removeEventListener("arc:command", onCommand);
  }, [step, moveTo, readAgain]);

  const here = items[index];
  return (
    <>
      <div ref={ring} className="arc-ring" data-on="false" />
      <div role="application" aria-label="Reading controls" className="reader">
        <p className="reader-pos">
          {here ? `${index + 1} of ${items.length}: ${here.heading}` : `${items.length} items. Press the down arrow to start.`}
        </p>
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
      </div>
    </>
  );
}
