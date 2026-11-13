"use client";
// The whole page below the header: status line, the twin, the reading cursor. Mounted by app/page.tsx.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LivePanel from "@/components/LivePanel";
import Reader from "@/components/Reader";
import Nodes from "@/components/twin/Nodes";
import Results, { type Result } from "@/components/twin/Results";
import { setCommandContext } from "@/lib/client/command";
import { prefetchClip, said, speaker, startWaitTone } from "@/lib/client/reader";
import { pageContext, setContext } from "@/lib/client/voice";
import type { Tour, Twin as TwinData, TwinNode } from "@/lib/types";

const LIVE_LINE = "Fetching the page through Bright Data.";
const VIDEO = /youtube\.com|youtu\.be|\.(mp4|webm|mov)(\?|$)/i; // same rule as isVideoUrl in lib/server/video.ts
const SAVED_MS = 700; // a saved copy answers well inside this; past it, the page is coming live

const VIA: Record<TwinData["source"]["via"], string> = {
  cache: "Loaded from the saved copy",
  "browser-api": "Fetched live through the Bright Data Browser API",
  unlocker: "Fetched live through Bright Data Web Unlocker",
  gemini: "Built from the video with Gemini",
};
const host = (u = "") => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const took = (ms?: number) => (ms == null ? "" : ms < 1000 ? ` in ${ms} milliseconds.` : ` in ${(ms / 1000).toFixed(1)} seconds.`);

export default function Twin() {
  const [twin, setTwin] = useState<TwinData | null>(null);
  const [found, setFound] = useState<{ query: string; results: Result[] } | null>(null);
  const [status, setStatus] = useState("Paste a link, or tell Arc what you want.");
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [tourId, setTourId] = useState<string | null>(null);

  useEffect(() => prefetchClip(LIVE_LINE), []); // warms the voice so the live line starts at once

  // live: skip the saved copy. Otherwise the saved copy if there is one, else the server fetches live itself.
  const load = useCallback(async (target: string, live: boolean) => {
    speaker.cancel();
    setFound(null);
    setTourId(null);
    const video = VIDEO.test(target);
    setStatus(video ? "Outlining the video." : live ? LIVE_LINE : "Loading.");
    let ended = false;
    let stopTone = () => {};
    let timer: ReturnType<typeof setInterval> | undefined;
    // No saved copy came back quickly: say why there is a wait, then a soft tone and a counter until it arrives.
    const waiting = () => {
      if (ended) return;
      if (video) return void (stopTone = startWaitTone());
      setStatus(LIVE_LINE);
      setElapsed(0);
      timer = setInterval(() => setElapsed((s) => (s ?? 0) + 1), 1000);
      void speaker.say([LIVE_LINE]).then(() => {
        if (!ended) stopTone = startWaitTone(); // never over the spoken line
      });
    };
    const soon = setTimeout(waiting, live ? 0 : SAVED_MS);
    try {
      const res = await fetch("/api/load", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: target, live }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load that page.");
      const t = data as TwinData;
      setTwin(t);
      setStatus(`${VIA[t.source.via]}${took(t.source.ms)}`);
      void speaker.say([`${t.source.via === "cache" ? "Saved copy." : "Loaded."} ${t.source.title}.`, `${plural(t.counts.sections + t.counts.segments, "section")} and ${plural(t.counts.figures, "figure")}.`, "Use the arrow keys to move."]);
      said(`Loaded ${t.source.title}.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not load that page.";
      setStatus(msg);
      void speaker.say([msg.slice(0, 300)]);
    } finally {
      ended = true;
      clearTimeout(soon);
      stopTone();
      clearInterval(timer);
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

  const open = useCallback((target: string) => void load(target, false), [load]);

  // Commands for the page itself (typed, spoken, or from the one box); the cursor ones live in Reader.
  const handlers = useRef({ search, open, load, found, twin });
  useEffect(() => {
    handlers.current = { search, open, load, found, twin };
  });
  useEffect(() => {
    const onCommand = (e: Event) => {
      const { name, args } = (e as CustomEvent<{ name: string; args?: { query?: string; url?: string; id?: string } }>).detail ?? {};
      const h = handlers.current;
      if (name === "search" && args?.query) void h.search(args.query);
      if (name === "load" && args?.url) void h.load(args.url, false);
      if (name === "refresh" && h.twin) void h.load(h.twin.source.url, true);
      if (name === "open") {
        // A result id from Snap ("open the second one"), or a full address from the voice model.
        const url = args?.url ?? h.found?.results[Number(args?.id?.slice(1)) - 1]?.url;
        if (url) h.open(url);
      }
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
    () =>
      setCommandContext(
        items.map((n, i) => ({
          id: n.id,
          // Results carry their number and site, so "the second one" and "the one from PubMed" can be picked.
          label: found ? `Result ${i + 1}: ${n.heading} (${host(found.results[i]?.url)})` : n.kind === "figure" ? `${n.heading}: ${n.text.slice(0, 80)}` : n.heading,
        })),
        tourId !== null,
      ),
    [items, tourId, found],
  );
  // The question session (Gemini Live) answers from this page, and from the tour when one is open.
  useEffect(() => {
    if (twin) setContext(pageContext(twin, tourId));
  }, [twin, tourId]);

  return (
    <>
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
          <>
            <h1>Arc</h1>
            <p>Things to try:</p>
            <ul>
              <li>Say: find a paper about knee rehabilitation.</li>
              <li>Paste the link to a study page, such as https://www.mdpi.com/1424-8220/24/6/1935</li>
              <li>Paste a YouTube link, and Arc outlines the video.</li>
            </ul>
          </>
        )}
      </div>

      {items.length > 0 && <Reader key={found ? `found:${found.query}` : twin?.id} items={items} paused={tourId !== null} onTour={(n) => void startTour(n)} />}
    </>
  );
}
