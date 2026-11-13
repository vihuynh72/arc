"use client";
// The whole page below the header: status line, the twin, the reading cursor. Mounted by app/page.tsx.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Landing from "@/components/Landing";
import LivePanel from "@/components/LivePanel";
import Reader from "@/components/Reader";
import Nodes from "@/components/twin/Nodes";
import Results, { type Result } from "@/components/twin/Results";
import { setCommandContext, submitUtterance } from "@/lib/client/command";
import { voiceFirst } from "@/lib/client/display";
import { findNode, prefetchClip, said, speaker, startWaitTone } from "@/lib/client/reader";
import { pageContext, setContext, stop as stopVoice, tourContext } from "@/lib/client/voice";
import type { Tour, Twin as TwinData, TwinNode } from "@/lib/types";

const LIVE_LINE = "Fetching the page through Bright Data.";
const VIDEO = /youtube\.com|youtu\.be|\.(mp4|webm|mov)(\?|$)/i; // same rule as isVideoUrl in lib/server/video.ts
const SAVED_MS = 700; // a saved copy answers well inside this; past it, the page is coming live

const VIA: Record<TwinData["source"]["via"], string> = {
  cache: "Loaded from the saved copy",
  "browser-api": "Fetched live through the Bright Data Browser API",
  unlocker: "Fetched live through Bright Data Web Unlocker",
  gemini: "Built from the video with Gemini",
  direct: "Loaded directly",
  browser: "Read from your open tab",
};
const host = (u = "") => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const took = (ms?: number) => (ms == null ? "." : ms < 50 ? " instantly." : ms < 1000 ? ` in ${plural(ms, "millisecond")}.` : ` in ${(ms / 1000).toFixed(1)} seconds.`);
const NEXT_STEP = "Paste another link, or hold Space and ask for a paper.";
const FULL_LINE = "Loading the full page through Bright Data.";
const VIDEO_LINE = "Outlining the video with Gemini.";
// A stored copy is only the first view: the live page is fetched at once and swapped in (lib/server/fetch.ts).
const SAVED_LINE = "Saved copy from earlier. Fetching the live page.";
const LIVE_READY = "The live page is ready.";
const LIVE_FAILED = "I could not reach the live page. This is the saved copy from earlier.";
const LIVE_BUDGET_MS = 45_000; // the server gives Bright Data 25 s, then answers with the stored copy (treated as a failure)
type Route = "brightdata" | "direct";
const routeWords = (r: Route | TwinData["source"]["via"]) => (r === "direct" ? "directly" : "through Bright Data");
const seconds = (ms = 0) => `${ms >= 10_000 ? Math.round(ms / 1000) : (ms / 1000).toFixed(1)} seconds`;

type Hint = { title: string; snippet: string };
type Preview = TwinData & { from: string };
type Batch = { results?: Result[]; via?: string; ms?: number; error?: string };
const counted = (t: TwinData) =>
  `${plural(t.counts.sections + t.counts.segments, t.counts.segments ? "part" : "section")}${t.counts.figures ? `, ${plural(t.counts.figures, "figure")}` : ""}`;
// shortcut: reads Speaker's private audio element to find the gap between two sentences; a public hook on Speaker would be cleaner.
const sentenceEnd = () =>
  new Promise<void>((done) => {
    const t0 = performance.now();
    const tick = () => (!(speaker as unknown as { audio: unknown }).audio || performance.now() - t0 > 8000 ? done() : void setTimeout(tick, 100));
    tick();
  });

