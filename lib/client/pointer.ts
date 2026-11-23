"use client";
// Shared by components/Reader.tsx (which sets where its page glide will end) and components/Pointer.tsx (which needs the stop's
// final place on screen, not an intermediate scroll frame), plus the real macOS mouse pointer (/api/pointer, lib/server/pointer.ts).

/** Where Reader's current page glide ends (window.scrollY), valid until `until` (performance.now()). */
export const scrollGoal = { y: 0, until: 0 };
/** window.scrollY once the page has stopped moving. */
export const finalScrollY = () => (performance.now() < scrollGoal.until ? scrollGoal.y : window.scrollY);

const THROTTLE_MS = 120;
const OWN_MS = 150; // mouse events this soon after our own move ends are ours
const READING_KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "Enter", "r", "R"]);

/** The viewport point (CSS px) as macOS screen points. Chrome on macOS has no side frame, so screenX is the page's left edge and
 * everything above the page is outerHeight - innerHeight. Wrong with: browser zoom other than 100% (corrected below by
 * outerWidth / innerWidth, which itself is wrong with devtools docked at the side), devtools or a download bar docked below the
 * page (adds to the top offset), full screen with a hidden toolbar that slides in, and windows spanning displays of different scale. */
export function toScreen(clientX: number, clientY: number) {
  const z = zoom();
  return { x: window.screenX + clientX * z, y: window.screenY + (window.outerHeight - window.innerHeight * z) + clientY * z };
}

/**
 * The real mouse pointer follows the reading pointer. Opt-in twice: the server must say it can (GET /api/pointer: only on the Mac
 * Arc runs on, and only when started with ARC_REAL_POINTER=on) and the student must turn on Display > "Move my real mouse pointer".
 * The hand always wins: any mouse or touch movement, wheel or press that Arc did not cause stops it until the next deliberate
 * reading command (a reading key, or a typed or spoken command); reading on by itself never re-arms it. Never while the tab is
 * hidden or unfocused, during a figure tour, with a button down, or to a point outside the page area. At most one move per 120 ms.
 * tour: the figure tour's own (components/FigureTour.tsx): armed from the start and allowed while its tour is open.
 */
export function realPointer(tour = false) {
  let available = false;
  let armed = tour; // the last input was a reading command and the hand has not moved since
  let busyUntil = 0; // our own move (plus a margin) is under way until then
  let down = false;
  let lastSent = 0;
  let pending: { x: number; y: number; ms: number } | null = null;
  let timer = 0;
  const wanted = () => document.documentElement.dataset.realPointer === "on" && document.documentElement.dataset.pointer !== "off";
  // Only a copy on this machine can move the real pointer; a hosted copy answers 404, so it is not asked (a 404 in every visitor's console).
  if (["localhost", "127.0.0.1", "[::1]"].includes(location.hostname))
    void fetch("/api/pointer")
      .then((r) => r.json())
      .then((d: { available?: boolean }) => void (available = d.available === true), () => {});
  const allowed = () => available && wanted() && armed && !down && document.visibilityState === "visible" && document.hasFocus() && (tour || !document.querySelector("[data-tour]"));
  const send = () => {
    timer = 0;
    const p = pending;
    pending = null;
    if (!p || !allowed()) return;
    lastSent = performance.now();
    busyUntil = lastSent + p.ms + OWN_MS;
    void fetch("/api/pointer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) }).catch(() => {});
  };
  const hand = () => {
    armed = false;
    pending = null; // a move not yet sent is dropped; one under way is left to finish (stopping it would need another move)
    clearTimeout(timer);
    timer = 0;
  };
  const onMove = (e: MouseEvent) => void ((e.movementX || e.movementY) && performance.now() > busyUntil && hand());
  const onDown = () => {
    down = true;
    hand();
  };
  const onUp = () => void (down = false);
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (!e.ctrlKey && !e.metaKey && !e.altKey && READING_KEYS.has(e.key) && !t.closest?.("input, textarea, select, [contenteditable='true']")) armed = true;
  };
  const onCommand = (e: Event) => void (!(e as CustomEvent<{ args?: { silent?: boolean } }>).detail?.args?.silent && (armed = true));
  const opts = { passive: true, capture: true } as const;
  window.addEventListener("mousemove", onMove, opts);
  window.addEventListener("pointermove", onMove, opts);
  window.addEventListener("wheel", hand, opts);
  window.addEventListener("touchstart", hand, opts);
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("blur", onUp);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("arc:command", onCommand);
  return {
    /** The drawn arrow hands its tip to the real pointer only while the real one may move. */
    get active() {
      return available && wanted();
    },
    /** True while a move Arc sent is under way: the mouse events it causes are not the student's hand. */
    ours: () => performance.now() < busyUntil,
    /** Glide the real pointer to this viewport point (CSS px, where the page will be once still) over `ms`. Off-screen: not sent. */
    to(clientX: number, clientY: number, ms: number) {
      if (!allowed() || clientX < 0 || clientY < 0 || clientX > window.innerWidth || clientY > window.innerHeight) return;
      pending = { ...toScreen(clientX, clientY), ms };
      if (!timer) timer = window.setTimeout(send, Math.max(0, lastSent + THROTTLE_MS - performance.now()));
    },
    stop() {
      clearTimeout(timer);
      window.removeEventListener("mousemove", onMove, opts);
      window.removeEventListener("pointermove", onMove, opts);
      window.removeEventListener("wheel", hand, opts);
      window.removeEventListener("touchstart", hand, opts);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("blur", onUp);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("arc:command", onCommand);
    },
  };
}

// Browser zoom, as screen points per CSS px: screenX and outerWidth are in points, innerWidth in zoomed CSS px, and Chrome on macOS
// has no side frame, so their ratio is the zoom (1 at 100%). Pinch zoom (visualViewport.scale) is not counted.
const zoom = () => {
  const z = window.outerWidth / Math.max(1, window.innerWidth);
  return z > 0.25 && z < 5 && Math.abs(z - 1) > 0.02 ? z : 1;
};
