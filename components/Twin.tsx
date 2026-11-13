"use client";
// The whole page below the header: address form, status line, the twin, the reading cursor. Mounted by app/page.tsx.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LivePanel from "@/components/LivePanel";
import Reader from "@/components/Reader";
import Nodes from "@/components/twin/Nodes";
import Results, { type Result } from "@/components/twin/Results";
import { setCommandContext } from "@/lib/client/command";
import { prefetchClip, said, speaker, startWaitTone } from "@/lib/client/reader";
import { pageContext, setContext } from "@/lib/client/voice";
import type { Tour, Twin as TwinData, TwinNode } from "@/lib/types";

const DEFAULT_URL = "https://www.mdpi.com/1424-8220/24/6/1935";
const VIDEO_URL = "https://www.youtube.com/watch?v=EPvd-3712U8";
const LIVE_LINE = "Fetching the page through Bright Data.";

const VIA: Record<TwinData["source"]["via"], string> = {
  cache: "Loaded from the saved copy",
  "browser-api": "Fetched live through the Bright Data Browser API",
  unlocker: "Fetched live through Bright Data Web Unlocker",
  gemini: "Built from the video with Gemini",
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const took = (ms?: number) => (ms == null ? "" : ms < 1000 ? ` in ${ms} milliseconds.` : ` in ${(ms / 1000).toFixed(1)} seconds.`);

export default function Twin() {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [twin, setTwin] = useState<TwinData | null>(null);
  const [found, setFound] = useState<{ query: string; results: Result[] } | null>(null);
  const [status, setStatus] = useState("Choose a page, then press Load.");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [tourId, setTourId] = useState<string | null>(null);

  useEffect(() => prefetchClip(LIVE_LINE), []); // warms the voice so the live line starts at once

  const load = useCallback(async (target: string, live: boolean) => {
    speaker.cancel();
    setBusy(true);
    setFound(null);
    setTourId(null);
    setElapsed(live ? 0 : null);
    setStatus(live ? "Fetching the page through Bright Data." : "Loading the saved copy.");
    let ended = false;
    let stopTone = () => {};
    let timer: ReturnType<typeof setInterval> | undefined;
    if (live) {
      timer = setInterval(() => setElapsed((s) => (s ?? 0) + 1), 1000);
      void speaker.say([LIVE_LINE]).then(() => {
        if (!ended) stopTone = startWaitTone(); // never over the spoken line
      });
    }
    try {
      const res = await fetch("/api/load", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: target, live }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load that page.");
      const t = data as TwinData;
      setTwin(t);
      setStatus(`${VIA[t.source.via]}${took(t.source.ms)}`);
      void speaker.say([`Loaded. ${t.source.title}.`, `${plural(t.counts.sections + t.counts.segments, "section")} and ${plural(t.counts.figures, "figure")}.`, "Use the arrow keys to move."]);
      said(`Loaded ${t.source.title}.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not load that page.";
      setStatus(msg);
      void speaker.say([msg.slice(0, 300)]);
    } finally {
      ended = true;
      stopTone();
      clearInterval(timer);
      setBusy(false);
      setElapsed(null);
    }
  }, []);

  const startTour = useCallback(async (node: TwinNode) => {
    if (!node.image) return;
    const refuse = (msg: string) => {
      setStatus(msg);
      void speaker.say([msg]);
      said(msg);
    };
    if (!node.tour) {
      setStatus(`Looking for a tour of ${node.heading}.`);
      const res = await fetch(`/api/tour?image=${encodeURIComponent(node.image.url)}`).catch(() => null);
      if (!res || res.status === 404) return refuse("No tour for this figure yet.");
      if (!res.ok) return refuse("The tour could not be loaded.");
      const tour = (await res.json().catch(() => null)) as Tour | null;
      if (!tour) return refuse("The tour could not be loaded.");
      setTwin((t) => t && { ...t, nodes: t.nodes.map((n) => (n.id === node.id ? { ...n, tour } : n)) });
    }
    speaker.cancel();
    setStatus(`Touring ${node.heading}.`);
    setTourId(node.id);
    said(`Starting the tour of ${node.heading}.`);
  }, []);

  const leaveTour = useCallback((node: TwinNode) => {
    setTourId(null);
    setStatus("Left the tour.");
    requestAnimationFrame(() => document.getElementById(`fig-${node.id}`)?.focus());
  }, []);

  const search = useCallback(async (query: string) => {
    const res = await fetch("/api/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) }).catch(() => null);
    const data = res?.ok ? ((await res.json().catch(() => null)) as { results?: Result[] } | null) : null;
    if (!data?.results) {
      setStatus("Search is not available right now.");
      void speaker.say(["Search is not available right now."]);
      return said("Search is not available right now.");
    }
    setTourId(null);
    setFound({ query, results: data.results });
    setStatus(`Found ${plural(data.results.length, "result")} for ${query}.`);
    said(`Found ${plural(data.results.length, "result")} for ${query}.`);
    void speaker.say([`Found ${plural(data.results.length, "result")} for ${query}.`]);
  }, []);

  const open = useCallback(
    (target: string) => {
      setUrl(target);
      void load(target, true); // a page that was not prepared has to come live
    },
    [load],
  );

  // Voice commands for the page itself; the cursor ones live in Reader.
  const handlers = useRef({ search, open });
  useEffect(() => {
    handlers.current = { search, open };
  });
  useEffect(() => {
    const onCommand = (e: Event) => {
      const { name, args } = (e as CustomEvent<{ name: string; args?: { query?: string; url?: string } }>).detail ?? {};
      if (name === "search" && args?.query) void handlers.current.search(args.query);
      if (name === "open" && args?.url) handlers.current.open(args.url);
    };
    window.addEventListener("arc:command", onCommand);
    return () => window.removeEventListener("arc:command", onCommand);
  }, []);

  const items = useMemo<TwinNode[]>(
    () =>
      found
        ? found.results.map((r, i) => ({ id: `r${String(i + 1).padStart(2, "0")}`, kind: "section", order: i + 1, level: 2, heading: r.title, text: r.snippet }))
        : (twin?.nodes ?? []),
    [found, twin],
  );

  // The command box (in the page header) decides over what is on screen now.
  useEffect(
    () => setCommandContext(items.map((n) => ({ id: n.id, label: n.kind === "figure" ? `${n.heading}: ${n.text.slice(0, 80)}` : n.heading })), tourId !== null),
    [items, tourId],
  );
  // The question session (Gemini Live) answers from this page, and from the tour when one is open.
  useEffect(() => {
    if (twin) setContext(pageContext(twin, tourId));
  }, [twin, tourId]);

  return (
    <>
      <form
        className="address"
        aria-label="Page to read"
        onSubmit={(e) => {
          e.preventDefault();
          void load(url, false);
        }}
      >
        <label htmlFor="url">Page address</label>
        <input id="url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} required />
        <div className="actions">
          <button type="submit" disabled={busy}>
            Load
          </button>
          <button type="button" disabled={busy} onClick={() => void load(url, true)}>
            Live fetch with Bright Data
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setUrl(VIDEO_URL);
              void load(VIDEO_URL, false);
            }}
          >
            Outline a video
          </button>
        </div>
      </form>

      <p role="status" className="status">
        {status}
      </p>
      {elapsed != null && <p className="elapsed">Waiting for Bright Data: {elapsed} seconds so far.</p>}

      <div id="content" tabIndex={-1}>
        {found ? (
          <Results query={found.query} results={found.results} ids={items.map((i) => i.id)} onOpen={open} onBack={() => setFound(null)} />
        ) : twin ? (
          <>
          <article aria-labelledby="twin-title">
            <h1 id="twin-title">{twin.source.title}</h1>
            {twin.source.credit && <p className="credit">{twin.source.credit}</p>}
            <p>
              <a href={twin.source.url}>Original page</a>
            </p>
            <p className="overview">
              This page has {plural(twin.counts.sections, "section")}
              {twin.counts.figures > 0 && `, ${plural(twin.counts.figures, "figure")}`}
              {twin.counts.segments > 0 && `, ${plural(twin.counts.segments, "video segment")}`}.
            </p>
            <Nodes nodes={twin.nodes} pageUrl={twin.source.kind === "page" ? twin.source.url : undefined} tourId={tourId} onTour={(n) => void startTour(n)} onLeave={leaveTour} />
          </article>
          {twin.source.kind === "page" && (
            <div className="arc-live">
              <LivePanel url={twin.source.url} />
            </div>
          )}
          </>
        ) : (
          <h1>Arc</h1>
        )}
      </div>

      {items.length > 0 && <Reader key={found ? `found:${found.query}` : twin?.id} items={items} paused={tourId !== null} onTour={(n) => void startTour(n)} />}
    </>
  );
}
