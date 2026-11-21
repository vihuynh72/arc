"use client";
// The reading pointer: one drawn arrow, mounted once by components/Twin.tsx, that shows a sighted helper (and a student with some
// sight) where Arc is reading. It never decides anything: it watches the page Reader.tsx marks ([aria-current] for the stop,
// [data-speaking] for the sentence) and glides there, sitting in the left margin with its tip at the start of the line.
// Placed in page coordinates, so when the page glides to follow the cursor the pointer rides with the text and only its own
// travel shows. Listening (Space held: the Ask button is pressed) pulses it; a typed or spoken command flashes it where it lands.
// Hidden while a figure tour runs (the tour has its own ring) and with Display > Reading pointer > Off (lib/client/display.ts).
import { useEffect, useRef } from "react";
import { finalScrollY, realPointer } from "@/lib/client/pointer";

const GAP = 26; // between the tip and the line: clears the band's bar (Reader's ring sits 22 px left of the stop)
const NAMES = new Set(["next", "prev", "nextHeading", "prevHeading", "nextFigure", "prevFigure", "return", "goto", "page", "read", "continue", "tour"]);

/** The start edge (left, or right in a right-to-left text) and the first line of what is being read now, in page coordinates; null when nothing is current. */
function spot(): { x: number; y: number; h: number; el: Element; stop: Element; rtl: boolean } | null {
  const cur = document.querySelector<HTMLElement>('#content [aria-current="true"]');
  if (!cur || document.querySelector("[data-tour]")) return null;
  const s = cur.querySelector<HTMLElement>("[data-speaking]") ?? (cur.matches("[data-speaking]") ? cur : null);
  // A figure: beside its image (or caption). A node with a heading (video part, section): its heading. Else the block itself.
  const fig = cur.matches("figure") ? (cur.querySelector("img, [data-cursor]") ?? cur) : null;
  const line = s ?? fig ?? cur.querySelector<HTMLElement>("[data-cursor]") ?? cur;
  const block = s?.closest("[data-block-id], [data-cursor]") ?? fig ?? line;
  const r = line.getClientRects()[0] ?? line.getBoundingClientRect();
  if (!r.height && !r.width) return null;
  // The first line box: an inline span's first fragment, or the first text line of a block.
  let top = r.top;
  let h = r.height;
  if (!s && !fig) {
    const range = document.createRange();
    range.selectNodeContents(line);
    const first = range.getClientRects()[0];
    if (first) [top, h] = [first.top, first.height];
  } else if (fig) h = Math.min(h, 64);
  const rtl = getComputedStyle(block).direction === "rtl";
  const box = block.getBoundingClientRect();
  return { x: (rtl ? box.right : box.left) + window.scrollX, y: top + window.scrollY, h, el: s ?? cur, stop: cur, rtl };
}

