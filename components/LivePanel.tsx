"use client";
// The original page in a real remote browser (Bright Data Browser API), following the reading cursor. Read-only: the server only scrolls and screenshots.
// Silent on purpose: no aria-live, no focus moves. The student's voice and keys stay the interface; this panel is for sighted eyes.
import { useCallback, useEffect, useRef, useState } from "react";

type Box = { x: number; y: number; w: number; h: number };
type Shot = { shot: string; viewport: { w: number; h: number }; box: Box | null; found: boolean; ms: number };
type Cursor = { id: string; kind: string; heading: string; figureIndex?: number };

const DEBOUNCE_MS = 350;

const post = (body: object) =>
  fetch("/api/remote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export default function LivePanel({ url }: { url: string }) {
  const [state, setState] = useState<"connecting" | "ready" | "error">("connecting");
  const [secs, setSecs] = useState(0);
  const [paused, setPaused] = useState(false);
  const [data, setData] = useState<Shot | null>(null);
  const [heading, setHeading] = useState("the top of the page");
  const [moving, setMoving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const cursor = useRef<Cursor | null>(null); // latest cursor position, even while paused or connecting
  const seq = useRef(0); // only the response of the newest request is shown
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const on = useRef({ ready: false, paused: false });
  useEffect(() => {
    on.current = { ready: state === "ready", paused };
  });

  const request = useCallback(
    async (c: Cursor | null) => {
      const mine = ++seq.current;
      const target =
        c?.kind === "figure" && c.figureIndex
          ? { kind: "figure", n: c.figureIndex }
          : c && c.kind === "section" && c.heading
            ? { kind: "heading", text: c.heading }
            : { kind: "top" };
      setMoving(true);
      try {
        const res = await post({ url, target });
        if (mine !== seq.current) return; // a newer cursor position is on its way
        const body = await res.json().catch(() => null);
        if (res.status === 409) return; // the server dropped it for a newer one
        if (!res.ok || !body?.shot) throw new Error();
        setData(body as Shot);
        setHeading(c?.heading || "the top of the page");
        setFailed(false);
      } catch {
        if (mine === seq.current) setFailed(true);
      } finally {
        if (mine === seq.current) setMoving(false);
      }
    },
    [url],
  );

  // Open the session as soon as the panel exists, so the first cursor move is fast.
  useEffect(() => {
    let live = true;
    const tick = setInterval(() => setSecs((s) => s + 1), 1000);
    post({ url, warm: true })
      .then((r) => {
        if (!r.ok) throw new Error();
        if (!live) return;
        setState("ready");
        if (!on.current.paused) void request(cursor.current);
      })
      .catch(() => live && setState("error"))
      .finally(() => clearInterval(tick));
    return () => {
      live = false;
      clearInterval(tick);
    };
  }, [url, attempt, request]);

  useEffect(() => {
    const onCursor = (e: Event) => {
      const d = (e as CustomEvent<Cursor>).detail;
      if (!d) return;
      cursor.current = d;
      if (!on.current.ready || on.current.paused) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void request(d), DEBOUNCE_MS);
    };
    window.addEventListener("arc:cursor", onCursor);
    return () => {
      window.removeEventListener("arc:cursor", onCursor);
      clearTimeout(timer.current);
    };
  }, [request]);

  const toggle = () => {
    clearTimeout(timer.current);
    if (paused && state === "ready") void request(cursor.current); // catch up to where the cursor is now
    setPaused(!paused);
  };

  const calm = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const b = data?.box;
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;

  return (
    <section aria-labelledby="live-title" style={{ margin: 0 }}>
      <h2 id="live-title" style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>
        Live page · through Bright Data
      </h2>
      <p style={{ margin: "0 0 0.5rem" }}>
        <button type="button" onClick={toggle} aria-pressed={paused}>
          {paused ? "Resume live page" : "Pause live page"}
        </button>{" "}
        {state === "ready" && moving && !paused && <span>moving…</span>}
        {paused && <span>Paused</span>}
      </p>
      {state === "connecting" && <p>Connecting to the live page… {secs} s</p>}
      {state === "error" && (
        <p>
          The live page did not answer. The rest of this page still works.{" "}
          <button type="button" onClick={() => {
              setState("connecting");
              setSecs(0);
              setAttempt((a) => a + 1);
            }}>
            Try again
          </button>
        </p>
      )}
      {failed && state === "ready" && <p>The live page did not answer just now.</p>}
      {data && (
        <figure style={{ margin: 0 }}>
          <div style={{ position: "relative", width: "100%", aspectRatio: `${data.viewport.w} / ${data.viewport.h}`, opacity: moving ? 0.8 : 1 }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- base64 screenshot, nothing to optimize */}
            <img
              src={`data:image/jpeg;base64,${data.shot}`}
              alt={`Screenshot of the original page at ${heading}`}
              style={{ width: "100%", height: "100%", display: "block", border: "1px solid var(--line)" }}
            />
            {b && (
              <div
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: pct(b.x, data.viewport.w),
                  top: pct(b.y, data.viewport.h),
                  width: pct(b.w, data.viewport.w),
                  height: pct(b.h, data.viewport.h),
                  outline: "4px solid var(--ring)",
                  outlineOffset: 4,
                  borderRadius: 4,
                  transition: calm ? "none" : "left 0.4s ease, top 0.4s ease, width 0.4s ease, height 0.4s ease",
                  pointerEvents: "none",
                }}
              />
            )}
          </div>
          <figcaption>{data.found ? "Live view of the original page" : "Not found on the original page"}</figcaption>
        </figure>
      )}
    </section>
  );
}
