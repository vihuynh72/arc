"use client";
// The reading cursor, mounted by components/Twin.tsx. It moves one stop at a time: a section heading, then each block of that
// section (lib/blocks.ts), then the next heading. A figure or a video part is one stop. A band with a thick bar marks the current
// stop and, inside it, the sentence being spoken; the page glides so the stop sits a third of the way down the screen.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Block, TwinNode } from "@/lib/types";
import { blocksOf, isText } from "@/lib/blocks";
import { hintsOn, voiceFirst } from "@/lib/client/display";
import { answering } from "@/lib/client/voice";
import { askHelp } from "@/lib/client/focusVoice";
import { BACK_TO_TOUR, figureLines, HELP_LOCAL, HINTS, isStatusLine, keyAct, paused as pausedLine, rateLine, sectionName, sectionNo, speedKey, tourOffer, UNKNOWN_KEY, type Jump } from "@/lib/keys";
import { inputStyle } from "@/lib/client/command";
import { scrollGoal } from "@/lib/client/pointer";
import { type Chunk, findNode, headSpeech, nodeSpeech, prefetchAhead, said, shortFirst, speaker, splitSentences } from "@/lib/client/reader";

type Props = {
  items: TwinNode[];
  paused: boolean; // a figure tour is open: keys only stop speech
  onTour: (node: TwinNode) => void;
  video?: boolean; // a video twin: moving the cursor does not speak; components/VideoPlayer.tsx follows "arc:cursor" and speaks
  blocks?: boolean; // sections are read block by block (articles and PDFs; not search results or videos)
  pages?: number; // a PDF: its page count, for "Page 4 of 15"
  lang?: string; // the page's language when it is not English: its own words are marked so the voice can refuse them (lib/client/reader.ts)
};

type Stop = { i: number; b: number }; // node index; block index, -1 for the heading (or the whole node)
// near: a step along the page (arrows, reading on): the page only moves when the stop is out of the comfortable middle of the screen.
type Opts = { b?: number; read?: boolean; scroll?: boolean; from?: "scroll"; dir?: 1 | -1; lead?: string[]; near?: boolean; edge?: boolean };
const hinted = new Set<string>(); // tips said this session (lib/keys.ts HINTS): each at most once
const PLURAL: Record<Jump, string> = { heading: "headings", figure: "figures", table: "tables", equation: "equations" };
const isTableNode = (n: TwinNode) => /^table\b/i.test(n.heading.trim());
// Which kind of stop (i, b) is, for H, F, T, E and the number keys.
const stopIs = (L: { items: TwinNode[]; blocks: Block[][] }, i: number, b: number, what: Jump | number) => {
  const n = L.items[i];
  const blk = b >= 0 ? L.blocks[i][b] : undefined;
  const head = b < 0 && n.kind !== "figure" && !isText(n);
  if (typeof what === "number") return head && n.level === what;
  if (what === "heading") return head;
  if (what === "figure") return n.kind === "figure" && !isTableNode(n);
  if (what === "table") return blk?.kind === "table" || ((n.kind === "figure" || isText(n)) && isTableNode(n));
  return blk?.kind === "equation" || (isText(n) && (/^equation$/i.test(n.heading.trim()) || /^equation \d/i.test(n.text)));
};
// The section a stop sits in, for "In: 2.1 Hardware." when a move crosses into another one ("" for a figure: it belongs to the section around it).
const secOf = (n: TwinNode) => (n.kind === "figure" ? "" : isText(n) ? sectionName(n.heading) : n.heading.trim());

const nodeEl = (id: string) => document.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
const GLIDE_MS = 300; // the page moves to the cursor in about this long
const skey = (i: number, b: number) => i * 1e5 + b + 1;
// Where the cursor is, by ids: the clean-up of a page (lib/client/pageFix.ts) can drop blocks, which renumbers the stops but never the ids.
const hereKey = (L: { curId: string; curBlk: string }) => `${L.curId}/${L.curBlk}`;
const clearSpeaking = () => document.querySelectorAll("[data-speaking]").forEach((o) => o.removeAttribute("data-speaking"));

function build(items: TwinNode[], on: boolean) {
  const blocks = items.map((n) => (on && n.kind === "section" ? blocksOf(n) : []));
  const stops: Stop[] = [];
  const first: number[] = []; // index in `stops` of each node's first stop
  items.forEach((n, i) => {
    const text = on && isText(n); // a PDF paragraph has no heading stop of its own; stop (i, b) is at first[i] + b + 1 either way
    first.push(stops.length - (text ? 1 : 0));
    if (!text) stops.push({ i, b: -1 });
    blocks[i].forEach((__, b) => stops.push({ i, b }));
  });
  return { blocks, stops, first };
}

// Where a moved-to stop lands: a third of the way down the screen, never under a sticky header.
const landY = () => {
  const hd = document.querySelector("header");
  return Math.max(window.innerHeight * 0.33, hd && getComputedStyle(hd).position === "sticky" ? hd.getBoundingClientRect().bottom + 24 : 0);
};
// Where `el` should park. A figure card too tall to sit in the lower two thirds goes right under the sticky header, so its whole
// picture is on screen above the bar; everything else takes the landing line.
const landFor = (el: HTMLElement) => {
  const hd = document.querySelector("header");
  const top = hd && getComputedStyle(hd).position === "sticky" ? hd.getBoundingClientRect().bottom + 24 : 24;
  const bar = document.querySelector(".reader")?.getBoundingClientRect().top ?? window.innerHeight;
  return el.matches("figure") && el.getBoundingClientRect().height > (Math.min(window.innerHeight, bar) - top) * 0.55 ? top : landY();
};
// Index in `stops` of the current stop (-1 before the first move).
const stopAt = (L: { index: number; blk: number; first: number[] }) => (L.index < 0 ? -1 : L.first[L.index] + L.blk + 1);
// What the voice says for a stop: a heading says only itself (its blocks are the next stops); anything else is read whole.
const coreLines = (L: { items: TwinNode[]; blocks: Block[][]; on: boolean }, i: number, b: number) => {
  const n = L.items[i];
  if (!(L.on && n.kind === "section")) return nodeSpeech(n);
  return b < 0 ? headSpeech(n) : splitSentences(L.blocks[i][b].say ?? L.blocks[i][b].text);
};
// Where the cursor is, in Arc's own words: what is said instead of a page the voice cannot read.
const where = (L: { items: TwinNode[]; blocks: Block[][]; on: boolean }, i: number, b: number) => {
  const n = L.items[i];
  const count = (kind: string) => [L.items.slice(0, i + 1).filter((x) => x.kind === kind).length, L.items.filter((x) => x.kind === kind).length];
  if (n.kind === "figure") return `Figure ${count("figure").join(" of ")}.`;
  if (L.on && n.kind === "section" && !isText(n)) return b < 0 ? `Section ${count("section").join(" of ")}.` : `Paragraph ${b + 1} of ${L.blocks[i].length}.`;
  return `${i + 1} of ${L.items.length}.`;
};
// A block's first chunk is cut to one clause so its sound starts in about a second; span maps each chunk to its sentence span.
const spokenLines = (L: Parameters<typeof coreLines>[0], i: number, b: number) => {
  const lines = coreLines(L, i, b);
  return b >= 0 || isText(L.items[i]) ? shortFirst(lines) : { lines, span: lines.map((__, k) => k) };
};

