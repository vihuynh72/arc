"use client";
// Read-only live view of the original page, through the Bright Data Browser API. Used by the figure tour/reader.
import { useState } from "react";

type Shot = { shot: string; viewport: { w: number; h: number }; box: { x: number; y: number; w: number; h: number } | null };

export default function RemoteView({ url, figure }: { url: string; figure: number }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [data, setData] = useState<Shot | null>(null);

  async function show() {
    setState("loading");
    try {
      const res = await fetch("/api/remote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, figure }) });
      const body = await res.json();
      if (!res.ok || !body.shot) throw new Error();
      setData(body);
      setState("done");
    } catch {
      setState("error");
    }
  }

  return (
    <div>
      <button type="button" onClick={show} disabled={state === "loading"}>
        {state === "loading" ? "Opening the real page…" : "Show on the real page"}
      </button>
      <p style={{ margin: "0.5rem 0" }}>
        {state === "loading" && "Opening the real page, this can take about 15 seconds."}
        {state === "error" && "The live page did not answer. The rest of this page still works."}
      </p>
      {state === "done" && data && (
        <figure style={{ margin: 0 }}>
          <div style={{ position: "relative", maxWidth: data.viewport.w, aspectRatio: `${data.viewport.w} / ${data.viewport.h}` }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- base64 screenshot, nothing to optimize */}
            <img
              src={`data:image/jpeg;base64,${data.shot}`}
              alt={`Screenshot of the original page showing figure ${figure}`}
              style={{ width: "100%", height: "100%", display: "block", border: "1px solid var(--line)" }}
            />
            {data.box && (
              <div
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: `${(data.box.x / data.viewport.w) * 100}%`,
                  top: `${(data.box.y / data.viewport.h) * 100}%`,
                  width: `${(data.box.w / data.viewport.w) * 100}%`,
                  height: `${(data.box.h / data.viewport.h) * 100}%`,
                  outline: "4px solid var(--ring)",
                  outlineOffset: 4,
                  borderRadius: 4,
                }}
              />
            )}
          </div>
          <figcaption>Live view of the original page, through Bright Data</figcaption>
        </figure>
      )}
    </div>
  );
}
