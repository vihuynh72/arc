"use client";
// The whole page below the header: status line, the twin, the reading cursor. Mounted by app/page.tsx.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Landing from "@/components/Landing";
import Pointer from "@/components/Pointer";
import LivePanel from "@/components/LivePanel";
import Reader from "@/components/Reader";
import VideoPlayer from "@/components/VideoPlayer";
import Nodes from "@/components/twin/Nodes";
import Results, { namedSites, preferSource, resultLine, resultSummary, siteName, type Result } from "@/components/twin/Results";
import { narrowSearch, searchDone, searchPending, searchStarted, takePendingOpen } from "@/lib/client/narrow";
import { contentWords } from "@/lib/server/search";
import { inputStyle, setCommandContext, submitUtterance, turnNow, watchTurn } from "@/lib/client/command";
import { voiceFirst } from "@/lib/client/display";
import { cue, hearAgain, OPENING, opening, resultsTail, sectionNo, videoPlay } from "@/lib/keys";
import { LANDING_LINE } from "@/lib/intent";
import { useFocusVoice } from "@/lib/client/focusVoice";
import { type Chunk, findNode, prefetchClip, probeLanguage, said, speaker, splitSentences, startWaitTone } from "@/lib/client/reader";
import { fetchPage, isPdfFile, mergePage, pdfIntro, usePdf, watchPdfFiles, withFigures } from "@/lib/client/pdf";
import { addressFor, clearGone, dropPlace, GONE_LINE, isPublic, markGone, type Place, readPlace, takeGone, updatePlace, worthKeeping } from "@/lib/client/place";
import { keepRecentPlace, rememberRecent } from "@/lib/client/recent";
import { usePageFix } from "@/lib/client/pageFix";
import { type Late, mergeLate, saidTime, segmentsOf, videoIntro } from "@/lib/client/video";
import { pageContext, setContext, stop as stopVoice, tourContext } from "@/lib/client/voice";
import { helperAllowed, helperId, helperRead, isSignInError, LINES as HELPER, receivePage } from "@/lib/client/helper";
import type { Tour, Twin as TwinData, TwinNode } from "@/lib/types";

const LIVE_LINE = "Fetching the page through Bright Data.";
// Only a guess before the answer arrives (status lines while waiting). Once a twin is back, t.video / t.source.kind decide.
const VIDEO = /youtube\.com|youtu\.be|khanacademy\.org\/.*\/v\/|\.(mp4|webm|mov)(\?|$)/i;
const SAVED_MS = 700; // a saved copy answers well inside this; past it, the page is coming live

const VIA: Record<TwinData["source"]["via"], string> = {
  cache: "Loaded from the saved copy",
  "browser-api": "Fetched live through the Bright Data Browser API",
  unlocker: "Fetched live through Bright Data Web Unlocker",
  gemini: "Built from the video with Gemini",
  direct: "Loaded directly",
  browser: "Read from your open tab",
  "open-copy": "Read from a legal open copy of the paper",
  "open-index": "Built from an open scholarly index",
};
const host = (u = "") => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
// "Reading line graphs | Applying mathematical reasoning | Khan Academy" -> "Reading line graphs": the rest is the site's breadcrumb.
export const cleanTitle = (t: string) => {
  const [first, ...rest] = t.split(" | ");
  return rest.length && first.trim().length >= 6 ? first.trim() : t;
};
const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const span = (s: number) => [Math.floor(s / 60) && plural(Math.floor(s / 60), "minute"), Math.round(s % 60) && plural(Math.round(s % 60), "second")].filter(Boolean).join(" ") || "under a second";
// One plain line under the title: what this is and how big. Timing and where it came from are for ?debug=1 only.
const summary = (t: TwinData) =>
  t.video
    ? `Lecture, ${span(t.video.duration)}, ${plural(t.counts.segments, "part")}.`
    : t.pdf
      ? `PDF, ${plural(t.pdf.pages, "page")}.`
      : `This page has ${plural(t.counts.sections, "section")}${t.counts.figures ? ` and ${plural(t.counts.figures, "figure")}` : ""}.`;