export default function Reader({ items, paused, onTour, video = false, blocks: byBlock = true, pages, lang }: Props) {
  const on = byBlock && !video;
  const [pos, setPos] = useState<Stop>({ i: -1, b: -1 });
  const [rate, setRate] = useState(1.25);
  useEffect(() => setRate(speaker.rate), []); // the saved speed (localStorage) is only known in the browser
  const ring = useRef<HTMLDivElement>(null);
  const readOnRef = useRef<(from?: number) => Promise<void>>(async () => {}); // moveTo is defined before readOn
  const moveRef = useRef<(i: number, o?: Opts) => void>(() => {});
  // progUntil: Arc's own scroll is under way, ignore scroll events. settled: the stop last read. raf/timer: the scroll follower.
  // hist: places before each jump, for "go back". reading: bumped by any key or command, ends "keep reading".
  // userAt: the last wheel, touch or bar scroll by the student. moveAt: the last cursor move. anim: the glide.
  const live = useRef({
    items, index: -1, blk: -1, paused, onTour, progUntil: 0, settled: -1, raf: 0, timer: 0, anim: 0, hist: [] as { id: string; b: number }[], reading: 0, userAt: -1e9, moveAt: 0, keyAt: 0,
    video, lang, curId: "", curBlk: "", emitId: "", ahead: new AbortController(), on, pages, page: undefined as number | undefined, ...build(items, on),
    // sec: the section of the last stop. downs: Down presses in a row with no jump (the H tip). figSeen: figures already described.
    // anyAt: the last key, command or sound (the "Paused." line waits for 6 s of nothing). unknownAt: the last "That key does nothing here".
    sec: "", downs: 0, prevNextAt: 0, lastNextAt: 0, figSeen: new Set<string>(), anyAt: 0, escAt: -1e9, unknownAt: -1e9, budget: 0,
    // cut: the stop whose reading was interrupted and the chunk it was on (flow: it was reading on), so Down or "go on" carries on
    // from that sentence instead of skipping the rest. spoke: the chunk now being read, and where the next sentence starts.
    // done: the last stop read to the end. sentence: the last page sentence spoken; heard: the last line of any voice.
    // flowing: readOn is running. quiet: the student said stop (no "Paused." line after it).
    cut: undefined as { key: string; k: number; flow: boolean } | undefined, spoke: undefined as { key: string; k: number; next: number } | undefined,
    done: "", sentence: "", before: "", heard: { text: "", at: 0 }, sentenceAt: 0, flowing: false, quiet: false,
    // placed: the cursor was put here silently (a page opening) and nothing has been read since: the first H may land on it.
    // behind: "One figure is behind you" has been said on this page. figNote: said after the next figure's label.
    placed: false, behind: false, figNote: "",
  });
  useEffect(() => {
    const L = live.current;
    if (L.items !== items || L.on !== on) {
      if (L.items[0]?.id !== items[0]?.id) L.behind = false; // another page
      Object.assign(L, { items, on }, build(items, on));
    }
    L.video = video;
    L.lang = lang;
    L.pages = pages;
    L.paused = paused;
    L.onTour = onTour;
  });

  const hush = useCallback(() => {
    speaker.cancel();
    clearSpeaking();
  }, []);

  // The element that carries aria-current (mark), the one the band is drawn around (ring), and the one the page parks (park).
  const stopEls = useCallback((i: number, b: number) => {
    const L = live.current;
    const n = L.items[i];
    const el = n && nodeEl(n.id);
    if (!el) return null;
    const c = el.querySelector<HTMLElement>("[data-cursor]") ?? el;
    if (!(L.on && n.kind === "section")) return { mark: el, ring: c, park: n.kind === "figure" ? el : c };
    const s = b >= 0 ? (el.querySelector<HTMLElement>(`[data-block-id="${L.blocks[i][b]?.id}"]`) ?? c) : c;
    return { mark: s, ring: s, park: s };
  }, []);

  const place = useCallback(
    (animate: boolean) => {
      const L = live.current;
      const r = ring.current;
      const e = L.index >= 0 ? stopEls(L.index, L.blk) : null;
      if (!r || !e) return;
      const box = e.ring.getBoundingClientRect();
      r.style.transition = animate ? "" : "none";
      const rtl = getComputedStyle(e.ring).direction === "rtl"; // the bar stands on the start side of the line
      r.dataset.dir = rtl ? "rtl" : "ltr";
      r.style.top = `${box.top + window.scrollY - 6}px`;
      r.style.left = `${box.left + window.scrollX - (rtl ? 12 : 22)}px`; // room for the bar at the start
      r.style.width = `${box.width + 34}px`;
      r.style.height = `${box.height + 12}px`;
      r.dataset.on = "true";
    },
    [stopEls],
  );

  // Parts arriving late can land before the cursor, and blocks dropped from a page: it stays on the same node and block, whatever their numbers are now.
  useEffect(() => {
    const L = live.current;
    const k = L.curId ? items.findIndex((n) => n.id === L.curId) : -1;
    if (k < 0) return;
    const at = L.curBlk ? L.blocks[k].findIndex((x) => x.id === L.curBlk) : -1;
    const blk = L.curBlk && at >= 0 ? at : Math.min(L.blk, L.blocks[k].length - 1);
    if (k !== L.index || blk !== L.blk) {
      L.index = k;
      L.blk = blk;
      setPos({ i: k, b: blk });
      place(false); // its band follows the block it was on
    }
  }, [items, place]);

  // Glides the page (about 300 ms, instant when motion is reduced) so `el` sits on the landing line. A new glide starts from where
  // the page is now, so a move that arrives mid-glide never jumps back; a wheel or touch by the student ends it at once.
  const glide = useCallback((el: HTMLElement, near = false) => {
    const L = live.current;
    if (near) {
      // Already in the comfortable middle and whole above the bar: the page stays and the pointer travels to it (components/Pointer.tsx).
      const r = el.getBoundingClientRect();
      const hd = document.querySelector("header");
      const clear = hd && getComputedStyle(hd).position === "sticky" ? hd.getBoundingClientRect().bottom + 24 : 0;
      const bar = document.querySelector(".reader")?.getBoundingClientRect().top ?? window.innerHeight;
      const fits = r.bottom <= Math.min(window.innerHeight, bar) - 24 || r.top <= landFor(el) + 40;
      if (r.top >= Math.max(clear, window.innerHeight * 0.12) && r.top <= window.innerHeight * 0.62 && fits) return;
    }
    cancelAnimationFrame(L.anim);
    const from = window.scrollY;
    const to = Math.max(0, Math.min(el.getBoundingClientRect().top + from - landFor(el), document.documentElement.scrollHeight - window.innerHeight));
    const t0 = performance.now();
    const calm = document.documentElement.dataset.motion === "reduce"; // system setting or the Display panel (lib/client/display.ts)
    L.progUntil = t0 + (calm ? 300 : GLIDE_MS + 300);
    Object.assign(scrollGoal, { y: to, until: t0 + GLIDE_MS + 50 }); // components/Pointer.tsx aims the real pointer at where the page ends up
    if (calm || Math.abs(to - from) < 4) return window.scrollTo({ top: to, behavior: "instant" });
    const run = (now: number) => {
      if (L.userAt > t0) return void (L.progUntil = 0);
      const p = Math.min(1, (now - t0) / GLIDE_MS);
      window.scrollTo({ top: from + (to - from) * (1 - (1 - p) ** 3), behavior: "instant" });
      if (p < 1) L.anim = requestAnimationFrame(run);
    };
    L.anim = requestAnimationFrame(run);
  }, []);

  // The sentence being spoken: marked, and kept on screen when its block is taller than the screen.
  const lit = useCallback(
    (el: HTMLElement | null, k: number) => {
      clearSpeaking();
      const s = el?.querySelectorAll<HTMLElement>("[data-s]")[k];
      if (!s) return;
      s.setAttribute("data-speaking", "true");
      if (live.current.userAt > live.current.moveAt) return; // the student scrolled since the last move: the page stays where they put it
      const r = s.getBoundingClientRect();
      const bar = document.querySelector(".reader")?.getBoundingClientRect().top ?? window.innerHeight;
      if (r.top < landY() - 80 || r.bottom > Math.min(window.innerHeight, bar) - 24) glide(s);
    },
    [glide],
  );

  // Speaks stop (i, b) with the sentence marked as it plays. Resolves true when it was spoken to the end.
  const play = useCallback(
    (i: number, b: number, lead: string[] = [], edge = false, from = 0) => {
      const L = live.current;
      const n = L.items[i];
      const fig = n.kind === "figure" && !!n.image && !L.paused;
      // Arriving on a figure by any means: its description once, then the tour offer ("yes", "tour", Enter start it), the first time only.
      const firstFig = n.kind === "figure" && !L.figSeen.has(n.id);
      if (n.kind === "figure") L.figSeen.add(n.id);
      if (fig) window.dispatchEvent(new CustomEvent("arc:offer", { detail: { name: "tour", args: { id: n.id } } }));
      L.placed = false;
      const fl0 = n.kind === "figure" ? figureLines(n, firstFig) : null;
      const fl = fl0 && L.figNote ? [fl0[0], L.figNote, ...fl0.slice(1)] : fl0;
      L.figNote = "";
      const spoken = fl ? { lines: fl, span: fl.map((__, k) => k) } : spokenLines(L, i, b);
      const span = spoken.span;
      // A page the voice cannot read: only Arc's own place line is spoken, never the words (components/Twin.tsx says why, once).
      const held = !!L.lang && speaker.blocked === L.lang;
      // A block's `say` (an equation or table put into words) is English whatever the page's language: it goes to the English voice.
      const own = !!L.lang && !(b >= 0 && L.blocks[i][b]?.say);
      const all: Chunk[] = held ? [where(L, i, b)] : spoken.lines.map((text) => (own ? { text, lang: L.lang! } : text));
      const skip = held ? 0 : Math.min(from, all.length); // resuming a cut stop: from the sentence that was cut, with nothing before it
      const body = all.slice(skip);
      const el = !held && b >= 0 && !L.blocks[i][b]?.say ? stopEls(i, b)?.mark : null; // spoken text equals shown text: sentence k is span k
      // A PDF stop on another page than the last one spoken starts with "Page 4 of 15." (said once, when the cursor crosses), before anything else.
      // The first stop spoken counts as a crossing too: "go to page 3" right after the PDF opens must name the page.
      const crossed = n.page != null && L.page !== n.page && !!L.pages && !skip;
      if (n.page != null) L.page = n.page;
      // At most one tip, before the stop's own words (a tip after a long paragraph is never reached), each once per session
      // (Display: Hints), and never while the student is moving fast (Downs under 1.5 s apart).
      const calm = performance.now() - L.prevNextAt > 1500;
      const tip = !hintsOn() || skip ? "" : crossed && !hinted.has("page") ? "page" : L.downs >= 4 && calm && !hinted.has("heading") ? "heading" : "";
      const pre = [...(crossed ? [`Page ${n.page} of ${L.pages}.`] : []), ...(skip ? [] : lead), ...(tip ? [HINTS[tip as keyof typeof HINTS]] : [])];
      const tipAt = tip ? pre.length - 1 : -1;
      // After the stop: the tour offer the first time, and the end of the page.
      const last = L.first[i] + b + 1 === L.stops.length - 1 && !L.video && (!L.pages || n.page === L.pages);
      const post = [...(fig && firstFig ? [tourOffer(inputStyle())] : []), ...(last && !edge ? ["End of the page."] : [])];
      // While this stop plays, the next stop's first clip is made (the server makes this stop's own clips first). The old one is
      // dropped a moment later, not at once: a move onto that same stop has asked for it by then, and the server keeps a wanted clip.
      const key = hereKey(L);
      L.spoke = undefined;
      if (L.cut?.key === key) L.cut = undefined; // read again from the start or from the cut: a new cut is noted below
      let bodyDone = !body.length;
      const prev = L.ahead;
      setTimeout(() => prev.abort(), 400);
      const ahead = (L.ahead = new AbortController());
      const nx = L.stops[L.first[i] + b + 2];
      const next = nx && !L.video ? spokenLines(L, nx.i, nx.b).lines[0] : "";
      if (next) prefetchAhead(next, ahead.signal, L.lang);
      return speaker.say([...pre, ...body, ...post], (k) => {
        if (k === tipAt) {
          hinted.add(tip);
          if (tip === "heading") L.downs = 0;
        }
        const j = k - pre.length + skip; // the chunk of the stop's own words
        if (k >= pre.length + body.length) bodyDone = true;
        else if (k >= pre.length && !held) {
          let next = j + 1;
          while (next < span.length && span[next] === span[j]) next++;
          L.spoke = { key, k: j, next };
          const now = spoken.lines.filter((__, x) => span[x] === span[j]).join(" ");
          if (now !== L.sentence) [L.before, L.sentence, L.sentenceAt] = [L.sentence, now, performance.now()];
        }
        if (el) lit(el, span[k - pre.length + skip] ?? -1);
      }).then((ok) => {
        if (ok && hereKey(L) === key) clearSpeaking();
        if (ok || bodyDone) L.done = key;
        else if (L.spoke?.key === key) L.cut = { key, k: L.spoke.k, flow: L.flowing };
        else if (!skip) L.cut = { key, k: 0, flow: L.flowing }; // cut before its words began: the whole stop again
        else L.cut = { key, k: skip, flow: L.flowing };
        return ok;
      });
    },
    [stopEls, lit],
  );

  const moveTo = useCallback(
    (i: number, opts: Opts = {}) => {
      const L = live.current;
      const node = L.items[i];
      const floor = node && L.on && isText(node) ? 0 : -1; // a PDF paragraph is always its block
      const b = Math.max(floor, Math.min(opts.b ?? -1, (L.blocks[i]?.length ?? 0) - 1));
      const els = node && stopEls(i, b);
      if (!node || !els) return;
      document.querySelectorAll('[aria-current="true"]').forEach((o) => o.removeAttribute("aria-current"));
      clearSpeaking();
      els.mark.setAttribute("aria-current", "true");
      L.index = i;
      L.blk = b;
      L.curId = node.id;
      L.curBlk = b >= 0 && L.on && node.kind === "section" ? (L.blocks[i][b]?.id ?? "") : "";
      // Into another section by a move onto one of its paragraphs: its name first ("In: 2.1 Hardware."). A heading says itself.
      const sec = secOf(node);
      const into = L.on && b >= 0 && !!sec && !!L.sec && sec !== L.sec && opts.from !== "scroll" ? [`In: ${headSpeech({ ...node, heading: sec })[0]}.`] : [];
      if (sec) L.sec = sec;
      setPos({ i, b });
      if (opts.from === "scroll") return place(true); // the user's own scroll: the ring follows, the settle timer announces
      L.settled = skey(i, b);
      L.moveAt = performance.now();
      if (opts.scroll !== false) glide(els.park, opts.near);
      place(true);
      // The node-level event: when the node changes (always, where nodes are the stops). Block moves have their own.
      if (!L.on || L.emitId !== node.id) {
        L.emitId = node.id;
        const figureIndex = node.kind === "figure" ? L.items.slice(0, i + 1).filter((n) => n.kind === "figure").length : undefined;
        window.dispatchEvent(new CustomEvent("arc:cursor", { detail: { id: node.id, kind: node.kind, heading: node.heading, figureIndex, back: L.hist.length > 0, read: opts.read !== false, page: node.page, pages: L.pages } }));
      }
      if (L.on && node.kind === "section") {
        const blk = b >= 0 ? L.blocks[i][b] : null;
        window.dispatchEvent(new CustomEvent("arc:block", { detail: { id: node.id, block: b, blocks: L.blocks[i].length, text: blk?.text ?? "" } }));
      }
      if (opts.read === false && node.page != null) L.page = node.page; // a silent move across pages counts as crossing too
      if (opts.read === false || L.video) return;
      const fig = node.kind === "figure" && !!node.image && !L.paused;
      const vf = voiceFirst();
      const mine = L.reading;
      const key = hereKey(L);
      // Voice first: where it landed, then reading runs on, forward only (a move back reads the stop it lands on, then waits).
      // Otherwise one stop; a heading carries on into its first block when moving forward.
      const fwd = (opts.dir ?? 1) > 0;
      void play(i, b, [...(opts.lead ?? []), ...into, ...(vf && b < 0 ? [`${i + 1} of ${L.items.length}.`] : [])], opts.edge).then((ok) => {
        if (!ok || mine !== L.reading || hereKey(L) !== key || fig) return;
        if (vf && fwd) void readOnRef.current(stopAt(L) + 1);
        else if (b < 0 && (opts.dir ?? 1) > 0 && L.blocks[i].length) moveRef.current(i, { b: 0, dir: 1, near: true });
      });
    },
    [stopEls, place, glide, play],
  );

  const step = useCallback(
    (by: 1 | -1, heading: boolean | "figure" = false, steps = 1, skip = false) => {
      const L = live.current;
      const list = L.items;
      // A stop cut off by a question or a command (not by a move): the next Down carries on from the sentence that was cut.
      if (!heading && by > 0 && steps === 1 && !skip && L.index >= 0 && L.cut?.key === hereKey(L)) {
        const { i, b, k } = { i: L.index, b: L.blk, k: L.cut.k };
        const mine = L.reading;
        const key = hereKey(L);
        void play(i, b, [], false, k).then((ok) => {
          if (ok && mine === L.reading && hereKey(L) === key && b < 0 && L.blocks[i].length) moveRef.current(i, { b: 0, dir: 1, near: true });
        });
        return list[i];
      }
      const end = (h: boolean | "figure") => (h === "figure" ? (by > 0 ? "No more figures." : "No figures before this.") : by > 0 ? "That is the last one." : "That is the first one.");
      if (heading) {
        // A jump to the next (or previous) section heading, or figure. A heading jumps to the next heading at its own level or above
        // ("skip this section"); when there is none (a page with one h2 and h3s below it) to the next heading of any level.
        // Backwards from inside a section the first stop is that section's own heading.
        if (heading === true && by < 0 && L.blk >= 0 && L.on && L.index >= 0 && !isText(list[L.index])) {
          moveTo(L.index, { dir: by, near: true });
          return list[L.index];
        }
        const own = list[L.index]?.level ?? 9;
        const find = (ok: (n: TwinNode) => boolean) => {
          for (let i = L.index + by; i >= 0 && i < list.length; i += by) if (ok(list[i])) return i;
          return -1;
        };
        const head = (n: TwinNode) => n.kind !== "figure" && !isText(n);
        const i = heading === "figure" ? find((n) => n.kind === "figure") : [find((n) => head(n) && (n.level ?? 9) <= own), find(head)].find((k) => k >= 0) ?? -1;
        if (i < 0) {
          void speaker.say([end(heading)]);
          return null;
        }
        moveTo(i, { dir: by, near: true });
        return list[i];
      }
      const s = stopAt(live.current);
      let t = s + by;
      if (steps > 1) t = Math.min(Math.max(s + by * steps, 0), L.stops.length - 1); // one combined move; read only where it lands
      if (t < 0 || t >= L.stops.length) {
        if (L.video && by > 0) window.dispatchEvent(new CustomEvent("arc:video", { detail: "more" })); // the player knows whether more parts are coming
        else void speaker.say([end(false)]);
        return null;
      }
      moveTo(L.stops[t].i, { b: L.stops[t].b, dir: by, near: true });
      return list[L.stops[t].i];
    },
    [moveTo, play],
  );

  // H, F, T, E (Shift: backwards) and 1 to 4: the next stop of that kind, in page order.
  const jumpTo = useCallback(
    (what: Jump | number, by: 1 | -1) => {
      const L = live.current;
      L.downs = 0;
      const name = typeof what === "number" ? `level ${what} headings` : PLURAL[what];
      const from = by > 0 && L.placed ? stopAt(L) : stopAt(L) + by; // a page just opened: its first heading counts
      for (let s = from; s >= 0 && s < L.stops.length; s += by) {
        const st = L.stops[s];
        if (!stopIs(L, st.i, st.b, what)) continue;
        if (what === "figure" && by > 0 && !L.behind) {
          // Once a page: F from the middle names the figures it passed (not the one it leaves), and how to reach them.
          const back = L.items.slice(0, Math.max(L.index, 0)).filter((n) => n.kind === "figure" && !isTableNode(n)).length;
          if (back) [L.behind, L.figNote] = [true, `${back === 1 ? "One figure is" : `${back} figures are`} behind you: Shift F.`];
        }
        if (L.index >= 0) L.hist.push({ id: L.items[L.index].id, b: L.blk });
        moveTo(st.i, { b: st.b, dir: by, near: true });
        return;
      }
      const any = L.stops.some((st) => stopIs(L, st.i, st.b, what));
      const partial = !!L.pages && (L.items.at(by > 0 ? -1 : 0)?.page ?? 0) !== (by > 0 ? L.pages : 1); // a PDF loads its pages as they are reached
      void speaker.say([partial ? `No ${by > 0 ? "more " : ""}${name} on the pages loaded so far. Down arrow loads more.` : !any ? `There are no ${name} on this page.` : by > 0 ? `No more ${name}.` : `No ${name} before this.`]);
    },
    [moveTo],
  );

  const readAgain = useCallback(() => {
    const L = live.current;
    const n = L.items[L.index];
    if (n && L.video) window.dispatchEvent(new CustomEvent("arc:replay", { detail: { id: n.id } })); // the player repeats the part
    else if (n) void play(L.index, L.blk);
    else step(1);
  }, [step, play]);

  // "more": read on from the current stop until anything else happens, block to block across sections.
  // Stops when a reading is cancelled (any key, Escape, "stop"), when the cursor moves some other way, and in voice
  // first at a figure (its caption, then the tour offer).
  // through: past figures too (asked for by voice: "keep reading" means the whole page); chunk: the first stop starts there (a cut one).
  const readOn = useCallback(
    async (from?: number, o: { chunk?: number; through?: boolean } = {}) => {
      const L = live.current;
      const mine = ++L.reading;
      let chunk = o.chunk ?? 0;
      L.flowing = true;
      for (let s = from ?? Math.max(stopAt(live.current), 0); s < L.stops.length && mine === L.reading; ) {
        const { i, b } = L.stops[s];
        moveTo(i, { read: false, b, near: true });
        const n = L.items[i];
        const fig = n.kind === "figure" && !!n.image;
        const key = hereKey(L);
        const ok = await play(i, b, [], false, chunk);
        chunk = 0;
        if (!ok || (fig && !o.through) || hereKey(L) !== key || L.curId !== n.id) break;
        s = stopAt(L) + 1; // not s + 1: blocks dropped from the page meanwhile renumber the stops
      }
      if (mine === L.reading) L.flowing = false;
    },
    [moveTo, play],
  );
  // "go on", "keep reading": from the sentence that was cut, else after the stop just read, else from here (the top before any move).
  const carryOn = useCallback(() => {
    const L = live.current;
    const k = hereKey(L);
    const s0 = Math.max(stopAt(L), 0);
    if (L.index >= 0 && L.cut?.key === k) return void readOn(s0, { chunk: L.cut.k, through: true });
    if (L.index >= 0 && L.done === k) {
      if (s0 + 1 >= L.stops.length) return void speaker.say(["That is the end of the page."]);
      return void readOn(s0 + 1, { through: true });
    }
    void readOn(s0, { through: true });
  }, [readOn]);
  // After a speed change or a repeated sentence by voice, reading that was running carries on (after the next sentence starts).
  const resumeFlow = useCallback(
    (after?: number) => {
      const L = live.current;
      const c = L.cut;
      if (!c?.flow || c.key !== hereKey(L) || inputStyle() !== "voice") return false;
      void readOn(Math.max(stopAt(L), 0), { chunk: after ?? c.k, through: true });
      return true;
    },
    [readOn],
  );
  useEffect(() => {
    readOnRef.current = readOn;
    moveRef.current = moveTo;
  }, [readOn, moveTo]);

  const faster = useCallback((by: number) => {
    const r = speaker.setRate(speaker.rate + by);
    setRate(r);
    if (live.current.video) return; // the lecture may be playing: VideoPlayer gives its own tick
    void speaker.say([rateLine(by > 0 ? "faster" : "slower", r)]);
  }, []);

  // P (play or pause), V (the other way to follow) and Escape, for a video: sent after the voice is cancelled, so the player speaks last.
  const vid = useCallback(
    (action: "toggle" | "mode" | "stop" | "resume") => {
      hush();
      live.current.reading++;
      window.dispatchEvent(new CustomEvent("arc:video", { detail: action }));
    },
    [hush],
  );

  // Home and End: the first and the last stop.
  const edge = useCallback(
    (last: boolean) => {
      const L = live.current;
      const first = L.items[0]?.page;
      if (!last && L.pages && first && first > 1) return void window.dispatchEvent(new CustomEvent("arc:command", { detail: { name: "page", args: { n: 1 } } })); // Home in a PDF whose first pages are not loaded
      const st = L.stops[last ? L.stops.length - 1 : 0];
      if (!st) return;
      const page = L.items[st.i].page;
      const left = last && L.pages && page ? L.pages - page : 0; // End loads nothing: it says how many pages follow
      const lead = left > 0 ? `End of page ${page}. ${left} ${left === 1 ? "page remains" : "pages remain"}.` : last ? "End of page. Last item:" : "Top of page.";
      moveTo(st.i, { b: st.b, dir: last ? -1 : 1, lead: [lead], edge: true });
    },
    [moveTo],
  );

  // Help ("?"): the help command (lib/intent.ts words it for the mode); if nobody has spoken a moment later, the key list here.
  const help = useCallback(() => askHelp(HELP_LOCAL), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      const t = e.target as HTMLElement;
      const typing = !!t.closest?.("input, textarea, select, [contenteditable='true']");
      // Command (Control off a Mac) with Right or Left Arrow: faster or slower, everywhere but a text field (there they move the caret).
      // They are Chrome's forward and back on a Mac: never while Arc's page has the keys. A tour answers them itself (components/FigureTour.tsx).
      const sp = speedKey(e);
      if (sp) {
        if (typing) return;
        e.preventDefault();
        if (live.current.paused) return;
        hush();
        live.current.reading++;
        window.dispatchEvent(new CustomEvent("arc:command", { detail: { name: sp } })); // the voice command's path: the video follows it (components/VideoPlayer.tsx)
        return;
      }
      if (["PageUp", "PageDown"].includes(e.key) && !typing) live.current.userAt = performance.now(); // the user scrolls by key
      const arrow = e.key.startsWith("Arrow");
      // A held arrow: act on the first press, then at most every 350 ms, so a press held a little long never moves two.
      if (arrow && e.repeat && !live.current.paused && !typing && performance.now() - live.current.keyAt < 350) return void e.preventDefault();
      if (e.key === "Escape") clearSpeaking(); // components/AskButton.tsx has stopped the voice (or says that nothing was playing)
      // Any key stops the voice at once. Not a media key the lecture player has just acted on (it runs first and marks the key
      // handled): its second K starts the reading again, and stopping the voice here undid that, so K only ever paused.
      else if (!(live.current.video && e.defaultPrevented && /^[jkl<>]$/i.test(e.key))) hush();
      live.current.reading++;
      if (live.current.paused && (e.key === "r" || e.key === "R") && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        window.dispatchEvent(new CustomEvent("arc:command", { detail: { name: "read" } })); // R in a tour repeats the stop
        return void e.preventDefault();
      }
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector("dialog[open]")) {
        live.current.escAt = performance.now(); // a deliberate stop: the "Paused." line comes sooner
        // Escape always says where it leaves the student. Out of the ask box (CommandBox puts focus back), after this key's
        // other listeners have stopped the voice; outside the tour's own keys while a tour is open, it leaves the tour.
        if (typing && t.closest(".command")) setTimeout(() => void speaker.say([live.current.paused ? BACK_TO_TOUR : `Back to the page. ${document.querySelector(".reader-pos")?.textContent ?? ""}.`]), 0);
        else if (live.current.paused && !typing && !t.closest("[data-tour]")) window.dispatchEvent(new CustomEvent("arc:command", { detail: { name: "leave" } }));
      }
      if (live.current.paused && e.key === "?" && !typing && !t.closest("[data-tour]")) return void (e.preventDefault(), help()); // the tour's own keys answer ? themselves
      // A combination with a moving key that Arc does not use (Command with Up): the same short line as an unknown key, at most every 4 s.
      if (!live.current.paused && !typing && !e.defaultPrevented && (e.ctrlKey || e.metaKey || e.altKey) && /^(?:Arrow|Home$|End$|Enter$|Page)/.test(e.key)) {
        if (performance.now() - live.current.unknownAt > 4000) void speaker.say([UNKNOWN_KEY]);
        live.current.unknownAt = performance.now();
        return;
      }
      if (live.current.paused || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (typing) return;
      const k = e.key;
      if (live.current.video && (k === "<" || k === ">")) setTimeout(() => setRate(speaker.rate), 0); // VideoPlayer changed the speed: the number on screen follows
      const a = keyAct(e, live.current.video);
      if (!a) return;
      if (arrow) live.current.keyAt = performance.now();
      if (k === "Enter" && t.closest("button, a, summary")) return; // let the control act
      if (a.act !== "next") live.current.downs = 0;
      if (a.act === "next" || a.act === "prev") {
        if (a.act === "next") {
          live.current.downs++;
          live.current.prevNextAt = live.current.lastNextAt;
          live.current.lastNextAt = performance.now();
        }
        step(a.act === "next" ? 1 : -1);
      } else if (a.act === "nextSection" || a.act === "prevSection") step(a.act === "nextSection" ? 1 : -1, true);
      else if (a.act === "jump") jumpTo(a.what, a.by);
      else if (a.act === "level") jumpTo(a.level, e.shiftKey ? -1 : 1);
      else if (a.act === "top" || a.act === "end") edge(a.act === "end");
      else if (a.act === "enter") {
        const n = live.current.items[live.current.index];
        if (n?.image && (n.kind === "figure" || n.kind === "segment")) live.current.onTour(n); // Enter on a figure, or a video part with a picture, starts its tour
        else readAgain();
      }
      else if (a.act === "again") readAgain(); // replay on every kind of item, figures too
      else if (a.act === "play" || a.act === "mode") vid(a.act === "play" ? "toggle" : "mode");
      else if (a.act === "escape") {
        if (live.current.video) vid("stop");
        return; // components/AskButton.tsx stops both voices, or says once that nothing is playing
      }
      else if (a.act === "faster" || a.act === "slower") faster(a.act === "faster" ? 0.1 : -0.1);
      else if (a.act === "help") help();
      else {
        // A character that does nothing here: one short line, at most every 4 s.
        if (performance.now() - live.current.unknownAt > 4000) void speaker.say([UNKNOWN_KEY]);
        live.current.unknownAt = performance.now();
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, readAgain, faster, vid, edge, hush, jumpTo, help]);


  // Hosted and out of model budget: the Gemini voice answers every line with the same recorded notice. Reading stops at once, the
  // notice is said once per session (a short line after that), and the cursor stays where it is, so the keys go on working.
  useEffect(() => {
    const onBudget = (e: Event) => {
      const L = live.current;
      L.reading++;
      L.ahead.abort();
      hush();
      const line = (e as CustomEvent<{ say?: string }>).detail?.say;
      void speaker.say([L.budget++ || !line ? "Still out of voice credit." : line]);
    };
    window.addEventListener("arc:budget", onBudget);
    return () => window.removeEventListener("arc:budget", onBudget);
  }, [hush]);

  // Silence after an interruption (Escape, a Space tap, a cut reading): after 6 s of nothing at all, one quiet line, once per pause.
  useEffect(() => {
    const L = live.current;
    const any = () => void (L.anyAt = performance.now());
    const timer = setInterval(() => {
      const now = performance.now();
      if (L.paused || L.video || speaker.busy || answering() || document.querySelector(".mic[aria-pressed='true'], dialog[open]")) return;
      // After a deliberate Escape (and nothing since), about 2 s; after any other interruption, 6 s.
      const wait = L.escAt >= L.anyAt - 50 ? 2000 : 6000;
      if (L.quiet || speaker.cutAt <= speaker.sayAt || now - Math.max(speaker.cutAt, L.anyAt) < wait) return;
      void speaker.say([pausedLine(inputStyle())]);
    }, 1000);
    for (const ev of ["keydown", "pointerdown", "arc:command", "arc:heard"]) window.addEventListener(ev, any, true);
    return () => {
      clearInterval(timer);
      for (const ev of ["keydown", "pointerdown", "arc:command", "arc:heard"]) window.removeEventListener(ev, any, true);
    };
  }, []);

  // The last line any voice said that was not the page's own words (an answer, a line of Arc's), for "pardon".
  useEffect(() => {
    const L = live.current;
    const onHeard = (e: Event) => {
      const d = (e as CustomEvent<{ kind: string; voice?: string; text?: string; phase?: string }>).detail;
      const t = d?.kind === "speech" ? d.text?.trim() : "";
      if (!t || t === "One moment." || (d.voice === "arc" ? d.phase !== "start" : d.phase === "start")) return;
      if (d.voice === "arc" && L.sentence.includes(t)) return; // a chunk of the page sentence being read
      if (d.voice === "arc" && isStatusLine(t)) return; // "say that again" repeats what was read or answered, never Arc's own status lines
      L.heard = { text: t, at: performance.now() };
    };
    window.addEventListener("arc:heard", onHeard);
    return () => window.removeEventListener("arc:heard", onHeard);
  }, []);

  // The pointer over a figure's picture outside a tour: one line, once per figure, never over speech (a tour guides the pointer itself).
  useEffect(() => {
    const told = new Set<string>();
    const onOver = (e: PointerEvent) => {
      const L = live.current;
      const fig = (e.target as HTMLElement).closest?.("#content figure");
      const id = fig?.getAttribute("data-node-id");
      if (!id || told.has(id) || L.paused || speaker.busy || !(e.target as HTMLElement).closest(".figpic")) return;
      const n = L.items.find((x) => x.id === id);
      if (!n) return;
      told.add(id);
      void speaker.say([`${n.heading}. Click the picture for a guided tour.`]);
    };
    document.addEventListener("pointerover", onOver);
    return () => document.removeEventListener("pointerover", onOver);
  }, []);

  // Tab with focus nowhere yet (on the page body): from the control nearest the reading cursor, not from the top of the page.
  useEffect(() => {
    const onTab = (e: KeyboardEvent) => {
      const L = live.current;
      const a = document.activeElement;
      if (e.key !== "Tab" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || L.paused || L.index < 0 || (a && a !== document.body && a !== document.documentElement)) return;
      const at = nodeEl(L.items[L.index].id);
      if (!at) return;
      const next = [...document.querySelectorAll<HTMLElement>("#content a[href], #content button:not([disabled]), #content [tabindex]:not([tabindex='-1'])")].find(
        (el) => el.offsetParent !== null && (at === el || !!(at.compareDocumentPosition(el) & (Node.DOCUMENT_POSITION_FOLLOWING | Node.DOCUMENT_POSITION_CONTAINED_BY))),
      );
      if (!next) return;
      e.preventDefault();
      next.focus();
    };
    window.addEventListener("keydown", onTab, true);
    return () => window.removeEventListener("keydown", onTab, true);
  }, []);

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

  // A click or tap on a heading or a paragraph makes it current and reads it, in place: no scroll. Controls, drags, selections, modified clicks and tours are left alone.
  useEffect(() => {
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => void (down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null);
    const onUp = (e: PointerEvent) => {
      const start = down;
      down = null;
      const L = live.current;
      if (!start || e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || L.paused) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6 || !(window.getSelection()?.isCollapsed ?? true)) return;
      const t = e.target as HTMLElement;
      if (!t.closest?.("#content") || t.closest("a, button, summary, input, textarea, select, label, [contenteditable='true'], [data-tour], figure [data-tour-pic]")) return; // a figure's picture starts its tour (components/twin/Nodes.tsx)
      const i = L.items.findIndex((n) => n.id === t.closest("[data-node-id]")?.getAttribute("data-node-id"));
      if (i < 0) return; // blank space between items
      let b = -1;
      if (L.on && L.items[i].kind === "section") {
        const bid = t.closest("[data-block-id]")?.getAttribute("data-block-id");
        b = L.blocks[i].findIndex((x) => x.id === bid);
        if (b < 0 && !t.closest("[data-cursor]")) return; // the gap between two blocks
      }
      hush();
      L.reading++;
      moveTo(i, { scroll: false, b });
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
  }, [moveTo, hush]);

  // The user scrolls (wheel, touch, bar, Page keys, screen reader): the cursor follows the stop nearest the landing line.
  // The page is never scrolled back and focus never moves. Once still for 450 ms the stop is read, once.
  useEffect(() => {
    const L = live.current;
    const born = performance.now() + 1000;
    L.progUntil = born; // a new page may clamp the scroll position
    // Only a scroll the user is making moves the cursor: a wheel, touch, Page key or scrollbar press in the last 250 ms.
    // Arc's own glides, images and figures loading, panels resizing and anchor jumps never do (they skipped items).
    const idle = () => L.paused || performance.now() - L.userAt > 250 || performance.now() < L.progUntil || !!document.activeElement?.closest("input, textarea, select, [contenteditable='true']");
    const mark = () => {
      L.userAt = performance.now();
      cancelAnimationFrame(L.anim); // the student's hand wins over a glide in progress
      L.progUntil = 0;
    };
    const onBar = (e: PointerEvent) => void (e.clientX >= document.documentElement.clientWidth && mark()); // the scrollbar sits outside clientWidth
    const follow = () => {
      L.raf = 0;
      const hd = document.querySelector("header");
      const clear = hd && getComputedStyle(hd).position === "sticky" ? hd.getBoundingClientRect().bottom + 24 : -Infinity;
      const land = landY();
      const nodes = new Map<string, HTMLElement>();
      document.querySelectorAll<HTMLElement>("#content [data-node-id]").forEach((el) => nodes.set(el.dataset.nodeId!, el));
      const blocks = new Map<string, HTMLElement>();
      document.querySelectorAll<HTMLElement>("#content [data-block-id]").forEach((el) => blocks.set(el.dataset.blockId!, el));
      let best = -1;
      let gap = Infinity;
      L.stops.forEach((st, s) => {
        const n = L.items[st.i];
        const ne = nodes.get(n.id);
        const el = st.b >= 0 ? blocks.get(L.blocks[st.i][st.b].id) : ne && (n.kind === "figure" ? ne : (ne.querySelector<HTMLElement>("[data-cursor]") ?? ne));
        if (!el) return;
        const top = el.getBoundingClientRect().top;
        const d = Math.abs(top - land) + (top < clear ? 1e6 : 0); // a stop under the header only wins when nothing else is on screen
        if (d < gap) [best, gap] = [s, d];
      });
      if (best >= 0 && best !== stopAt(live.current)) {
        speaker.cancel(); // the user scrolled to another stop; a scroll that stays on it (images loading) must not cut its reading
        moveTo(L.stops[best].i, { from: "scroll", b: L.stops[best].b });
      }
    };
    const onScroll = () => {
      if (idle()) return;
      L.userAt = performance.now(); // keep following while the user's scroll is still moving (momentum, a dragged bar)
      L.raf ||= requestAnimationFrame(follow);
      clearTimeout(L.timer);
      L.timer = window.setTimeout(() => {
        if (!idle() && L.index >= 0 && skey(L.index, L.blk) !== L.settled) moveTo(L.index, { b: L.blk, scroll: false, read: L.video ? false : undefined }); // a video seeks on Enter, not on a scroll
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
      cancelAnimationFrame(L.anim);
      clearTimeout(L.timer);
    };
  }, [moveTo]);

  // Keep the ring on its stop when the layout changes (zoom, images loading).
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
      const L = live.current;
      const { items: list, index: at } = L;
      if (L.paused && name !== "stop") return;
      L.quiet = name === "stop";
      // The cut stop and the sentence last read, before this command's own reading replaces them.
      const cut = L.cut;
      L.reading++;
      const jump = (i: number) => void (i !== at && at >= 0 && L.hist.push({ id: list[at].id, b: L.blk })); // by id: pages can be added before the cursor
      // Landing on a figure by a jump: read its caption, then offer the tour ("yes" or "tour" starts it).
      const land = (i: number) => moveTo(i); // a figure reads its caption and offers the tour
      const steps = Math.min(Number(args?.steps) || 1, 10);
      if (name === "next" && steps === 1 && L.on && !L.video && inputStyle() === "voice") {
        // By voice "next" moves one stop and reads on from there: it means the next one, never the cut paragraph again ("go on" resumes that).
        if (stopAt(L) + 1 >= L.stops.length) void speaker.say(["That is the last one. Say go back, or ask me about the page."]);
        else void readOn(stopAt(L) + 1, { through: true });
        said("Reading on.");
      } else if (name === "next" || name === "prev") {
        const n = step(name === "next" ? 1 : -1, false, steps, !!args?.skip);
        said(n ? `Moved to ${n.heading}.` : name === "next" ? "That is the last one." : "That is the first one.");
      } else if (name === "nextFigure" || name === "prevFigure" || name === "nextHeading" || name === "prevHeading") {
        const by = name.startsWith("next") ? 1 : -1;
        const figure = name.endsWith("Figure");
        const from = { i: at, b: L.blk };
        const n = step(by, figure ? "figure" : true);
        if (n) {
          if (from.i >= 0) L.hist.push({ id: list[from.i].id, b: from.b });
          said(`Moved to ${n.heading}.`);
        } else said(figure ? "No more figures." : by > 0 ? "That is the last one." : "That is the first one.");
      } else if (name === "return") {
        const back = L.hist.pop();
        const to = back ? list.findIndex((n) => n.id === back.id) : -1;
        if (!back || to < 0) {
          // Nothing to return from: "go back" is the previous stop.
          const n = step(-1);
          said(n ? `Moved to ${n.heading}.` : "That is the first one.");
        } else {
          moveTo(to, { read: false, b: back.b });
          said(`Back to ${list[to].heading}.`);
          void speaker.say([`Back to ${list[to].heading}.`]);
        }
      } else if (name === "continue") {
        if (L.video) return void vid("resume"); // "go on" after a pause: the lecture carries on (components/VideoPlayer.tsx)
        L.cut = cut;
        if (args?.from === "top") void readOn(0, { through: true });
        else carryOn();
      } else if (name === "play") {
        if (L.video) vid("toggle");
      } else if (name === "seek") {
        // What J and L do (components/VideoPlayer.tsx listens for the keys themselves).
        if (L.video) window.dispatchEvent(new KeyboardEvent("keydown", { key: Number(args?.by) < 0 ? "j" : "l", bubbles: true }));
      } else if (name === "faster" || name === "slower") {
        const r = speaker.setRate(args?.normal ? 1 : speaker.rate + (name === "faster" ? 0.1 : -0.1) * (Number(args?.steps) || 1));
        setRate(r);
        const line = rateLine(args?.normal ? "normal" : name, r);
        said(line);
        L.cut = cut;
        if (L.video) return; // the lecture may be playing: VideoPlayer follows the speed with its own tick, never words over the teacher
        void speaker.say([line]).then((ok) => ok && L.cut === cut && resumeFlow());
      } else if (name === "goto") {
        const byId = args?.id ? list.findIndex((n) => n.id === args.id) : -1;
        const byAt = typeof args?.at === "number" && list[args.at] ? args.at : -1;
        const i = byAt >= 0 ? byAt : byId >= 0 ? byId : findNode(list, String(args?.query ?? ""));
        if (i < 0) {
          said(`I could not find ${String(args?.query ?? "that")}.`);
          void speaker.say([`I could not find ${String(args?.query ?? "that")}.`]);
        }
        else if (args?.silent) {
          moveTo(i, { read: false, b: typeof args.b === "number" ? args.b : undefined, scroll: !args.follow || performance.now() - L.userAt > 6000 });
          L.placed = !args.follow;
          if (args.resume) L.done = hereKey(L); // put back after a reload: the block counts as read, so "go on" carries on after it
        } // Twin places the cursor on new content and speaks its own line; follow: the video moved on, never scroll a student who scrolled lately
        else {
          jump(i);
          land(i);
          said(`Moved to ${list[i].heading}.`);
        }
      } else if (name === "read" && args?.sentence) {
        // "say that again", "pardon": the last sentence heard. When the last thing said was not the page (an answer, Arc's own
        // line), that line; then reading that was running carries on after the sentence.
        // Cut in the first moment of a sentence: the one before it is the last one heard, and reading carries on from the cut one.
        const other = !args.page && L.heard.text && L.heard.at > L.sentenceAt && L.heard.text !== L.sentence;
        // "the last sentence" by name: the one being spoken, unless it was cut before any of it was heard (padding and first word).
        const early = !other && !!L.before && speaker.cutAt >= L.sentenceAt && speaker.cutAt - L.sentenceAt < (args.page ? 700 : 1500);
        const line = other ? L.heard.text : early ? L.before : L.sentence;
        if (!line) return void readAgain();
        said(line);
        L.cut = cut;
        const after = other || L.spoke?.key !== cut?.key ? undefined : early ? cut?.k : L.spoke?.next;
        void speaker.say(splitSentences(line)).then((ok) => ok && L.cut === cut && resumeFlow(after));
      } else if (name === "read") {
        readAgain();
        said("Reading again.");
      } else if (name === "stop") {
        hush();
        said("Stopped.");
        // Asked for in words: one short line at once, so a talker knows she was heard (a tour says its own; a key's Escape has its own, later).
        if (!L.paused && !L.video && inputStyle() !== "keys") void speaker.say([pausedLine(inputStyle())]);
      } else if (name === "tour") {
        const figs = list.filter((n) => n.kind === "figure");
        const byId = args?.id ? figs.find((n) => n.id === args.id) : undefined;
        const wanted = args?.figure != null ? figs.find((n) => n.heading.toLowerCase() === `figure ${args.figure}`) : undefined;
        // The figure under the cursor, else the next one after it, else the last one before it.
        const near = list[at]?.kind === "figure" ? list[at] : (list.slice(at + 1).find((n) => n.kind === "figure") ?? list.slice(0, Math.max(at, 0)).reverse().find((n) => n.kind === "figure"));
        const fig = byId ?? wanted ?? (args?.figure != null || args?.id ? undefined : near);
        const none = args?.figure != null ? `There is no figure ${args.figure}.` : args?.id ? "I could not find that figure." : "There are no figures on this page.";
        if (!fig) {
          said(none);
          void speaker.say([none]);
        }
        else {
          jump(list.indexOf(fig));
          moveTo(list.indexOf(fig), { read: false });
          L.onTour(fig);
        }
      }
    };
    window.addEventListener("arc:command", onCommand);
    return () => window.removeEventListener("arc:command", onCommand);
  }, [step, moveTo, readAgain, readOn, hush, carryOn, resumeFlow, vid]);

  // After any typed or spoken request the stop is back on the landing line, whether or not the request moved it.
  useEffect(() => {
    const back = () => {
      const L = live.current;
      const e = L.index >= 0 && !L.paused ? stopEls(L.index, L.blk) : null;
      if (e) glide(e.park);
    };
    window.addEventListener("arc:recenter", back);
    return () => window.removeEventListener("arc:recenter", back);
  }, [stopEls, glide]);

  const view = useMemo(() => (pages ? build(items, on).stops : []), [items, on, pages]); // the stops of these items (L.stops is one render behind)
  const node = items[pos.i];
  const L = live.current;
  // "Section 3 of 23, paragraph 2 of 5: Heading". Counts come from the items, so late parts and results keep it right.
  let line = video ? "Press P to play, or V to have Arc read it." : pages ? `${pages} pages. Press the down arrow to start.` : `${items.length} items. Press the down arrow to start.`;
  if (node) {
    const upTo = items.slice(0, pos.i + 1);
    if (pages && node.page != null) {
      // "Page 4 of 15, paragraph 2 of 9": the stop's place among the stops of its page; a figure is named by the paper's own label
      const here = view.filter((st) => items[st.i].page === node.page);
      line = `Page ${node.page} of ${pages}, ${node.kind === "figure" ? node.heading : `paragraph ${here.findIndex((st) => st.i === pos.i && st.b === pos.b) + 1} of ${here.length}`}`;
    } else if (on && node.kind === "section") {
      // The same numbers the student can ask for ("section 2.1"): the heading's own number, else its place among the headings.
      const nb = L.blocks[pos.i]?.length ?? 0;
      const heads = items.filter((n) => n.kind === "section");
      const sn = sectionNo(heads, heads.indexOf(node));
      line = `${sn.no ? `Section ${sn.no} of ${sn.of} sections: ` : ""}${sn.name}${pos.b >= 0 ? `, paragraph ${pos.b + 1} of ${nb}` : ""}`;
    } else if (on && node.kind === "figure") {
      const k = upTo.filter((n) => n.kind === "figure").length;
      line = `Figure ${k} of ${items.filter((n) => n.kind === "figure").length}${node.heading === `Figure ${k}` ? "" : `: ${node.heading}`}`; // the page's own label when it differs ("Figure 8.2")
    } else line = `${pos.i + 1} of ${items.length}${node.kind === "segment" && node.image ? ", with a picture" : ""}: ${node.heading}`;
  }
  return (
    <>
      <div ref={ring} className="arc-ring" data-on="false" />
      {/* Not role="application": nothing here takes focus (the keys are window listeners), and the reading stays a document a
          screen reader can browse. The keys are said by "?" (help). */}
      <div className="reader">
        {/* Keys and voice only: no buttons (a row of them trapped Tab users). The speed is shown, not a control. */}
        <p className="reader-pos">
          {line} <span className="reader-rate">Speed {rate.toFixed(1)}</span>
        </p>
      </div>
    </>
  );
}