export default function Twin() {
  const [twin, setTwin] = useState<TwinData | null>(null);
  const [found, setFound] = useState<{ query: string; results: Result[] } | null>(null);
  const [status, setStatus] = useState("Paste a link, or tell Arc what you want.");
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [tourId, setTourId] = useState<string | null>(null);
  // Put the reading cursor on this node once it is on screen (a silent goto), then speak the lines.
  const [cursorTo, setCursorTo] = useState<{ id: string; lines: string[]; then?: () => void } | null>(null);
  const seq = useRef(0); // the newest load or search; an older one never swaps its result in
  const cursorHeading = useRef<string | null>(null);
  const cursorId = useRef<string | null>(null);
  const lastContext = useRef("");
  const prioritised = useRef(new Set<string>()); // figures whose analysis was moved up the server's queue
  const twinRef = useRef<TwinData | null>(null);
  const tourRef = useRef<string | null>(null);
  useEffect(() => {
    twinRef.current = twin;
    tourRef.current = tourId;
  }, [twin, tourId]);

  // Voice first: a status line nobody said is said once, in its own words, when the voice is free (never over another line).
  useEffect(() => {
    if (!voiceFirst()) return;
    const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const mine = words(status);
    const t0 = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      if (document.querySelector("[data-tour]")) return; // the tour has its own voice: never two at once
      if (speaker.busy) return void (Date.now() - t0 < 8000 && (timer = setTimeout(check, 300)));
      if (speaker.recent.some((r) => Date.now() - r.at < 10_000 && (words(r.text).includes(mine) || mine.includes(words(r.text))))) return;
      void speaker.say([status]);
    };
    timer = setTimeout(check, 600);
    return () => clearTimeout(timer);
  }, [status]);

  // Warms the voice so these fixed lines start at once.
  useEffect(() => [LIVE_LINE, FULL_LINE, VIDEO_LINE, NEXT_STEP, SAVED_LINE, LIVE_READY, LIVE_FAILED, "Use the arrow keys, or say open the first one.", "Use the arrow keys, or hold Space and ask."].forEach(prefetchClip), []);
  useEffect(() => {
    const onCursor = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; heading: string }>).detail;
      cursorHeading.current = d?.heading ?? null;
      cursorId.current = d?.id ?? null;
      // The cursor landed on a figure (arrow, scroll, command): its analysis jumps the queue, once per figure.
      const url = twinRef.current?.nodes.find((n) => n.id === d?.id)?.image?.url;
      if (url && !prioritised.current.has(url)) {
        prioritised.current.add(url);
        void fetch("/api/tour/prioritise", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: url }) }).catch(() => {});
      }
    };
    window.addEventListener("arc:cursor", onCursor);
    return () => window.removeEventListener("arc:cursor", onCursor);
  }, []);
  useEffect(() => {
    if (!cursorTo) return;
    window.dispatchEvent(new CustomEvent("arc:command", { detail: { name: "goto", args: { id: cursorTo.id, silent: true } } }));
    if (!cursorTo.lines.length) return; // a silent move: whatever is being read carries on
    said(cursorTo.lines.join(" "));
    void speaker.say(cursorTo.lines).then(cursorTo.then);
  }, [cursorTo]); // each request is a new object, so it runs once per request

  // Swap a newer copy in without yanking: the sentence being spoken ends first, the cursor stays on the item with the
  // same heading, tours already fetched carry over, and an open tour stays open while its figure is still there.
  // lines: spoken where the cursor lands; none keeps the reading going. Returns false when a newer load took over.
  const swapIn = useCallback(async (t: TwinData, mine: number, lines: string[], skipHeading?: string) => {
    const at = cursorHeading.current;
    await sentenceEnd();
    if (mine !== seq.current) return false;
    const old = twinRef.current;
    const tours = new Map((old?.nodes ?? []).flatMap((n) => (n.image && n.tour ? [[n.image.url, n.tour] as const] : [])));
    const nodes = t.nodes.map((n) => (!n.tour && n.image && tours.has(n.image.url) ? { ...n, tour: tours.get(n.image.url) } : n));
    const open = old?.nodes.find((n) => n.id === tourRef.current);
    const still = open?.image && nodes.find((n) => n.image?.url === open.image?.url && n.tour);
    setTwin({ ...t, nodes });
    if (still) {
      setTourId(still.id); // the tour keeps its own voice; the cursor stays on its figure
      return true;
    }
    if (open) {
      stopVoice();
      setTourId(null);
    }
    const i = at && at !== skipHeading ? findNode(nodes, at) : -1;
    const id = nodes[Math.max(i, 0)]?.id;
    if (id && (lines.length || id !== cursorId.current)) setCursorTo({ id, lines });
    return true;
  }, []);

  // A stored copy is on screen: fetch the live page now and swap it in; say one line only when something changed.
  const revalidate = useCallback(
    async (target: string, mine: number, stored: TwinData) => {
      let t: TwinData | null = null;
      try {
        const res = await fetch("/api/load", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: target, live: true }), signal: AbortSignal.timeout(LIVE_BUDGET_MS) });
        const d = (await res.json()) as TwinData;
        if (res.ok && d.nodes?.length && d.source?.via !== "cache") t = d; // "cache" back from a live ask: Bright Data ran out of time
      } catch {
        // offline, timed out or refused: the stored copy stays
      }
      if (mine !== seq.current) return;
      if (!t) {
        setStatus(LIVE_FAILED);
        // A fast failure (no network) lands while the saved copy is being introduced: let that finish first, up to 8 s.
        for (let i = 0; speaker.busy && i < 80; i++) await new Promise((r) => setTimeout(r, 100));
        await sentenceEnd();
        if (mine === seq.current) void speaker.say([LIVE_FAILED]);
        return;
      }
      const changed = t.source.title !== stored.source.title || counted(t) !== counted(stored);
      if (!(await swapIn(t, mine, changed ? [LIVE_READY] : []))) return;
      setStatus(`Live page loaded ${routeWords(t.source.via)} in ${seconds(t.source.ms)}.`);
    },
    [swapIn],
  );

  // live: skip the saved copy. Otherwise the saved copy if there is one, else the server fetches live itself.
  // With no saved copy, a quick preview (/api/preview, asked at the same time) is shown and read while the full page loads.
  const load = useCallback(async (target: string, live: boolean, hint?: Hint) => {
    const mine = ++seq.current;
    speaker.cancel();
    setFound(null);
    setTourId(null);
    cursorHeading.current = null;
    const video = VIDEO.test(target);
    setStatus(video ? "Outlining the video." : live ? LIVE_LINE : "Loading.");
    let ended = false;
    let shown: Preview | null = null;
    let stopTone = () => {};
    let timer: ReturnType<typeof setInterval> | undefined;
    const tone = () => void (!ended && (stopTone = startWaitTone())); // never over a spoken line
    const counter = () => {
      if (video) return;
      setElapsed(0);
      timer = setInterval(() => setElapsed((s) => (s ?? 0) + 1), 1000);
    };
    const preview: Promise<Preview | null> = live
      ? Promise.resolve(null)
      : fetch("/api/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: target, hint }) })
          .then((r) => (r.status === 200 ? (r.json() as Promise<Preview>) : null))
          .catch(() => null);
    // No saved copy came back quickly: show the preview if there is one, say why there is a wait, then a soft tone and a counter.
    const waiting = async () => {
      const p = await preview;
      if (ended || mine !== seq.current) return;
      if (p?.nodes?.length) {
        shown = p;
        setTwin(p);
        const line = video ? VIDEO_LINE : FULL_LINE;
        setStatus(`Preview from ${p.from}. ${line}`);
        counter();
        return setCursorTo({ id: p.nodes[0].id, lines: [`${p.source.title}.`, line], then: tone });
      }
      if (video) return void speaker.say(["Outlining the video with Gemini. This takes a moment."]).then(tone);
      setStatus(LIVE_LINE);
      counter();
      void speaker.say([LIVE_LINE]).then(tone);
    };
    const soon = setTimeout(() => void waiting(), live ? 0 : SAVED_MS);
    const finish = () => {
      ended = true;
      clearTimeout(soon);
      stopTone();
      stopTone = () => {}; // finish runs again in finally; a closed AudioContext throws on a second close
      clearInterval(timer);
      setElapsed(null);
    };
    try {
      const res = await fetch("/api/load", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: target, live }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load that page.");
      const t = data as TwinData;
      finish();
      if (mine !== seq.current) return;
      const was = shown as Preview | null;
      if (was && !t.nodes.length) {
        // The parser found no sections (it knows MDPI's layout best): the preview is still the better page.
        const line = `${VIA[t.source.via]}${took(t.source.ms)} Arc could not find sections in it, so the preview stays.`;
        setStatus(line);
        await sentenceEnd();
        if (mine === seq.current) void speaker.say(["The full page came back, but Arc could not find sections in it. The preview stays."]);
        return;
      }
      if (was) {
        if (await swapIn(t, mine, [`The full ${video ? "outline" : "page"} is ready. ${counted(t)}.`], was.source.title)) setStatus(`${VIA[t.source.via]}${took(t.source.ms)}`);
        return;
      }
      setTwin(t);
      const next = (data as { live?: Route }).live;
      if (t.source.via === "cache" && next) {
        setStatus(`Saved copy shown. Fetching the live page ${routeWords(next)}…`);
        void speaker.say([SAVED_LINE, `${t.source.title}.`, `${counted(t).replace(", ", " and ")}.`, "Use the arrow keys, or hold Space and ask."]);
        said(`Loaded ${t.source.title}.`);
        void revalidate(target, mine, t);
        return;
      }
      setStatus(`${VIA[t.source.via]}${took(t.source.ms)}`);
      void speaker.say([`${t.source.via === "cache" ? "Saved copy." : "Loaded."} ${t.source.title}.`, `${counted(t).replace(", ", " and ")}.`, "Use the arrow keys, or hold Space and ask."]);
      said(`Loaded ${t.source.title}.`);
    } catch (e) {
      finish();
      if (mine !== seq.current) return;
      const msg = e instanceof Error ? e.message : "Could not load that page.";
      const kept = shown as Preview | null;
      setStatus(kept ? `${msg} Showing the preview from ${kept.from}.` : `${msg} ${NEXT_STEP}`);
      void speaker.say([`${/[.!?]$/.test(msg) ? msg : `${msg}.`}`.slice(0, 300), kept ? "The preview stays on screen." : NEXT_STEP]);
    } finally {
      finish();
    }
  }, [revalidate, swapIn]);

  const startTour = useCallback(async (node: TwinNode) => {
    if (!node.image) return;
    const refuse = (msg: string) => {
      setStatus(msg);
      void speaker.say([msg]);
      said(msg);
    };
    if (!node.tour) {
      setStatus(`Looking for a tour of ${node.heading}.`);
      void speaker.say(["Looking at this figure."]);
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
    void speaker.say(["Left the tour."]);
    requestAnimationFrame(() => document.getElementById(`fig-${node.id}`)?.focus());
  }, []);

  // Results stream in batches (OpenAlex first, usually under a second; then the Bright Data web search). The first batch
  // is shown and read; later ones are appended below without moving the cursor or renumbering.
  const search = useCallback(async (query: string) => {
    const mine = ++seq.current;
    const fail = () => {
      setStatus("Search is not available right now.");
      void speaker.say(["Search is not available right now."]);
      said("Search is not available right now.");
    };
    const res = await fetch("/api/search", { method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson" }, body: JSON.stringify({ query }) }).catch(() => null);
    if (!res?.ok || !res.body) return fail();
    let total = 0;
    let errored = false;
    let earlier = false; // saved results from an earlier search are on screen; the first live batch replaces or extends them
    let liveSeen = false;
    const take = (b: Batch) => {
      if (mine !== seq.current) return;
      if (!b.results) return void (errored = true);
      const n = b.results.length;
      if (!n) return;
      const results = b.results;
      const where = b.via === "openalex" ? "papers from OpenAlex open metadata" : "web results through Bright Data";
      if (b.via === "cache") {
        if (total) return;
        earlier = true;
        total = n;
        setTourId(null);
        setFound({ query, results });
        setStatus("Results from earlier. Searching live.");
        setCursorTo({ id: "r01", lines: [`${plural(n, "result")} from earlier for ${query}. Searching live.`, "Use the arrow keys, or say open the first one."] });
        return;
      }
      if (earlier) {
        // Replace only while the cursor is still on the first result (opening one starts a load, which ends this search).
        const untouched = !cursorId.current || cursorId.current === "r01";
        const first = !liveSeen;
        liveSeen = true;
        setFound((f) => {
          if (!f) return f;
          if (first && untouched) return { ...f, results };
          const key = (r: Result) => r.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); // same paper, other home
          const have = new Set(f.results.flatMap((r) => [r.url, key(r)]));
          const add = results.filter((r) => !have.has(r.url) && !have.has(key(r)) && have.add(r.url).add(key(r)));
          return { ...f, results: [...f.results, ...add] }; // never renumber what is on screen
        });
        setStatus(`Live results ${b.via === "openalex" ? "from OpenAlex" : "through Bright Data"} in ${seconds(b.ms)}.`);
        total += n;
        return;
      }
      if (!total) {
        setTourId(null);
        setFound({ query, results });
        setStatus(`${plural(n, "result")} so far for ${query}: ${where}.`); // the status line stays short; the voice instructs
        setCursorTo({ id: "r01", lines: [`${plural(n, "result")} so far for ${query}.`, "Use the arrow keys, or say open the first one."] }); // two clips: the short first one plays sooner
      } else {
        setFound((f) => f && { ...f, results: [...f.results, ...results] });
        setStatus(`Added ${n} ${where}.`);
      }
      total += n;
    };
    try {
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          take(JSON.parse(buf.slice(0, nl)) as Batch);
          buf = buf.slice(nl + 1);
        }
      }
    } catch {
      errored = true;
    }
    if (earlier && !liveSeen && mine === seq.current) setStatus("The live search did not answer. These are results from earlier.");
    if (total || mine !== seq.current) return;
    if (errored) return fail();
    setTourId(null);
    setFound({ query, results: [] });
    const line = `No results for ${query}. Hold Space and try other words.`;
    setStatus(`No results for ${query}.`);
    said(line);
    void speaker.say([line]);
  }, []);

  // A result keeps its title and snippet so the preview has something to show even when the page itself is slow.
  const open = useCallback(
    (target: string) => {
      const r = handlers.current.found?.results.find((x) => x.url === target);
      void load(target, false, r && { title: r.title, snippet: r.snippet });
    },
    [load],
  );

  // Commands for the page itself (typed, spoken, or from the one box); the cursor ones live in Reader.
  // /?doc=<id>: a page the Arc extension read from the student's own tab (app/api/ingest/route.ts); nothing is fetched.
  const loadDoc = useCallback(async (id: string) => {
    const mine = ++seq.current;
    setFound(null);
    setTourId(null);
    setStatus("Opening the page from your tab.");
    try {
      const res = await fetch(`/api/ingest?id=${encodeURIComponent(id)}`);
      const t = res.ok ? ((await res.json()) as TwinData) : null;
      if (mine !== seq.current) return;
      if (!t?.nodes?.length) throw new Error(`ingest ${res.status}`);
      setTwin(t); // kept on screen if the other way fails too (load() leaves the twin alone on an error)
      if (t.counts.sections < 2 && /^https?:\/\//i.test(t.source.url)) {
        // The tab's HTML gave a useless parse (one section): read the page the normal way (MDPI through Bright Data).
        setStatus("Reading this page another way.");
        await speaker.say(["Reading this page another way."]);
        if (mine === seq.current) await load(t.source.url, false);
        return;
      }
      setStatus(`${VIA[t.source.via] ?? "Read from your open tab"}.`);
      void speaker.say([`Read from your tab. ${t.source.title}.`, `${counted(t).replace(", ", " and ")}.`, "Use the arrow keys, or hold Space and ask."]);
      said(`Loaded ${t.source.title}.`);
    } catch (e) {
      console.warn("Arc: could not open the page from the tab.", e);
      if (mine !== seq.current) return;
      const line = "I could not open that page from your tab. Try the shortcut again.";
      setStatus(line);
      void speaker.say([line]);
      said(line);
    }
  }, [load]);

  // Deep links, so nobody has to paste: /?url=<link>, /?q=<request>, /?doc=<id> (the extension), /?notice=restricted.
  // Read once per page (Strict Mode runs effects twice). ?doc and ?url stay in the address: they name the page on
  // screen, so a reload (or a dev hot reload) opens it again instead of the landing screen. ?q and ?notice are
  // one-shot and are cleared once handled.
  const deepLink = useRef(false);
  useEffect(() => {
    if (deepLink.current) return;
    deepLink.current = true;
    const p = new URLSearchParams(location.search);
    const [url, q, doc] = [p.get("url"), p.get("q"), p.get("doc")];
    // An empty or non-web ?url= comes from an older extension that could not read the tab (chrome://, New Tab page).
    const notice = p.get("notice") ?? (p.has("url") && !/^https?:\/\//i.test(url ?? "") ? "restricted" : null);
    if (!url && !q && !doc && !notice) return;
    // Keep Next's own history state: replacing it with null makes the router put the old URL back.
    const clear = () => !doc && !url && history.replaceState(history.state, "", location.pathname);
    const restricted = async () => {
      const line = "Chrome does not let extensions read that page. Open a normal web page and try again.";
      setStatus(line);
      void speaker.say([line]);
      said(line);
    };
    // After this effect, not inside it (React's rule against setState in an effect body).
    void Promise.resolve()
      .then((): Promise<unknown> | undefined => (doc ? loadDoc(doc) : url && /^https?:\/\//i.test(url) ? load(url, false) : q ? submitUtterance(q) : notice ? restricted() : undefined))
      .catch(() => {})
      .finally(clear);
  }, [load, loadDoc]);

  const handlers = useRef({ search, open, load, found, twin, tourId, leaveTour });
  useEffect(() => {
    handlers.current = { search, open, load, found, twin, tourId, leaveTour };
  });
  useEffect(() => {
    const onCommand = (e: Event) => {
      const { name, args } = (e as CustomEvent<{ name: string; args?: { query?: string; url?: string; id?: string; at?: number } }>).detail ?? {};
      const h = handlers.current;
      if (name === "search" && args?.query) void h.search(args.query);
      if (name === "load" && args?.url) void h.load(args.url, false);
      if (name === "refresh" && h.twin) void h.load(h.twin.source.url, true);
      if (name === "open") {
        // A result id from Snap ("open the second one"), or a full address from the voice model.
        // at: the result under the cursor, or a counted one ("open the second one"), from the local grammar.
        const url = args?.url ?? h.found?.results[typeof args?.at === "number" ? args.at : Number(args?.id?.slice(1)) - 1]?.url;
        if (url) h.open(url);
      }
      if (name === "leave") {
        const node = h.twin?.nodes.find((n) => n.id === h.tourId);
        if (node) {
          stopVoice();
          h.leaveTour(node);
        } else if (h.found && h.twin) {
          setFound(null);
          void speaker.say([`Back to ${h.twin.source.title}.`]);
        } else void speaker.say(["There is nothing to leave."]);
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
        { mode: found ? "results" : !twin ? "landing" : twin.counts.segments ? "video" : "article", title: found ? `search results for ${found.query}` : (twin?.source.title ?? "") },
      ),
    [items, tourId, found, twin],
  );
  // The question session (Gemini Live) answers from this page's outline (stable: a new one reopens the session), plus
  // where the student is now and the open tour (volatile: sent with each question, never a reopen), so "this", "that"
  // and "why" have a referent. Sent at most every 500 ms and only when it changed.
  useEffect(() => {
    if (!twin && !found) return;
    const page = found
      ? `Search results for ${found.query}:\n${found.results.map((r, i) => `Result ${i + 1}: ${r.title}. ${r.snippet.slice(0, 200)}`).join("\n")}`.slice(0, 6000)
      : pageContext(twin!);
    let sent = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = () => {
      const i = items.findIndex((n) => n.id === cursorId.current);
      const n = items[i];
      const stop = tourId ? document.querySelector("[data-tour] p")?.textContent?.trim() : "";
      const where = [
        "WHERE THE STUDENT IS NOW (\"this\", \"that\", \"here\" and \"it\" mean this):",
        `Mode: ${tourId ? "figure tour" : found ? "search results" : twin?.counts.segments ? "video outline" : "article"}.`,
        n ? `Current item, ${i + 1} of ${items.length}: ${n.heading}${n.kind === "figure" ? " (figure)" : ""}. ${n.text.slice(0, 600)}` : "No item yet: the student is at the top.",
        n && items[i - 1] ? `Previous item: ${items[i - 1].heading}.` : "",
        n && items[i + 1] ? `Next item: ${items[i + 1].heading}.` : "",
        twin && !found ? tourContext(twin, tourId) : "",
        stop ? `Current tour stop: ${stop.slice(0, 400)}` : "",
      ].filter(Boolean).join("\n");
      const text = `${page}\n\n${where}`;
      if (text !== sent && text !== lastContext.current) {
        sent = lastContext.current = text;
        setContext(page, where);
      }
    };
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(send, 500);
    };
    soon();
    window.addEventListener("arc:cursor", soon);
    window.addEventListener("arc:command", soon);
    window.addEventListener("keyup", soon); // tour keys move stops without a command event
    return () => {
      clearTimeout(timer);
      window.removeEventListener("arc:cursor", soon);
      window.removeEventListener("arc:command", soon);
      window.removeEventListener("keyup", soon);
    };
  }, [twin, tourId, found, items]);

  return (
    <>
      <p role="status" className="status">
        {status}
      </p>
      {elapsed != null && <p className="elapsed">Waiting for Bright Data: {elapsed} seconds so far.</p>}

      <div id="content" tabIndex={-1}>
        {found ? (
          <Results query={found.query} results={found.results} ids={items.map((i) => i.id)} onOpen={open} onBack={twin ? () => setFound(null) : undefined} />
        ) : twin ? (
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
        ) : (
          <Landing />
        )}
      </div>
      {/* A direct child of <main>, so on wide screens it takes the right column (app/globals.css). */}
      {!found && twin?.source.kind === "page" && twin.source.via !== "browser" && (
        <div className="arc-live">
          <LivePanel url={twin.source.url} />
        </div>
      )}

      {items.length > 0 && <Reader key={found ? `found:${found.query}` : twin?.id} items={items} paused={tourId !== null} onTour={(n) => void startTour(n)} />}
    </>
  );
}