export default function Pointer() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const p = ref.current;
    const content = document.getElementById("content");
    if (!p || !content) return;
    let at: { x: number; y: number; el: Element | null; stop: Element | null } = { x: 0, y: 0, el: null, stop: null };
    let raf = 0;
    let flashFor = 0; // a command asked for a confirm flash until this time
    let flashTimer = 0;
    let shown = false;
    const real = realPointer(); // the real macOS pointer, when Arc runs on this Mac (lib/client/pointer.ts)
    const size = () => (document.documentElement.dataset.pointer === "large" ? 56 : 38);
    const flash = (delay: number) => {
      clearTimeout(flashTimer);
      flashTimer = window.setTimeout(() => {
        p.removeAttribute("data-flash");
        void p.offsetWidth; // restart the animation
        p.setAttribute("data-flash", "true");
      }, delay);
    };
    const update = () => {
      raf = 0;
      const s = spot();
      const w = size();
      // No room in the margin (a narrow screen): the pointer would cover words, so it stays away.
      if (!s || (s.rtl ? s.x - window.scrollX + GAP + w > document.documentElement.clientWidth : s.x - window.scrollX - GAP - w < 0)) {
        p.dataset.on = "false";
        shown = false;
        return;
      }
      const x = Math.round(s.rtl ? s.x + GAP : s.x - GAP - w);
      const y = Math.round(s.y + s.h / 2 - w / 2);
      const moved = s.el !== at.el;
      if (!moved && Math.abs(x - at.x) < 1 && Math.abs(y - at.y) < 1 && shown) return;
      const calm = document.documentElement.dataset.motion === "reduce";
      const far = Math.hypot(x - at.x, y - at.y);
      // A new stop or sentence glides (350 to 500 ms, longer for longer trips). The same one shifted by layout (a page added
      // above, an image loaded) jumps with its text, so the pointer never points at empty space.
      const ms = !shown || !moved || calm ? 0 : Math.round(Math.min(500, 350 + far * 0.25));
      p.style.transitionDuration = `${ms}ms`;
      p.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      p.dataset.on = "true";
      p.dataset.dir = s.rtl ? "rtl" : "ltr"; // the arrow stands on the start side of the line and points at it
      shown = true;
      const newStop = s.stop !== at.stop;
      at = { x, y, el: s.el, stop: s.stop };
      // The real pointer lands on the drawn tip (37/40 across, half way down), where the page will be once its glide ends.
      // Only while the real one may move (lib/client/pointer.ts) does the drawn arrow step back to its halo.
      p.dataset.real = String(real.active);
      if (newStop) real.to(x + (w * (s.rtl ? 3 : 37)) / 40 - window.scrollX, y + w / 2 - finalScrollY(), Math.max(ms, 250));
      if (moved && performance.now() < flashFor) {
        flashFor = 0;
        flash(ms);
      }
    };
    const soon = () => void (raf ||= requestAnimationFrame(update));
    const mo = new MutationObserver(soon);
    mo.observe(content, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-current", "data-speaking"] });
    const ro = new ResizeObserver(soon);
    ro.observe(document.body);
    // The Ask button is pressed while Arc listens (components/AskButton.tsx): the pointer listens too.
    const ask = document.querySelector("header .ask button");
    const listen = () => void (p.dataset.listening = String(ask?.getAttribute("aria-pressed") === "true"));
    const ao = new MutationObserver(listen);
    if (ask) ao.observe(ask, { attributes: true, attributeFilter: ["aria-pressed"] });
    // A typed or spoken command: flash where the pointer lands. One that does not move it (read again) flashes in place.
    const onCommand = (e: Event) => {
      const d = (e as CustomEvent<{ name: string; args?: { silent?: boolean } }>).detail;
      if (!d || d.args?.silent || !NAMES.has(d.name)) return;
      flashFor = performance.now() + (d.name === "page" ? 15_000 : 1500); // a page may have to be fetched first
      if (d.name !== "page")
        window.setTimeout(() => {
          if (flashFor && shown) {
            flashFor = 0;
            flash(0);
          }
        }, 700);
    };
    const display = new MutationObserver(soon); // pointer size changed in the Display panel
    display.observe(document.documentElement, { attributes: true, attributeFilter: ["data-pointer", "data-real-pointer"] });
    window.addEventListener("arc:command", onCommand);
    window.addEventListener("resize", soon);
    soon();
    return () => {
      mo.disconnect();
      ro.disconnect();
      ao.disconnect();
      display.disconnect();
      cancelAnimationFrame(raf);
      clearTimeout(flashTimer);
      real.stop();
      window.removeEventListener("arc:command", onCommand);
      window.removeEventListener("resize", soon);
    };
  }, []);

  return (
    <div ref={ref} className="arc-pointer" aria-hidden="true" data-on="false">
      <svg viewBox="0 0 40 40" width="100%" height="100%">
        {/* An arrow cursor turned to point right, at the line: white edge so it reads on every theme. */}
        <path d="M4 5 L37 20 L4 35 L11 20 Z" />
      </svg>
    </div>
  );
}