const debugOn = () => typeof document !== "undefined" && document.documentElement.dataset.debug != null;
const took = (ms?: number) => (ms == null ? "." : ms < 50 ? " instantly." : ms < 1000 ? ` in ${plural(ms, "millisecond")}.` : ` in ${(ms / 1000).toFixed(1)} seconds.`);
// The page's own title, marked with its language when that is not English, so the voice can refuse what it cannot read.
const ttl = (t: TwinData): Chunk => {
  const text = `${cleanTitle(t.source.title)}.`;
  const lang = t.source.lang;
  return lang && !/^(en|und|zxx)\b/i.test(lang) ? { text, lang } : text;
};
const NEXT_STEP = "Paste another link, or hold Space and ask for a paper.";
const FULL_LINE = "Loading the full page through Bright Data.";
const VIDEO_LINE = "Outlining the video with Gemini.";
// A stored copy is only the first view: the live page is fetched at once and swapped in (lib/server/fetch.ts). Speech says one line
// about it, and only when there is something to say: the page changed, or the check failed. Silence means this is the current page.
const NEWER = "A newer version of the page is now on screen.";
const LIVE_FAILED = "I could not check for a newer version, so this may be an older copy.";
const LIVE_THIN = "The live page came back incomplete, so this is the saved copy.";
/** What kind of copy this is, when the server says so in a first block "About this copy" ("the authors' accepted manuscript"). */
const aboutCopy = (t: TwinData) => {
  const n = t.nodes[0];
  return n && n.kind === "section" && /^about this (?:copy|page)$/i.test(n.heading.trim()) ? (n.text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? n.text).slice(0, 240) : "";
};
/** A PDF's opening lines: its title, what kind of copy it is when the server says so (as a page opening does), then the page count. */
const pdfLines = (t: TwinData) => {
  const [title, ...rest] = pdfIntro(t);
  return [title, ...(aboutCopy(t) ? [aboutCopy(t)] : []), ...rest];
};
const PDF_LINK = /\.pdf(?:$|[?#])|^https?:\/\/(?:export\.)?arxiv\.org\/pdf\//i;
// The screen may name where a page came from; the voice never does.
const BD = /\s*(?:through|via|with) (?:the )?Bright Data(?: (?:Browser API|Web Unlocker))?/gi;
const bare = (s: string) => s.replace(BD, "");
const LIVE_BUDGET_MS = 45_000; // the server gives Bright Data 25 s, then answers with the stored copy (treated as a failure)
type Route = "brightdata" | "direct";
const routeWords = (r: Route | TwinData["source"]["via"]) => (r === "direct" ? "directly" : "through Bright Data");
const seconds = (ms = 0) => `${ms >= 10_000 ? Math.round(ms / 1000) : (ms / 1000).toFixed(1)} seconds`;

type Hint = { title: string; snippet: string };
type Preview = TwinData & { from: string };
type Batch = { results?: Result[]; via?: string; ms?: number; error?: string };
const rid = (i: number) => `r${String(i + 1).padStart(2, "0")}`;
/** Results read aloud from `from`: the next three by number (for keys too), then how to go on. `at`: the result the cursor sits on
 * while each line is said; after the three it goes back to the first of them, so Down then reads the next one. */
const resultLines = (results: Result[], from: number, lead?: string) => {
  const some = results.slice(from, from + 3);
  return {
    lines: [...(lead ? [lead] : []), ...some.map((r, k) => resultLine(r, from + k + 1)), resultsTail(inputStyle(), results.length > from + 3)],
    at: [...(lead ? [rid(from)] : []), ...some.map((_, k) => rid(from + k)), rid(from)],
  };
};
// The opening line after a page's title and size, and the PDF and video hints, worded for how the student has been acting.
// By voice the line is an offer: "yes" or "read" starts reading from the top. Offered rather than started: a page just opened
// may be the wrong one, and reading over the student while they check would make them stop it first.
const offerReading = () => window.dispatchEvent(new CustomEvent("arc:offer", { detail: { name: "continue", args: { from: "top" } } }));
const cued = (lines: Chunk[]): Chunk[] => lines.map((l) => (l === OPENING ? opening(inputStyle()) : typeof l === "string" && /^Press P to play/.test(l) ? videoPlay(inputStyle()) : l));
/** A page's first lines; with the opening line, by voice, "yes" then reads from the top. */
const intro = (lines: Chunk[]) => {
  const offer = lines.includes(OPENING) && inputStyle() !== "keys";
  if (offer) offerReading();
  void speaker.say(cued(lines)).then((ok) => ok && offer && offerReading()); // the offer's 20 s count from the end of the line
};
const ORIGINAL_TAB = "Opening the original page in a new tab. Arc is still here in this tab.";
const counted = (t: TwinData) =>
  `${plural(t.counts.sections + t.counts.segments, t.counts.segments ? "part" : "section")}${t.counts.figures ? `, ${plural(t.counts.figures, "figure")}` : ""}`;
// shortcut: reads Speaker's private audio element to find the gap between two sentences; a public hook on Speaker would be cleaner.
const sentenceEnd = () =>
  new Promise<void>((done) => {
    const t0 = performance.now();
    const tick = () => (!(speaker as unknown as { audio: unknown }).audio || performance.now() - t0 > 8000 ? done() : void setTimeout(tick, 100));
    tick();
  });
// An automatic line (not the answer to what the student just did): it waits for the voice to be free, and is dropped when the
// student acted meanwhile or is still being read to after 20 s. Resolves true when it may be said now.
const freeFor = async (turn: number) => {
  for (let i = 0; speaker.busy && i < 200 && turnNow() === turn; i++) await new Promise((r) => setTimeout(r, 100));
  return !speaker.busy && turnNow() === turn;
};

const CHANGED = "The page has changed, so I opened it from the top.";
// "Heating and Cooling: a long subtitle" -> "Heating and Cooling"; a long title, its first five words without a dangling "for" or "of".
const shortTitle = (s: string) =>
  cleanTitle(s).split(/[:\u2013\u2014]| - /)[0].trim().split(/\s+/).slice(0, 5).join(" ").replace(/(\s+(?:a|an|and|at|by|for|from|in|of|on|the|to|with))+$/i, "");
// "at 2.1 Hardware, paragraph 2", "on page 3", "at Figure 2": where a saved place is, in the words the student already hears.
const placeWords = (t: TwinData, n: TwinNode, b: number) => {
  if (t.pdf && n.page != null) return `on page ${n.page}`;
  if (n.kind === "figure") return `at ${n.heading}`;
  const heads = t.nodes.filter((x) => x.kind === "section");
  const s = sectionNo(heads, heads.indexOf(n));
  return `at ${s.no ? `${s.no} ` : ""}${s.name}${b >= 0 ? `, paragraph ${b + 1}` : ""}`;
};
// A line that must be heard: said now, and when the browser has not let it sound by the first key or touch, said then, as the start
// page's greeting is (components/AskButton.tsx). That press is the line and nothing else. Heard = the clip really began.
const sayFirst = (line: string) => {
  const press = (e: Event) => {
    if (e instanceof KeyboardEvent && (["Shift", "Control", "Alt", "Meta"].includes(e.key) || e.metaKey || e.ctrlKey)) return;
    off();
    void speaker.say([line]);
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const began = (e: Event) => {
    const d = (e as CustomEvent<{ kind: string; text?: string; phase?: string }>).detail;
    if (d?.kind === "speech" && d.phase === "start" && d.text === line) off();
  };
  const off = () => {
    window.removeEventListener("arc:heard", began);
    window.removeEventListener("keydown", press, true);
    window.removeEventListener("pointerdown", press, true);
  };
  window.addEventListener("arc:heard", began);
  window.addEventListener("keydown", press, true);
  window.addEventListener("pointerdown", press, true);
  said(line);
  void speaker.say([line]);
};

export default function Twin() {
  const [twin, setTwin] = useState<TwinData | null>(null);
  const [found, setFound] = useState<{ query: string; results: Result[] } | null>(null);
  const [status, setStatus] = useState("Ask Arc anything, or paste a link.");
  const [original, setOriginal] = useState<string | null>(null); // id of the twin whose original page the student asked to see (the Live page panel)
  const quiet = useRef(""); // a status line that is for the eyes only; the voice-first reading skips it
  const note = useCallback((line: string) => {
    const shown = debugOn() ? line : ""; // "Loaded from the saved copy in 40 ms": for ?debug=1, not the default view
    quiet.current = shown;
    setStatus(shown);
  }, []);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [tourId, setTourId] = useState<string | null>(null);
  // Put the reading cursor on this node once it is on screen (a silent goto), then speak the lines.
  const [cursorTo, setCursorTo] = useState<{ id: string; lines: string[]; then?: () => void; b?: number; resume?: boolean; at?: string[] } | null>(null);
  // The place a reload left (lib/client/place.ts), until the link it belongs to has opened; startAt: a lecture's second, for its player.
  const back = useRef<{ url: string; place: Place; told?: boolean } | null>(null); // told: "Opening <title>, where you left off." was already said
  const [startAt, setStartAt] = useState<number | null>(null);
  const resumeAt = useCallback((url: string, place: Place, told = false) => {
    back.current = { url, place, told };
    if (place.t != null) setStartAt(place.t);
  }, []);
  const shown = useRef<string | null>(null); // the public link now in the address bar
  const recorded = useRef(""); // the link and title last written to the list of what was opened (lib/client/recent.ts)
  const gone = useRef(false);
  const seq = useRef(0); // the newest load or search; an older one never swaps its result in
  const cursorHeading = useRef<string | null>(null);
  const cursorId = useRef<string | null>(null);
  const cursorBlock = useRef<{ id: string; block: number; blocks: number; text: string } | null>(null); // the paragraph under the cursor (Reader's "arc:block")
  const lastContext = useRef("");
  const pdfContext = useRef({ id: "", text: "" }); // a PDF's outline for the question session is made once, from its first pages: pages arriving later must not reopen the session
  const prioritised = useRef(new Set<string>()); // figures whose analysis was moved up the server's queue
  const twinRef = useRef<TwinData | null>(null);
  const viaHelper = useRef<(url: string) => void>(() => {}); // a link that needs sign-in: read through the student's browser (set below)
  const privateSaid = useRef(false); // the one-time line about private pages, once per visit
  const tourRef = useRef<string | null>(null);
  useEffect(() => {
    twinRef.current = twin;
    tourRef.current = tourId;
  }, [twin, tourId]);

  // Voice first: a status line nobody said is said once, in its own words, when the voice is free (never over another line).
  useEffect(() => {
    if (!voiceFirst()) return;
    if (status === quiet.current) return;
    const spoken = bare(status);
    const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const mine = words(spoken);
    const t0 = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      if (document.querySelector("[data-tour]")) return; // the tour has its own voice: never two at once
      if (speaker.busy) return void (Date.now() - t0 < 8000 && (timer = setTimeout(check, 300)));
      if (speaker.recent.some((r) => Date.now() - r.at < 10_000 && (words(r.text).includes(mine) || mine.includes(words(r.text))))) return;
      void speaker.say([spoken]);
    };
    timer = setTimeout(check, 600);
    return () => clearTimeout(timer);
  }, [status]);

  // Tours already made for this page's figures (prepared, or built earlier: free to read, no model call) are attached when it
  // opens, so a question about something only a picture shows ("what does the belt unit contain") is answered from it.
  const twinId = twin?.id;
  useEffect(() => {
    const t = twinRef.current;
    if (!t || t.video || !twinId) return;
    const urls = [...new Set(t.nodes.filter((n) => n.kind === "figure" && n.image && !n.tour).map((n) => n.image!.url))].slice(0, 60);
    if (!urls.length) return;
    let on = true;
    void (async () => {
      const st = (await fetch(`/api/tour/status?${urls.map((u) => `images=${encodeURIComponent(u)}`).join("&")}`).then((r) => r.json()).catch(() => ({}))) as Record<string, { state?: string }>;
      const got = new Map<string, Tour>();
      for (const u of urls.filter((x) => st[x]?.state === "full")) {
        const tour = (await fetch(`/api/tour?image=${encodeURIComponent(u)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as Tour | null;
        if (!on) return;
        if (tour?.stops?.length) got.set(u, tour);
      }
      if (on && got.size) setTwin((x) => x && x.id === twinId ? { ...x, nodes: x.nodes.map((n) => (!n.tour && n.image && got.has(n.image.url) ? { ...n, tour: got.get(n.image.url) } : n)) } : x);
    })();
    return () => void (on = false);
  }, [twinId]);

  // Warms the voice so these fixed lines start at once.
  useEffect(
    () =>
      [bare(LIVE_LINE), bare(FULL_LINE), VIDEO_LINE, "Opening the PDF.", NEXT_STEP, OPENING, ORIGINAL_TAB, "Still searching. One moment.", ...(["voice", "keys", "both"] as const).flatMap((h) => [opening(h), resultsTail(h, true), resultsTail(h, false)])].forEach(prefetchClip),
    [],
  );
  const readUpTo = useRef(0); // search results read aloud so far ("more" reads the next three)
  const lastResults = useRef<{ found: { query: string; results: Result[] }; at: number } | null>(null); // the list a result was opened from
  const leftAt = useRef<{ twin: string; id: string; b: number; heading: string } | null>(null); // where the page was when a search covered it
  useEffect(() => {
    const onCursor = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; heading: string }>).detail;
      cursorHeading.current = d?.heading ?? null;
      cursorId.current = d?.id ?? null;
      // The cursor landed on a figure (arrow, scroll, command): its analysis jumps the queue, once per figure.
      const fig = twinRef.current?.nodes.find((n) => n.id === d?.id);
      const url = fig?.kind === "figure" ? fig.image?.url : undefined; // an equation's picture has no tour
      if (url && !prioritised.current.has(url)) {
        prioritised.current.add(url);
        void fetch("/api/tour/prioritise", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: url }) }).catch(() => {});
      }
    };
    const onBlock = (e: Event) => void (cursorBlock.current = (e as CustomEvent<NonNullable<typeof cursorBlock.current>>).detail ?? null);
    // The student's place in this tab: written a moment after the cursor stops moving, and at once when the page goes away.
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The same place into the list of what was opened (localStorage): no oftener than every 3 s, and at once when the page goes away.
    let rec: ReturnType<typeof setTimeout> | undefined;
    const saveRec = () => {
      clearTimeout(rec);
      rec = undefined;
      const t = twinRef.current;
      if (t && !back.current && isPublic(t.source)) keepRecentPlace(t.source.url);
    };
    const flush = () => {
      clearTimeout(timer);
      const t = twinRef.current;
      const n = t?.nodes.find((x) => x.id === cursorId.current);
      if (!t || !n || back.current || !isPublic(t.source)) return; // back: a reload's place is still waiting to be used
      const blk = cursorBlock.current;
      const place = { id: n.id, b: blk?.id === n.id ? blk.block : -1, ...(n.page != null && { page: n.page }) };
      if (worthKeeping(place, t.nodes[0]?.id)) updatePlace(t.source.url, place);
      rec ??= setTimeout(saveRec, 3000);
    };
    const leave = () => (flush(), saveRec());
    const keep = () => {
      clearTimeout(timer);
      timer = setTimeout(flush, 400);
    };
    const onCursorKeep = (e: Event) => (onCursor(e), keep());
    const onBlockKeep = (e: Event) => (onBlock(e), keep());
    window.addEventListener("arc:cursor", onCursorKeep);
    window.addEventListener("arc:block", onBlockKeep);
    window.addEventListener("pagehide", leave);
    return () => {
      clearTimeout(timer);
      clearTimeout(rec);
      window.removeEventListener("arc:cursor", onCursorKeep);
      window.removeEventListener("arc:block", onBlockKeep);
      window.removeEventListener("pagehide", leave);
    };
  }, []);
  useEffect(() => {
    if (!cursorTo) return;
    window.dispatchEvent(new CustomEvent("arc:command", { detail: { name: "goto", args: { id: cursorTo.id, silent: true, b: cursorTo.b, resume: cursorTo.resume } } }));
    if (!cursorTo.lines.length) return; // a silent move: whatever is being read carries on
    said(cursorTo.lines.join(" "));
    const lines = cued(cursorTo.lines);
    if (lines.includes(opening(inputStyle())) && inputStyle() !== "keys") offerReading();
    const at = cursorTo.at; // results: the cursor moves to each one as its line starts
    const step = at && ((i: number) => at[i] && window.dispatchEvent(new CustomEvent("arc:command", { detail: { name: "goto", args: { id: at[i], silent: true } } })));
    void speaker.say(lines, step || undefined).then(cursorTo.then);
  }, [cursorTo]); // each request is a new object, so it runs once per request

  // Swap a newer copy in without yanking: the sentence being spoken ends first, the cursor stays on the item with the
  // same heading, tours already fetched carry over, and an open tour stays open while its figure is still there.
  // lines: spoken where the cursor lands; none keeps the reading going. Returns false when a newer load took over.
  const swapIn = useCallback(async (t: TwinData, mine: number, lines: string[], skipHeading?: string) => {
    await sentenceEnd();
    if (mine !== seq.current) return false;
    const at = cursorHeading.current; // read after the wait: the student may have moved on meanwhile
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
      const turn = turnNow();
      // A live copy far thinner than the stored one (a paper of 23 sections and 22 figures came back as 2 sections and none: the
      // publisher served its metrics page) is a failed fetch, not a newer version: the stored copy stays, and nothing is swapped under the student.
      const parts = (x: TwinData) => x.counts.sections + x.counts.segments;
      if (t && (parts(t) * 2 < parts(stored) || (stored.counts.figures >= 2 && !t.counts.figures))) return void ((quiet.current = LIVE_THIN), setStatus(LIVE_THIN));
      if (!t) return void ((quiet.current = LIVE_FAILED), setStatus(LIVE_FAILED)); // on screen only (voice first skips it too): never said on its own
      const changed = t.source.title !== stored.source.title || counted(t) !== counted(stored);
      if (!(await swapIn(t, mine, changed && (await freeFor(turn)) ? [NEWER] : []))) return;
      note(`Live page loaded ${routeWords(t.source.via)} in ${seconds(t.source.ms)}.`);
    },
    [swapIn, note],
  );

  // After a reload the link opens as usual, but the cursor, the band and the scroll go back to the saved block (a PDF page that is not
  // loaded is fetched first, a lecture waits paused at its second), the opening lines are not read, and one line says where the student
  // is. Then Arc waits: Down or "go on" reads the next block. "" when the place no longer exists (the page changed).
  const land = useCallback(async (t: TwinData, p: Place, mine: number, told = false): Promise<string> => {
    const lead = told ? "" : `Back on ${shortTitle(t.source.title)}. `; // after "Opening <title>, where you left off." the title is not said again
    const how = inputStyle();
    if (t.video) {
      const segs = segmentsOf(t.nodes);
      const seg = segs.filter((n) => (n.start as number) <= (p.t ?? 0) + 0.05).pop() ?? segs[0];
      if (seg) setCursorTo({ id: seg.id, lines: [], resume: true });
      return `${lead}You were at ${saidTime(p.t ?? 0)}. ${cue(how, "Say play to go on.", "Press P to go on.")}`;
    }
    if (t.pdf && p.page && !t.nodes.some((n) => n.id === p.id)) {
      const r = await fetchPage(t.pdf.id, p.page, true);
      if (mine !== seq.current || !r?.nodes.length) return "";
      const near = t.nodes.some((n) => n.page === p.page! - 1 || n.page === p.page! + 1);
      setTwin((x) => (x && x.id === t.id ? { ...x, nodes: near ? mergePage(x.nodes, p.page!, withFigures(r)) : withFigures(r) } : x));
      t = { ...t, nodes: near ? mergePage(t.nodes, p.page, withFigures(r)) : withFigures(r) };
    }
    const n = t.nodes.find((x) => x.id === p.id) ?? (p.page ? t.nodes.find((x) => x.page === p.page) : undefined);
    if (!n) return "";
    const b = n.id === p.id ? p.b : -1;
    setCursorTo({ id: n.id, b, resume: true, lines: [] });
    return `${lead}You were ${placeWords(t, n, b)}. ${cue(how, "Say go on.", "Press Down to go on.")}`;
  }, []);
  // The lines a page opens with, or, when a reload left a place for this link, the place (above).
  const opened = useCallback(
    (target: string, t: TwinData, lines: Chunk[], mine: number) => {
      const b = back.current;
      if (!b || b.url !== target || (t.video && b.place.t == null)) return intro(lines);
      back.current = null;
      void land(t, b.place, mine, b.told).then(async (line) => {
        if (mine !== seq.current) return;
        if (line && b.told && !(await freeFor(turnNow()))) return; // the opening words are still being said: the place follows them
        if (line) sayFirst(line);
        else intro([CHANGED, ...lines]);
      });
    },
    [land],
  );

  // live: skip the saved copy. Otherwise the saved copy if there is one, else the server fetches live itself.
  // With no saved copy, a quick preview (/api/preview, asked at the same time) is shown and read while the full page loads.
  const load = useCallback(async (target: string, live: boolean, hint?: Hint) => {
    const mine = ++seq.current;
    speaker.cancel();
    setFound(null);
    setTourId(null);
    cursorHeading.current = null;
    if (back.current?.url !== target) setStartAt(null); // a lecture's saved second belongs to the link that was reloaded
    const video = VIDEO.test(target);
    const pdf = PDF_LINK.test(target);
    setStatus(video ? "Outlining the video." : pdf ? "Opening the PDF." : live ? LIVE_LINE : "Loading.");
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
    const preview: Promise<Preview | null> = live || pdf
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
        return setCursorTo({ id: p.nodes[0].id, lines: [`${cleanTitle(p.source.title)}.`, bare(line)], then: tone });
      }
      if (video) return void speaker.say(["Outlining the video with Gemini. This takes a moment."]).then(tone);
      const wait = pdf ? "Opening the PDF." : LIVE_LINE;
      setStatus(wait);
      counter();
      void speaker.say([bare(wait)]).then(tone);
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
      if (!res.ok && isSignInError(res.status, data.error) && mine === seq.current) {
        finish();
        return void viaHelper.current(target);
      }
      if (!res.ok) throw new Error(data.error ?? "Could not load that page.");
      const t = data as TwinData;
      finish();
      if (mine !== seq.current) return;
      const sr = (data as { search?: { query: string; results: Result[] } }).search;
      if (sr?.results?.length) {
        // A pasted search link (Google Scholar): the results list, read as any search's (the top three, then what to say).
        setTwin(null);
        setFound(sr);
        readUpTo.current = Math.min(3, sr.results.length);
        setStatus(`${plural(sr.results.length, "result")} for ${sr.query}.`);
        // Why these are results and not the page asked for (Scholar does not let Arc read it; several papers share the title): said once, first.
        const about = t.nodes?.[0]?.heading === "About these results" ? t.nodes[0].text.replace(/\s*Say open and a number\.?\s*$/, "") : "";
        return setCursorTo({ id: "r01", ...resultLines(sr.results, 0, [about, `${plural(sr.results.length, "result")} for ${sr.query}.`].filter(Boolean).join(" ")) });
      }
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
        const ready = t.source.via === "open-index" ? "The details and abstract are ready." : `The full ${t.source.kind === "video" ? "outline" : "page"} is ready.`;
        const lines = t.video ? videoIntro(t) : [ready, ...(aboutCopy(t) ? [aboutCopy(t)] : []), `${counted(t)}.`, OPENING];
        const place = back.current?.url === target; // a reload's place: the cursor goes there instead of the opening lines
        if (await swapIn(t, mine, place ? [] : lines, was.source.title)) {
          note(`${VIA[t.source.via]}${took(t.source.ms)}`);
          if (place) opened(target, t, lines, mine);
        }
        return;
      }
      setTwin(t);
      if (t.pdf) {
        note(`${plural(t.pdf.pages, "page")}. Pages are prepared as you reach them.`);
        opened(target, t, pdfLines(t), mine);
        said(`Loaded ${t.source.title}.`);
        return;
      }
      const next = (data as { live?: Route }).live;
      if (t.source.via === "cache" && next) {
        note(`Saved copy shown. Fetching the live page ${routeWords(next)}…`);
        opened(target, t, [ttl(t), ...(aboutCopy(t) ? [aboutCopy(t)] : []), `${counted(t).replace(", ", " and ")}.`, OPENING], mine);
        said(`Loaded ${t.source.title}.`);
        void revalidate(target, mine, t);
        return;
      }
      note(`${VIA[t.source.via]}${took(t.source.ms)}`);
      opened(target, t, t.video ? videoIntro(t) : [t.source.via === "cache" ? "Saved copy." : "Loaded.", ttl(t), ...(aboutCopy(t) ? [aboutCopy(t)] : []), `${counted(t).replace(", ", " and ")}.`, OPENING], mine);
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
  }, [revalidate, swapIn, note, opened]);

  const startTour = useCallback(async (node: TwinNode) => {
    if (!node.image || (node.kind !== "figure" && node.kind !== "segment")) return; // an equation's picture is never toured
    const pic = node.kind === "segment"; // a still from a video: its tour is built once asked for
    if (pic) window.dispatchEvent(new CustomEvent("arc:video", { detail: "hold" })); // the video waits, and stays paused after the tour
    const refuse = (msg: string) => {
      setStatus(msg);
      void speaker.say(splitSentences(msg));
      said(msg);
    };
    if (tourRef.current === node.id && node.tour) {
      // Asked again while this tour is open ("tour", Enter on its button): its current line again, never silence.
      window.dispatchEvent(new CustomEvent("arc:command", { detail: { name: "read" } }));
      return;
    }
    if (!node.tour) {
      setStatus(`Looking for a tour of ${node.heading}.`);
      // Said at once, then a soft tone while the tour is fetched or built; any key ends the tone.
      let waiting = true;
      let toneOff = () => {};
      const quietNow = () => ((waiting = false), toneOff());
      watchTurn(quietNow);
      void speaker.say([`Looking at this ${pic ? "picture" : "figure"}.`]).then(() => void (waiting && (toneOff = startWaitTone())));
      const url = `/api/tour?image=${encodeURIComponent(node.image.url)}`;
      const at = cursorId.current;
      let res = await fetch(url, { signal: AbortSignal.timeout(45_000) }).catch(() => null); // a build that never ends is a failure, said
      if (pic && res?.status === 404) {
        // Not built yet (a few seconds): ask for it next, then ask again for up to 30 s while the cursor stays here.
        void fetch("/api/tour/prioritise", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: node.image.url }) }).catch(() => {});
        for (let k = 0; k < 20 && res?.status === 404 && cursorId.current === at; k++) {
          await new Promise((r) => setTimeout(r, 1500));
          res = await fetch(url).catch(() => null);
          const built = (await fetch(`/api/tour/status?images=${encodeURIComponent(node.image.url)}`).then((r) => r.json()).catch(() => ({}))) as Record<string, { state?: string }>;
          if (built[node.image.url]?.state === "failed") break; // the server gave up on it: no more waiting
        }
        if (cursorId.current !== at) return quietNow(); // the student moved on
      }
      quietNow();
      // No tour: never a dead end. The figure's own words instead, and how to hear them again.
      const sorry = () => refuse(`I can't walk through this ${pic ? "picture" : "figure"} right now. ${node.text.trim() ? `Its caption is: ${node.text.trim().replace(/[.]?$/, ".")} ` : ""}${hearAgain(inputStyle())}`);
      if (!res?.ok) return sorry();
      const tour = (await res.json().catch(() => null)) as Tour | null;
      if (!tour) return sorry();
      setTwin((t) => t && { ...t, nodes: t.nodes.map((n) => (n.id === node.id ? { ...n, tour } : n)) });
    }
    speaker.cancel();
    setStatus(`Touring ${node.heading}.`);
    setTourId(node.id);
    said(`Starting the tour of ${node.heading}.`);
  }, []);

  // A PDF from disk (the chooser, a drop or a paste): sent as it is; the server answers with a twin holding its first pages, like a link.
  const openFile = useCallback(
    async (f: File) => {
      const mine = ++seq.current;
      const say = (line: string) => {
        setStatus(line);
        said(line);
        void speaker.say([line]);
      };
      if (!isPdfFile(f)) return say("Arc reads PDF files. That one is not a PDF.");
      speaker.cancel();
      setFound(null);
      setTourId(null);
      cursorHeading.current = null;
      say(`Opening ${f.name.replace(/\.pdf$/i, "")}.`);
      try {
        const res = await fetch(`/api/pdf/upload?name=${encodeURIComponent(f.name)}`, { method: "POST", headers: { "content-type": "application/pdf" }, body: f });
        const data = (await res.json().catch(() => ({}))) as TwinData & { error?: string };
        if (mine !== seq.current) return;
        if (!res.ok || !data.nodes?.length) return say(data.error ?? "Arc could not read this PDF.");
        setTwin(data);
        note(`${plural(data.pdf?.pages ?? 0, "page")}. Pages are prepared as you reach them.`);
        intro(pdfLines(data));
      } catch {
        if (mine === seq.current) say("Arc could not send this PDF. Try again.");
      }
    },
    [note],
  );
  useEffect(() => watchPdfFiles((f) => void openFile(f), () => void speaker.say(["Arc reads PDF files. That one is not a PDF."])), [openFile]);

  // Headings and on-screen descriptions that the server finished after the video opened (components/VideoPlayer.tsx polls for them).
  const enrich = useCallback((late: Late) => {
    setTwin((t) => (t ? mergeLate(t, late) : t));
  }, []);

  const leaveTour = useCallback((node: TwinNode, quiet = false) => {
    setTourId(null);
    setStatus("Back to the page.");
    // After the key that left: the reader's own key handler stops the voice when it sees that Escape, and must not cut this line.
    // quiet: the request that left says its own line (a search from inside the tour, lib/client/command.ts).
    if (!quiet) setTimeout(() => void speaker.say([`Back to the page. ${node.heading}.`]), 0);
    requestAnimationFrame(() => document.getElementById(`fig-${node.id}`)?.focus());
  }, []);

  // Results stream in batches, each result with its rank (app/api/search: relevance, then source). "Searching for ..." is said at
  // once, then a soft tone. Results fill the screen as they come, merged in rank order, but the first three are read only once the
  // list holds a relevant textbook, encyclopedia, lesson or lecture, or 6 s after the search began, or when every route is done.
  // A request that named a source ("the OpenStax one") waits for that source the same way. Once read, later results go below.
  const search = useCallback(async (query: string, saidAs = query) => {
    const mine = ++seq.current;
    const page = twinRef.current;
    if (page && !handlers.current.found && cursorId.current) {
      const blk = cursorBlock.current;
      const n = page.nodes.find((x) => x.id === cursorId.current);
      leftAt.current = { twin: page.id, id: cursorId.current, b: blk?.id === cursorId.current ? blk.block : -1, heading: n?.heading ?? "" };
    }
    const t0 = Date.now();
    readUpTo.current = 0;
    let stopTone = () => {};
    let total = 0;
    let readOut = false;
    const begin = `Searching for ${saidAs}.`;
    said(begin);
    const begun = speaker.say([begin]).then(() => void (mine === seq.current && !readOut && (stopTone = startWaitTone())));
    const still = setTimeout(() => {
      if (mine !== seq.current || readOut) return;
      stopTone();
      void speaker.say(["Still searching. One moment."]).then(() => void (mine === seq.current && !readOut && (stopTone = startWaitTone())));
    }, 8000);
    let onGate = () => {};
    const gate = setTimeout(() => onGate(), 6000); // 6 s after the search began, read what there is
    const quiet = () => {
      readOut = true;
      clearTimeout(still);
      clearTimeout(gate);
      stopTone();
      stopTone = () => {};
      searchDone(mine);
    };
    searchStarted(mine, () => (++seq.current, quiet())); // Escape while nothing is read yet cancels (lib/client/narrow.ts)
    const fail = () => {
      quiet();
      setStatus("Search is not available right now.");
      void speaker.say(["Search is not available right now."]);
      said("Search is not available right now.");
    };
    const res = await fetch("/api/search", { method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson" }, body: JSON.stringify({ query }) }).catch(() => null);
    if (mine !== seq.current) return quiet();
    if (!res?.ok || !res.body) return fail();
    let errored = false;
    let earlier = false; // the saved list from an earlier search came first
    let liveSeen = false;
    let shown: Result[] = []; // what is on screen, in order
    const key = (r: Result) => r.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); // same paper, other home
    const read = (lead: string) => {
      const k = takePendingOpen(); // "open the first one" said while searching: opened now, not read
      quiet();
      setStatus(`${plural(shown.length, "result")} for ${query}.`);
      if (k != null) return shown[k] ? handlers.current.open(shown[k].url) : void speaker.say([`There ${shown.length === 1 ? "is only 1 result" : `are only ${shown.length} results`}.`]);
      const r = resultLines(shown, 0, lead);
      r.lines.forEach(prefetchClip);
      readUpTo.current = Math.min(3, shown.length);
      void begun.then(() => mine === seq.current && setCursorTo({ id: "r01", ...r }));
    };
    const named = namedSites(query).length > 0;
    const tryRead = (final = false) => {
      if (mine !== seq.current || readOut || !shown.length) return;
      const p = preferSource(query, shown);
      const ready = final || Date.now() - t0 >= 6000 || (named ? p.has : shown.some((r) => r.study));
      if (!ready) return;
      const site = namedSites(query).map((k) => siteName(`https://${k}.org`)).join(" or ");
      read(final && named && !p.has ? `${plural(shown.length, "result")}. None of them is from ${site}.` : earlier && !liveSeen ? `${plural(shown.length, "result")} from earlier. Searching live.` : `${plural(shown.length, "result")} so far.`);
    };
    onGate = () => tryRead();
    const take = (b: Batch) => {
      if (mine !== seq.current) return;
      if (!b.results) return void (errored = true);
      const n = b.results.length;
      if (b.via !== "cache") liveSeen = true;
      else earlier = true;
      if (!n) return;
      total += n;
      const have = new Set(shown.flatMap((r) => [r.url, key(r)]));
      const add = b.results.filter((r) => !have.has(r.url) && !have.has(key(r)) && have.add(r.url).add(key(r)));
      // Nothing read yet: the whole list in rank order. Once read: below, never renumbering what she heard.
      shown = readOut ? [...shown, ...add] : preferSource(query, [...shown, ...add].map((r, i) => ({ r, i })).sort((a, b) => (a.r.rank ?? 99) - (b.r.rank ?? 99) || a.i - b.i).map((x) => x.r)).results;
      setTourId(null);
      setFound({ query, results: shown });
      setStatus(`${plural(shown.length, "result")} so far for ${query}.`);
      tryRead();
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
    if (mine !== seq.current) return quiet();
    tryRead(true); // every route has finished
    if (earlier && !liveSeen) setStatus("The live search did not answer. These are results from earlier.");
    if (total) return quiet();
    if (errored) return fail();
    quiet();
    setTourId(null);
    setFound({ query, results: [] });
    // Only now, with every route finished: one honest line, and an offer of wider words (the query's first two meaningful words).
    const words = contentWords(query);
    const wider = words.length > 2 ? words.slice(0, 2).join(" ") : "";
    const offer = wider ? cue(inputStyle(), `Say yes to search for ${wider}.`, `Type yes to search for ${wider}.`) : cue(inputStyle(), "Hold Space and try other words.", "Type other words.");
    const line = `No results for ${saidAs}. ${offer}`;
    setStatus(`No results for ${query}.`);
    said(line);
    if (wider) window.dispatchEvent(new CustomEvent("arc:offer", { detail: { name: "search", args: { query: wider } } }));
    void speaker.say([line]);
  }, []);

  // A result keeps its title and snippet so the preview has something to show even when the page itself is slow.
  const open = useCallback(
    (target: string) => {
      const f = handlers.current.found;
      const r = f?.results.find((x) => x.url === target);
      if (f && r) lastResults.current = { found: f, at: f.results.indexOf(r) }; // "go back to the results" returns here
      void load(target, false, r && { title: r.title, snippet: r.snippet });
    },
    [load],
  );

  // Commands for the page itself (typed, spoken, or from the one box); the cursor ones live in Reader.
  // /?doc=<id>: a page the Arc extension read from the student's own tab (app/api/ingest/route.ts); nothing is fetched.
  const loadDoc = useCallback(async (id: string, lead?: string) => {
    const mine = ++seq.current;
    setFound(null);
    setTourId(null);
    setStatus("Opening the page from your tab.");
    try {
      // The id rides in a header, never the address: request logs keep addresses.
      const res = await fetch("/api/ingest", { headers: { "x-arc-doc": id } });
      const t = res.ok ? ((await res.json()) as TwinData) : null;
      if (mine !== seq.current) return;
      if (!t?.nodes?.length) throw new Error(res.ok ? HELPER.nothing : HELPER.gone);
      setTwin(t); // kept on screen if the other way fails too (load() leaves the twin alone on an error)
      // A private page's id is a capability: it leaves the address bar at once, so a copied address shares nothing.
      if (t.source.private && new URLSearchParams(location.search).has("doc")) history.replaceState(history.state, "", location.pathname);
      const first = t.source.private && !privateSaid.current ? [HELPER.privateFirst] : [];
      if (first.length) privateSaid.current = true;
      const exam = t.source.assessment ? [HELPER.assessment] : [];
      if (t.pdf) {
        note(`${plural(t.pdf.pages, "page")}. Pages are prepared as you reach them.`);
        intro([...first, ...exam, ...pdfLines(t)]);
        said(`Loaded ${t.source.title}.`);
        return;
      }
      if (!t.source.private && t.counts.sections < 2 && /^https?:\/\//i.test(t.source.url)) {
        // The tab's HTML gave a useless parse (one section): read the page the normal way (MDPI through Bright Data).
        setStatus("Reading this page another way.");
        await speaker.say(["Reading this page another way."]);
        if (mine === seq.current) await load(t.source.url, false);
        return;
      }
      note(`${VIA[t.source.via] ?? "Read from your open tab"}.`);
      intro([lead ?? "Read from your tab.", ...first, ...exam, ttl(t), `${counted(t).replace(", ", " and ")}.`, OPENING]);
      said(`Loaded ${t.source.title}.`);
    } catch (e) {
      console.warn("Arc: could not open the page from the tab.", e);
      if (mine !== seq.current) return;
      const line = e instanceof Error && (e.message === HELPER.nothing || e.message === HELPER.gone) ? e.message : HELPER.gone;
      setStatus(line);
      void speaker.say([line]);
      said(line);
    }
  }, [load, note]);

  // A link that needs the student's sign-in: the Arc helper reads it in their own browser (lib/client/helper.ts), then it opens
  // like a page sent from their tab. Without the helper, one plain line says what it is and where to get it.
  useEffect(() => {
    viaHelper.current = async (url: string) => {
      const mine = ++seq.current;
      const say = async (line: string) => {
        setStatus(line);
        said(line);
        await speaker.say([line]);
      };
      if (!helperId()) return void say(HELPER.missing);
      const may = await helperAllowed(url);
      if (mine !== seq.current) return;
      if (may.code === "missing") return void say(HELPER.missing);
      if (may.refused) return void say(may.refused);
      await say(may.allowed ? HELPER.reading : HELPER.consent); // said before the browser's own question opens
      const r = await helperRead(url);
      if (mine !== seq.current) return;
      if (r.id) return void loadDoc(r.id);
      void say(r.code === "missing" ? HELPER.missing : (r.error ?? HELPER.failed));
    };
  }, [loadDoc]);

  // A place the page itself links to (twin.links: next, previous, a module item): a private page's links go through the helper.
  const follow = useCallback(
    (url: string) => {
      const t = twinRef.current;
      const site = (u: string) => {
        try {
          return new URL(u).host;
        } catch {
          return "";
        }
      };
      if (t?.source.private && site(url) === site(t.source.url)) viaHelper.current(url);
      else void load(url, false);
    },
    [load],
  );

  // Deep links, so nobody has to paste: /?url=<link>, /?q=<request>, /?doc=<id> (the extension), /?notice=restricted.
  // Read once per page (Strict Mode runs effects twice). ?doc and ?url stay in the address: they name the page on
  // screen, so a reload (or a dev hot reload) opens it again instead of the landing screen. ?q and ?notice are
  // one-shot and are cleared once handled.
  const deepLink = useRef(false);
  useEffect(() => {
    if (deepLink.current) return;
    deepLink.current = true;
    const p = new URLSearchParams(location.search);
    const [url, q] = [p.get("url"), p.get("q")];
    // #doc=<id> from the helper (a fragment never reaches the server or its request log); ?doc=<id> from an older helper.
    const doc = /^#doc=([0-9a-f]{32})$/.exec(location.hash)?.[1] ?? p.get("doc");
    if (location.hash.startsWith("#doc=")) history.replaceState(history.state, "", location.pathname + location.search);
    if (p.has("receive")) {
      const mode = p.get("receive");
      // The bookmarklet's hand-off: the page comes from the tab that opened this one, and is treated exactly like a helper page.
      history.replaceState(history.state, "", location.pathname);
      void Promise.resolve()
        .then(() => (setStatus("Waiting for the page from your other tab."), receivePage(mode)))
        .then(async (got) => {
        const res = got ? await fetch("/api/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: got.page }).catch(() => null) : null;
        const d = res ? ((await res.json().catch(() => ({}))) as { id?: string; error?: string }) : {};
        if (d.id && got) return loadDoc(d.id, HELPER.from(got)); // where it came from, said before any of its words
        const line = d.error ?? HELPER.gone;
        setStatus(line);
        void speaker.say([line]);
      });
      return;
    }
    // #sending: the helper opened this tab the moment its key was pressed and is still reading the other tab. Say so at once;
    // the helper then moves this tab to #doc=<id> (a fragment change, so no reload), or to ?notice= when it could not.
    if (location.hash === "#sending") {
      history.replaceState(history.state, "", location.pathname);
      const line = "Reading the page from your tab.";
      const late = setTimeout(() => {
        const gone = "The Arc helper could not send that page to Arc. Try the shortcut again.";
        setStatus(gone);
        void speaker.say([gone]);
      }, 45_000);
      const arrived = () => {
        const id = /^#doc=([0-9a-f]{32})$/.exec(location.hash)?.[1];
        if (!id) return;
        clearTimeout(late);
        window.removeEventListener("hashchange", arrived);
        history.replaceState(history.state, "", location.pathname);
        void loadDoc(id, "Here it is."); // "Read from your tab." would repeat the line just said
      };
      window.addEventListener("hashchange", arrived);
      void Promise.resolve().then(() => (setStatus(line), speaker.say([line])));
      return;
    }
    // An empty or non-web ?url= comes from an older extension that could not read the tab (chrome://, New Tab page).
    const notice = p.get("notice") ?? (p.has("url") && !/^https?:\/\//i.test(url ?? "") ? "restricted" : null);
    if (!url && !q && !doc && !notice) return;
    // Keep Next's own history state: replacing it with null makes the router put the old URL back.
    const clear = () => !doc && !url && history.replaceState(history.state, "", location.pathname);
    const restricted = async () => {
      const line = notice === "failed" ? "The Arc helper could not send that page to Arc. Try the shortcut again." : "Chrome does not let extensions read that page. Open a normal web page and try again.";
      setStatus(line);
      void speaker.say([line]);
      said(line);
    };
    // After this effect, not inside it (React's rule against setState in an effect body).
    void Promise.resolve()
      .then((): Promise<unknown> | undefined => {
        // A reload of an open link: the place this tab kept for it (lib/client/place.ts) is used once the link has opened.
        const place = !doc && url && /^https?:\/\//i.test(url) ? readPlace(url) : null;
        if (place && url) resumeAt(url, place);
        return doc ? loadDoc(doc) : url && /^https?:\/\//i.test(url) ? load(url, false) : q ? submitUtterance(q) : notice ? restricted() : undefined;
      })
      .catch(() => {})
      .finally(clear);
  }, [load, loadDoc, resumeAt]);

  // The address bar names what is open, so a reload (an accidental Cmd+R, a restored tab) opens it again: /?url=<link> for a public
  // link; "/" for the start page and search results. A private page, an upload and an assessment put nothing in the address and
  // nothing in storage but a one-word marker, so the start page can say they were not kept. Opening something else drops the place.
  useEffect(() => {
    if (!twin && !found) return; // still opening: the address already names what is coming
    const link = !found && twin && isPublic(twin.source) ? twin.source.url : null;
    if (shown.current && shown.current !== link) keepRecentPlace(shown.current); // the list keeps where it was left
    if (shown.current && shown.current !== link) dropPlace(shown.current);
    shown.current = link;
    if (link && twin && recorded.current !== `${link}|${twin.source.title}`) {
      recorded.current = `${link}|${twin.source.title}`;
      rememberRecent(twin.source); // refuses anything not public: lib/client/recent.ts
    }
    if (!found && twin && !link) markGone(twin.source.url.startsWith("upload:") ? "file" : "private");
    else clearGone();
    const want = link ? addressFor(link) : "/";
    if (location.pathname + location.search !== want) history.replaceState(history.state, "", want); // Next's own history state stays
  }, [twin, found]);
  // Another document on screen (a link opened, the results, the start page again) starts at its top: the window keeps its scroll
  // position when the content under it is replaced, so a link opened from far down the start page (its "Try it" buttons) showed the
  // middle of the paper and the tail of a lecture. The first move of the cursor, or a reload's saved place, goes from there.
  const docKey = found ? "results" : (twin?.source.url ?? "");
  const lastDoc = useRef(docKey);
  useLayoutEffect(() => {
    if (lastDoc.current === docKey) return;
    lastDoc.current = docKey;
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [docKey]);
  // After a reload that lost a private page or a file: the start page says so, once. Before the start page's own greeting can take the
  // first key (layout effects run before it registers), so a browser that holds sound back says this line at the first key or touch.
  useLayoutEffect(() => {
    if (gone.current) return;
    gone.current = true;
    const kind = takeGone();
    const nav = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type;
    if (kind && (nav === "reload" || nav === "back_forward") && !/[?&](url|q|doc|receive)=/.test(location.search)) sayFirst(GONE_LINE[kind]);
  }, []);

  const handlers = useRef({ search, open, load, found, twin, tourId, leaveTour, openFile, follow, resumeAt });
  useEffect(() => {
    handlers.current = { search, open, load, found, twin, tourId, leaveTour, openFile, follow, resumeAt };
  });
  useEffect(() => {
    const onCommand = (e: Event) => {
      const { name, args } = (e as CustomEvent<{ name: string; args?: { query?: string; url?: string; id?: string; at?: number; file?: File; by?: number; place?: Place } }>).detail ?? {};
      const h = handlers.current;
      // "next page" / "previous page" on a web page: the page's own next and previous links (a PDF turns its pages: lib/client/pdf.ts).
      if (name === "page" && typeof args?.by === "number" && h.twin && !h.twin.pdf && !h.found) {
        const rel = args.by > 0 ? "next" : "prev";
        const link = h.twin.links?.find((l) => l.rel === rel);
        if (link) h.follow(link.url);
        else void speaker.say([`This page has no ${rel === "next" ? "next" : "previous"} page.`]);
        return;
      }
      if (name === "search" && args?.query) narrowSearch(args.query, (q, s) => void h.search(q, s)); // a broad request asks first (lib/client/narrow.ts)
      if (name === "results") {
        // Back to the list a result was opened from, on that result; never searched again.
        const l = lastResults.current;
        if (h.found?.results.length) {
          // In the results: "read me the results", "what did you find": the list again from the top.
          readUpTo.current = Math.min(3, h.found.results.length);
          setCursorTo({ id: "r01", ...resultLines(h.found.results, 0, `${plural(h.found.results.length, "result")} for ${h.found.query}.`) });
        } else if (!l || h.found) void speaker.say([searchPending() ? "Still searching. One moment." : h.twin ? "There are no search results to go back to. Say go home for the start page." : "There are no results yet. Say what you want to study."]);
        else {
          ++seq.current;
          setTourId(null);
          setFound(l.found);
          readUpTo.current = Math.max(readUpTo.current, l.at + 1);
          setCursorTo({ id: rid(l.at), lines: ["Back to your results.", resultLine(l.found.results[l.at], l.at + 1)] });
        }
      }
      if (name === "moreResults" && h.found) {
        const from = readUpTo.current;
        const all = h.found.results;
        if (from >= all.length) void speaker.say([`That is all ${plural(all.length, "result")}.`, resultsTail(inputStyle(), false)]);
        else setCursorTo({ id: rid(from), ...resultLines(all, from) });
        readUpTo.current = Math.min(from + 3, all.length);
      }
      if (name === "load" && args?.url) void h.load(args.url, false);
      if (name === "refresh" && h.twin) void h.load(h.twin.source.url, true);
      if (name === "pdf-file" && args?.file) void h.openFile(args.file);
      if (name === "original" && h.twin?.source.kind === "page") setOriginal(h.twin.id);
      if (name === "open") {
        // A result id from Snap ("open the second one"), or a full address from the voice model.
        // at: the result under the cursor, or a counted one ("open the second one"), from the local grammar.
        const url = args?.url ?? h.found?.results[typeof args?.at === "number" ? args.at : Number(args?.id?.slice(1)) - 1]?.url;
        if (url && h.twin?.links?.some((l) => l.url === url)) h.follow(url);
        else if (url) {
          if (args?.place) {
            // From what was opened before: opens where the student left off, as a reload does. "Opening <title>, where you left
            // off." is heard to its end first (the load cut it after one word); the page is fetched meanwhile by the browser's cache or not at all.
            const go = () => (h.resumeAt(url, args.place!, true), h.open(url));
            const t0 = performance.now();
            const wait = () => (speaker.busy && performance.now() - t0 < 6000 ? void setTimeout(wait, 100) : go());
            return void setTimeout(wait, 150);
          }
          h.open(url);
        }
      }
      if (name === "leave") {
        const node = h.twin?.nodes.find((n) => n.id === h.tourId);
        if (node) {
          stopVoice();
          h.leaveTour(node, !!(args as { quiet?: boolean } | undefined)?.quiet);
        } else if (h.found && h.twin) {
          setFound(null);
          // Back on the block she was on when she searched, and where that is.
          const at = leftAt.current?.twin === h.twin.id ? leftAt.current : null;
          const where = at ? ` ${at.heading.replace(/^(\d+(?:\.\d+)*)\.\s/, "$1 ")}${at.b >= 0 ? `, paragraph ${at.b + 1}` : ""}.` : "";
          if (at) setCursorTo({ id: at.id, b: at.b >= 0 ? at.b : undefined, resume: true, lines: [`Back to the page.${where}`] });
          else void speaker.say([`Back to ${h.twin.source.title}.`]);
        } else if (h.found) {
          setFound(null); // no page behind the results: the start
          void speaker.say([`Back to the start. ${LANDING_LINE.replace(/^Nothing is open yet\. /, "")}`]);
        } else void speaker.say(["There is nothing to leave."]);
      }
    };
    window.addEventListener("arc:command", onCommand);
    return () => window.removeEventListener("arc:command", onCommand);
  }, []);

  // A page in another language that the voice cannot read: the server refuses it once (lib/client/reader.ts probes when the page opens),
  // and the server's own line is shown and spoken once. The cursor, pointer, keys, tours and questions go on working; the page's words are not read.
  const [langNote, setLangNote] = useState<{ url: string; line: string } | null>(null);
  const noted = useRef(""); // the address of the page whose language line has been said
  const [twinUrl, twinLang] = [twin?.source.url, twin?.source.lang];
  useEffect(() => {
    if (noted.current !== twinUrl) {
      speaker.blocked = null; // another page: the voice may read this one
      noted.current = "";
      setLangNote(null);
    }
    if (twinUrl && twinLang && !/^(en|und|zxx)\b/i.test(twinLang)) probeLanguage(twinLang);
  }, [twinUrl, twinLang]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const onLanguage = (e: Event) => {
      const line = (e as CustomEvent<{ say: string }>).detail?.say;
      const url = twinRef.current?.source.url;
      if (!line || !url || noted.current === url) return;
      noted.current = url;
      setLangNote({ url, line });
      said(line);
      const t0 = Date.now();
      const check = () => {
        if (speaker.busy && Date.now() - t0 < 12_000) return void (timer = setTimeout(check, 300));
        void speaker.say([line]);
      };
      timer = setTimeout(check, 600);
    };
    window.addEventListener("arc:language", onLanguage);
    return () => {
      window.removeEventListener("arc:language", onLanguage);
      clearTimeout(timer);
    };
  }, []);

  const onLink = useCallback(
    (e: React.MouseEvent) => {
      const a = (e.target as HTMLElement).closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !/^https?:/i.test(a.href)) return;
      e.preventDefault();
      const t = twinRef.current;
      const same = (u: string) => u.replace(/[#?].*$/, "").replace(/\/$/, "");
      if (t && !handlers.current.found && same(a.href) === same(t.source.url)) {
        said(ORIGINAL_TAB);
        void speaker.say([ORIGINAL_TAB]); // said first: opening a tab can hold the page a moment
        window.open(a.href, "_blank", "noopener");
      } else if (handlers.current.found?.results.some((r) => r.url === a.href)) handlers.current.open(a.href);
      else handlers.current.load(a.href, false);
    },
    [],
  );

  useFocusVoice();
  usePdf(twin, setTwin);
  usePageFix(twin, setTwin);

  const items = useMemo<TwinNode[]>(
    () =>
      found
        ? found.results.map((r, i) => ({ id: rid(i), kind: "section", order: i + 1, level: 2, heading: resultLine(r, i + 1), text: resultSummary(r) })) // Down: number, title, source, one sentence
        : (twin?.nodes ?? []),
    [found, twin],
  );

  // The command box (in the page header) decides over what is on screen now. The page's nodes go with the items at the same
  // moment (tourContext keeps voice.ts's copy): when they lagged, a PDF's headings were not found by name and "go to the
  // Attention section" by voice fell through to a word search.
  useEffect(() => {
    if (twin && !found) tourContext(twin, tourId);
    setCommandContext(
      items.map((n, i) => ({
        id: n.id,
        // Results carry their number and site, so "the second one" and "the one from PubMed" can be picked.
        label: found ? `Result ${i + 1}: ${found.results[i]?.title} (${host(found.results[i]?.url)})` : n.kind === "figure" ? `${n.heading}: ${n.text.slice(0, 80)}` : n.heading,
      })),
      tourId !== null,
      {
        mode: found ? "results" : !twin ? "landing" : twin.counts.segments ? "video" : "article",
        title: found ? `search results for ${found.query}` : (twin?.source.title ?? ""),
        pages: found ? 0 : (twin?.pdf?.pages ?? 0),
        // What "go back" returns to: the page behind the results, or the results a page was opened from.
        behind: found ? twin?.source.title : lastResults.current ? `search results for ${lastResults.current.found.query}` : undefined,
      },
    );
  }, [items, tourId, found, twin]);
  // The question session (Gemini Live) answers from this page's outline (stable: a new one reopens the session), plus
  // where the student is now and the open tour (volatile: sent with each question, never a reopen), so "this", "that"
  // and "why" have a referent. Sent at most every 500 ms and only when it changed.
  useEffect(() => {
    if (!twin && !found) return;
    const pdfOutline = (t: TwinData) => {
      if (pdfContext.current.id !== t.pdf!.id) {
        const first = pageContext({ ...t, nodes: t.nodes.filter((n) => (n.page ?? 0) <= 2) });
        pdfContext.current = { id: t.pdf!.id, text: `${first}\nThis PDF has ${t.pdf!.pages} pages. The student is reading it page by page.` };
      }
      return pdfContext.current.text;
    };
    const page = found
      ? `Search results for ${found.query}:\n${found.results.map((r, i) => `Result ${i + 1}: ${r.title}. ${r.snippet.slice(0, 200)}`).join("\n")}`.slice(0, 6000)
      : twin!.pdf
        ? pdfOutline(twin!)
        : pageContext(twin!);
    let sent = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = () => {
      const i = items.findIndex((n) => n.id === cursorId.current);
      const n = items[i];
      const blk = cursorBlock.current;
      const stop = tourId ? document.querySelector("[data-tour] p")?.textContent?.trim() : "";
      const where = [
        "WHERE THE STUDENT IS NOW (\"this\", \"that\", \"here\" and \"it\" mean this):",
        `Mode: ${tourId ? "figure tour" : found ? "search results" : twin?.counts.segments ? "video outline" : "article"}.`,
        n ? `Current item, ${i + 1} of ${items.length}: ${n.heading}${n.kind === "figure" ? " (figure)" : ""}. ${blk && blk.id === n.id && blk.block >= 0 ? `The paragraph under the cursor (${blk.block + 1} of ${blk.blocks}): ${blk.text.slice(0, 800)}` : n.text.slice(0, 600)}` : "No item yet: the student is at the top.",
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
    window.addEventListener("arc:block", soon);
    window.addEventListener("arc:command", soon);
    window.addEventListener("keyup", soon); // tour keys move stops without a command event
    return () => {
      clearTimeout(timer);
      window.removeEventListener("arc:cursor", soon);
      window.removeEventListener("arc:block", soon);
      window.removeEventListener("arc:command", soon);
      window.removeEventListener("keyup", soon);
    };
  }, [twin, tourId, found, items]);

  return (
    <>
      {/* Not a live region: Arc's own voice says what matters, and a screen reader announcing this line would talk over it. */}
      <p className="status">
        {status}
      </p>
      {elapsed != null && <p className="elapsed">Waiting for Bright Data: {elapsed} seconds so far.</p>}

      {/* A link in the reading view never takes Arc's tab away: a page Arc can read opens in Arc; the page itself opens in a new tab, said aloud. */}
      <div id="content" tabIndex={-1} onClick={onLink}>
        {found ? (
          <Results query={found.query} results={found.results} ids={items.map((i) => i.id)} onOpen={open} />
        ) : twin ? (
          <article aria-labelledby="twin-title" data-pdf={twin.pdf ? "" : undefined} lang={twin.source.lang} dir={twin.source.dir}>
            {/* A PDF's own first heading is usually its title: then the title is shown once (the h1 stays for screen readers). */}
            <h1 id="twin-title" className={twin.pdf && twin.nodes.some((n) => n.level === 1 && words(n.heading) === words(twin.source.title)) ? "sr-only" : undefined}>
              {cleanTitle(twin.source.title)}
            </h1>
            {twin.source.credit && <p className="credit">{twin.source.credit}</p>}
            {langNote?.url === twin.source.url && <p className="credit" role="note">{langNote.line}</p>}
            {twin.video && <VideoPlayer key={twin.video.id} twin={twin} onEnrich={enrich} onTour={(n) => void startTour(n)} startAt={startAt ?? undefined} />}
            <p className="overview">
              {summary(twin)} <a href={twin.source.url} target="_blank" rel="noopener">{twin.pdf ? "Original PDF" : twin.video ? "Original video" : "Original page"}</a>
            </p>
            <Nodes nodes={twin.nodes} pageUrl={twin.source.kind === "page" ? twin.source.url : undefined} tourId={tourId} onTour={(n) => void startTour(n)} onLeave={leaveTour} />
          </article>
        ) : (
          <Landing />
        )}
      </div>
      <Pointer />
      {/* Only when the student asks ("show the original page"). A direct child of <main>, so on wide screens it takes the right column (app/globals.css). */}
      {!found && original === twin?.id && twin?.source.kind === "page" && twin.source.via !== "browser" && (
        <div className="arc-live">
          <LivePanel url={twin.source.url} />
        </div>
      )}

      {(items.length > 0 || (!found && !!twin?.video)) && <Reader key={found ? `found:${found.query}` : twin?.id} items={items} paused={tourId !== null} onTour={(n) => void startTour(n)} video={!found && !!twin?.video} blocks={!found} pages={!found ? twin?.pdf?.pages : undefined} lang={!found ? twin?.source.lang : undefined} />}
    </>
  );
}
