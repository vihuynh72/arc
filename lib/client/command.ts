// One typed or spoken request: decide, act only when sure, say "not sure" once. Used by CommandBox and AskButton.
import { decide, dispatchDecision, type Decision } from "@/lib/client/decide";
import { prefetchClip, said, shortFirst, speaker, splitSentences } from "@/lib/client/reader";
import { answerSounded, answerText, askText, budgetOf, budgetSeen, currentTwin, lastExchange, playAnswer, questionContext, recentlyRead, setWhere, startWaitTone, stopAnswer } from "@/lib/client/voice";
import type { Item } from "@/lib/server/decide";
import { blocksOf } from "@/lib/blocks";
import { videoContext } from "@/lib/client/video";
import { answerNarrow } from "@/lib/client/narrow";
import { decisionState, distinctWords, PAGES_ONLY, help, inThread, isQuestion, normalise, questionSource, mumbled, routeDecision, searchAsked, wordSearchAllowed, NOT_CAUGHT_LINE, notUnderstood, resolveLocal, type Ctx, type Mode, type Offer, type Resolved } from "@/lib/intent";
import { clearRecent, readRecent } from "@/lib/client/recent";
import { tourOffer, type Style } from "@/lib/keys";
import { findText, TOC_ID, withToc, findTopic, labelMatches, numOf, sentenceWith, topicWords, which, type Entry, type Unit } from "@/lib/outline";
import type { TwinNode } from "@/lib/types";

export const NOT_SURE = "I did not catch that. Say help for what you can do.";

// How the student has been acting: the last few requests and keys (Space, which is the microphone, and Escape do not count).
// Every prompt that names a key is worded for this (lib/keys.ts cue).
let inputs: ("voice" | "keys")[] = [];
export const noteInput = (how: "voice" | "keys") => void (inputs = [...inputs, how].slice(-3));
/** voice: only talking lately; keys: only keys or typing; both: a mix, or nothing yet. */
export function inputStyle(): Style {
  if (!inputs.length) return "both";
  return inputs.every((x) => x === "voice") ? "voice" : inputs.every((x) => x === "keys") ? "keys" : "both";
}
/** Spoken, with nothing more to go on: a mumble is asked for again, anything else gets what can be said here. */
export const notUnderstoodLine = (text: string) => (mumbled(text) || text.trim().split(/\s+/).length <= 1 ? NOT_CAUGHT_LINE : notUnderstood(currentCtx()));
const NO_ANSWER = "I could not get an answer just now. Try asking again."; // the question session failed twice
const ACTION_SURE = 0.6; // same as ACTION_MIN in lib/server/decide.ts, which the browser does not import

// What Twin currently shows; Twin keeps it fresh so callers only pass the text.
const ctx = { items: [] as Item[], inTour: false, mode: "landing" as Mode, title: "", pages: 0, behind: undefined as string | undefined };
// Where the cursor is (from Reader's arc:cursor), the last two commands, and an offer such as "Say tour to explore it."
const here = { id: null as string | null, kind: null as string | null, heading: "", back: false, para: undefined as { at: number; of: number } | undefined };
let recent: string[] = [];
let offer: Offer | undefined;
let listed: { entries: Entry[]; at: number } | undefined; // headings Arc just read out as a list ("the second one" picks from it)
let listening = false;
let lastFigure: string | undefined; // the figure the student was last on, for "that figure"

// A turn is one thing the student started: a request, a key, a link. A reply to an earlier turn is dropped (it landed on top of
// a page loading). watchTurn(fn): fn runs once at the next turn.
let turn = 0;
let watchers: (() => void)[] = [];
export const turnNow = () => turn;
export const watchTurn = (fn: () => void) => void watchers.push(fn);
function bump() {
  turn++;
  const w = watchers;
  watchers = [];
  w.forEach((f) => f());
}
const STARTS = new Set(["load", "search", "open", "pdf-file", "refresh"]);

function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("arc:cursor", (e) => {
    const d = (e as CustomEvent<{ id: string; kind: string; heading: string; back?: boolean }>).detail;
    if (d) Object.assign(here, { id: d.id, kind: d.kind, heading: d.heading, back: !!d.back, para: undefined });
    if (d && here.kind === "figure") lastFigure = d.id;
  });
  window.addEventListener("arc:command", (e) => {
    const n = (e as CustomEvent<{ name: string; args?: { silent?: boolean; query?: string; by?: number; id?: string; block?: string; b?: number; more?: boolean } }>).detail;
    if (n?.name && !n.args?.silent) recent = [...recent, n.name].slice(-2);
    if (n && STARTS.has(n.name)) bump();
    // Commands this module carries out itself (no other part of the page knows them).
    if (n?.name === "help") speak(help({ ...currentCtx(), how: "keys" }, !!n.args?.more)); // asked by a key (lib/client/focusVoice.ts): answered with the keys
    else if (n?.name === "readLecture") window.dispatchEvent(new CustomEvent("arc:video", { detail: "mode" })); // what V does: Arc reads the lecture
    else if (n?.name === "find" && n.args?.query) find(String(n.args.query));
    else if (n?.name === "findNext") findNext(n.args?.by === -1 ? -1 : 1);
    else if (n?.name === "home") setTimeout(() => location.assign("/"), 1300); // after "Back to the start page."; a full load, as the wordmark link does
    else if (n?.name === "forgetRecent") clearRecent(); // "forget what I opened" on the start page (lib/client/recent.ts)
    else if (n?.name === "land" && n.args?.id) {
      const u = units().find((x) => x.id === n.args!.id && (x.block ?? "") === (n.args!.block ?? ""));
      if (u) land(u, "");
    }
  });
  window.addEventListener("keydown", (e) => void (!["Shift", "Control", "Alt", "Meta"].includes(e.key) && bump()), true);
  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    if (!e.isTrusted || e.repeat || [" ", "Escape", "`", "Shift", "Control", "Alt", "Meta"].includes(e.key) || t?.closest?.("input, textarea, select, [contenteditable='true']")) return;
    noteInput("keys");
  }, true);
  window.addEventListener("arc:block", (e) => {
    const d = (e as CustomEvent<{ id: string; block: number; blocks: number }>).detail;
    if (d) here.para = d.block >= 0 ? { at: d.block + 1, of: d.blocks } : undefined;
  });
  window.addEventListener("arc:offer", (e) => void (offer = { ...(e as CustomEvent<Omit<Offer, "at">>).detail, at: Date.now() }));
}

// Decisions by text for the current context: the held-key pre-ask, the early transcript and Live's "heard" share one call.
let cache = new Map<string, Promise<Decision>>();
export function setCommandContext(items: Item[], inTour: boolean, page: { mode: Mode; title: string; pages?: number; behind?: string } = { mode: "landing", title: "" }) {
  listen();
  ctx.items = items;
  ctx.inTour = inTour;
  ctx.mode = page.mode;
  ctx.title = page.title;
  ctx.pages = page.pages ?? 0;
  ctx.behind = page.behind;
  cache = new Map();
  if (typeof window !== "undefined") for (const how of ["voice", "both"] as Style[]) prefetchClip(help({ ...currentCtx(), how })); // help starts at once
}

/**
 * The page's headings with their level and numbering. Twin hands over only id and heading text, so the level comes from the
 * rendered heading (h2 to h4: components/twin/Nodes.tsx); figures and text without a heading are kind "other".
 */
export function outline(): Entry[] {
  if (typeof document === "undefined" || ctx.mode !== "article") return [];
  const n = nodes();
  if (n) return withToc(n, toc()); // levels as the parser gave them, evened out by numbering; a PDF: its pages not loaded yet too
  return ctx.items.map((it, i) => {
    const h = document.querySelector(`[data-node-id="${it.id}"] > h2, [data-node-id="${it.id}"] > h3, [data-node-id="${it.id}"] > h4`);
    if (!h) return { i, id: it.id, label: it.label, level: 0, kind: "other" as const };
    const n = numOf(it.label);
    return { i, id: it.id, label: it.label, level: Number(h.tagName[1]), kind: "section" as const, ...(n ? { num: n.num, pre: n.pre } : {}) };
  });
}

/** A PDF's whole-document outline (empty until known, or when it has none). */
const toc = () => (ctx.pages ? (currentTwin()?.pdf?.outline ?? []) : []);

/** The open page's nodes, when they are the items on screen (not search results). */
function nodes(): TwinNode[] | undefined {
  const t = currentTwin();
  if (!t || (ctx.mode !== "article" && ctx.mode !== "video")) return undefined;
  const it = ctx.items;
  return t.nodes.length === it.length && it.length > 0 && t.nodes[0].id === it[0].id && t.nodes[it.length - 1].id === it[it.length - 1].id ? t.nodes : undefined;
}

const spokenHeading = (h: string) => h.replace(/^(\d+(\.\d+)*)\.\s/, "$1 ").trim();

/** Every place the reader can stop that holds words: section blocks, whole PDF paragraphs, figure captions. */
function units(): Unit[] {
  const out: Unit[] = [];
  for (const n of nodes() ?? []) {
    if (n.kind === "figure") out.push({ id: n.id, b: -1, where: n.heading, text: `${n.heading}. ${n.text}` });
    else if (n.kind === "segment") out.push({ id: n.id, b: -1, where: n.heading, text: `${n.text} ${n.shown ?? ""}` });
    else blocksOf(n).forEach((b, k) => out.push({ id: n.id, block: b.id, b: k, where: spokenHeading(n.heading), text: b.say ?? b.text }));
  }
  return out;
}

const wordCount = (t: string) => (t.match(/\S+/g) ?? []).length;

/** The state the local grammar, Decision and "where am i" decide over. */
export function currentCtx(): Ctx {
  const index = here.id ? ctx.items.findIndex((i) => i.id === here.id) : -1;
  const kind = index < 0 ? null : ctx.mode === "results" ? "result" : (here.kind as Ctx["onKind"]);
  // The tour's own line ("Stop 2 of 6: right thigh."), read from the page: FigureTour does not announce its stops.
  const stop = ctx.inTour ? document.querySelector("[data-tour] p strong")?.textContent?.replace(/\.$/, "").replace(/^S/, "s") : undefined;
  const stops = ctx.inTour ? Number(document.querySelector("[data-tour] [data-stops]")?.getAttribute("data-stops")) || undefined : undefined;
  return {
    mode: ctx.inTour ? "tour" : ctx.mode,
    onKind: ctx.inTour ? "figure" : kind,
    index,
    total: ctx.items.length,
    lastCommand: recent.join(", ") || undefined,
    pendingOffer: offer,
    canGoBack: here.back,
    paged: ctx.pages > 0,
    label: index >= 0 ? here.heading : undefined,
    title: ctx.title,
    stop: stop || undefined,
    tourStops: stops,
    how: inputStyle(),
    results: ctx.mode === "results" ? ctx.items.map((i) => i.label) : undefined,
    behind: ctx.behind,
    thread: lastExchange(),
    findAt: found ? foundAt : undefined,
    now: Date.now(),
    recent: readRecent(),
    ...(ctx.mode === "article" ? { outline: outline(), para: here.para, list: listed } : ctx.mode === "landing" ? { list: listed } : {}),
    ...extra(index),
  };
}

/** What only the open document knows: words for "find", lengths for "how long", the page, the next heading. */
function extra(index: number): Partial<Ctx> {
  const n = nodes();
  if (!n) return {};
  const words = n.map((x) => wordCount(x.text));
  const total = words.reduce((a, b) => a + b, 0);
  const before = index < 0 ? 0 : words.slice(0, index).reduce((a, b) => a + b, 0) + (here.para && here.para.of ? Math.round((words[index] * (here.para.at - 1)) / here.para.of) : 0);
  const loaded = new Set(n.map((x) => x.page).filter((p) => p != null)).size;
  const scale = ctx.pages && loaded ? ctx.pages / loaded : 1; // a PDF: only the pages read so far are here
  const nextAt = n.findIndex((x, i) => i > index && (x.kind === "figure" || !!x.level || x.page == null));
  return {
    units: ctx.mode === "article" ? units() : undefined,
    page: index >= 0 ? n[index].page : undefined,
    pages: ctx.pages || undefined,
    read: { total: Math.round(total * scale), left: Math.max(0, Math.round(total * scale) - before) },
    rate: speaker.rate,
    next: nextAt >= 0 ? spokenHeading(n[nextAt].heading) : undefined,
    counts: { sections: n.filter((x) => x.kind === "section" && (x.level || x.page == null)).length, figures: n.filter((x) => x.kind === "figure").length },
    lastFigure: lastFigure && lastFigure !== here.id ? lastFigure : undefined,
    blocks: n.map((x) => (x.kind === "section" ? blocksOf(x).length : 0)),
    pageOf: ctx.pages ? Object.fromEntries([...n.flatMap((x) => (x.page != null ? [[x.id, x.page]] : [])), ...toc().map((e, k) => [`${TOC_ID}${k}`, e.page])]) : undefined,
    whole: !!toc().length,
  };
}

// ---- find: "find sampling rate", then "next match" ----

let found: { query: string; list: Unit[]; k: number } | undefined;
let foundAt = 0; // when the last find landed: "next one" means its next match for a while (lib/intent.ts FIND_MS)

/** The cursor onto one block (or node), and that place read with a lead line. Through the reader's own goto and click, so its
 * history ("go back"), band and sentence marks stay right. */
function land(u: Unit, lead: string, query?: string) {
  send("goto", { id: u.id }); // a jump the reader remembers for "go back"
  const el = u.block ? document.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(u.block)}"]`) : null;
  if (el) {
    // shortcut: the reader moves to a block only on a click; a "goto" with a block (Reader.tsx) would be cleaner
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, button: 0, clientX: r.left + 4, clientY: r.top + 4, pointerType: "mouse" };
    el.dispatchEvent(new PointerEvent("pointerdown", at));
    el.dispatchEvent(new PointerEvent("pointerup", at));
  }
  const fig = u.b < 0 && nodes()?.find((x) => x.id === u.id)?.kind === "figure";
  if (lead) said(lead);
  const all = splitSentences(u.text);
  const lines = query ? all.slice(sentenceWith(all, query)) : all; // a find starts at the sentence holding the words, not at the top of its paragraph
  void speaker.say([...(lead ? [lead] : []), ...lines, ...(fig ? [tourOffer(inputStyle())] : [])]);
  window.dispatchEvent(new Event("arc:recenter"));
}

const matchLine = (f: { list: Unit[]; k: number }) =>
  `Found in ${f.list[f.k].where}, ${f.list.length === 1 ? "the only match" : `${f.k + 1} of ${f.list.length} matches`}.`;

function find(query: string) {
  const list = findText(units(), query);
  if (!list.length) {
    found = undefined;
    const pdf = ctx.pages ? " I have only read some of its pages so far." : "";
    offer = { name: "search", args: { query }, say: `Searching for ${query}.`, at: Date.now() };
    return speak(`I did not find ${query} on this page.${pdf} Say yes to search the web for it.`);
  }
  found = { query, list, k: 0 }; // the first in the document: "1 of 4" means what it says
  foundAt = Date.now();
  land(list[found.k], matchLine(found), query);
}

function findNext(by: 1 | -1) {
  if (!found) return speak("Say find and a word first.");
  const k = found.k + by;
  if (k < 0 || k >= found.list.length) return speak(by > 0 ? `That was the last match for ${found.query}.` : `That was the first match for ${found.query}.`);
  found.k = k;
  foundAt = Date.now();
  land(found.list[k], matchLine(found), found.query);
}

/** A request for a place by topic, once nothing else placed it: the page's words, whole words by stem, the place holding the most
 * of them first. Says which words it matched and where; null when nothing fits. */
function topicFind(text: string): string | null {
  if (ctx.mode !== "article") return null;
  const { matched: stems, list } = findTopic(units(), text, distinctWords(text));
  if (!list.length) return null;
  const own = normalise(text).split(" ");
  const matched = stems.map((m) => own.find((w) => topicWords(w)[0] === m) ?? m); // the student's own word ("photosynthesis"), not its stem
  found = { query: matched.join(" "), list, k: 0 };
  foundAt = Date.now();
  const n = list.length === 1 ? "The only place." : `1 of ${list.length} places.`;
  const and = matched.length > 1 ? `${matched.slice(0, -1).join(", ")} and ${matched[matched.length - 1]}` : matched[0];
  const lead = `${and.replace(/^./, (x) => x.toUpperCase())} ${matched.length > 1 ? "are" : "is"} mentioned in ${list[0].where}. ${n}`;
  land(list[0], lead, found.query);
  return lead;
}

// ---- when the models are out ----

let fullSaid = false; // the long unavailable line, at most once a session
let downAt = 0;
const DOWN_MS = 30_000; // after a refusal, questions are not sent for this long (the next one after it tries again)
/** True when the decision or question service refused lately: questions are answered locally with the unavailable line. */
export const geminiDown = () => Date.now() - Math.max(downAt, budgetSeen()) < DOWN_MS;

/** The line for a request only a model could answer, while the models are unavailable. Plain, never "credit". */
export function unavailableLine(kind: "question" | "other" = "question"): string {
  const still =
    ctx.mode === "landing" ? "I can still open links and search for study pages." : ctx.mode === "results" ? "I can still read the results and open them." : "I can still read, jump to sections and find words on the page.";
  if (!fullSaid) {
    fullSaid = true;
    return `Arc's question service is unavailable right now. ${still}`;
  }
  return kind === "question" ? `I can't answer questions right now. ${still}` : `I could not work that out without the question service. ${still}`;
}

const GOTOISH = /^(?:(?:go|jump|skip|move|navigate|get)(?: back)? to|take me|bring me|show me)\b|\b(?:section|chapter|part|heading)\b/i;

/** No decision could be had: answer from what is known locally. */
function offline(text: string): string {
  // A question is answered or not at all: it never becomes a web search on its own (a yes to the offer can run one).
  if (isQuestion(text)) return unavailableLine("question");
  if (ctx.mode === "results") return notUnderstood(currentCtx()); // "go back to the paper" is no search: without the decision, say what works
  if (ctx.mode === "landing") {
    send("search", { query: text }); // with nothing open to read, a search is what still helps
    return `Searching for ${text}.`;
  }
  const t = wordSearchAllowed(text, { action: "none", act: false }) ? topicFind(text) : null; // already landed and spoken
  if (t) return "";
  if (GOTOISH.test(text)) return ctx.pages && !toc().length ? PAGES_ONLY : "I could not find a section called that. Say contents to hear the sections.";
  const q = distinctWords(text).join(" ");
  if (!q || q.split(" ").length > 4) return notUnderstood(currentCtx()); // never her whole sentence back
  // Not a question, not on this page: a web search is what still works.
  offer = { name: "search", args: { query: q }, say: `Searching for ${q}.`, at: Date.now() };
  return `I did not find ${q} on this page. Say yes to search the web for it.`;
}

const LOOKED = /did not find (?:that|it|this) in the part of the page/i; // lib/server/live.ts ASKER_RULE
export const FIND_HINT = "I can search the page for a word: say find, then the word.";
/** After a spoken answer ends: when the answer was not in what the question session was given, offer the local find. */
export function afterAnswer(answer: string | null, played: Promise<void>, mine: number) {
  if (answer && LOOKED.test(answer) && ctx.mode === "article") void played.then(() => turn === mine && speak(FIND_HINT));
}

/** Before a question goes to the question session: the parts of the page most likely to hold its answer. */
export function primeQuestion(text: string) {
  const t = currentTwin();
  if (t && nodes()) setWhere(threadLine() + questionSource(ctx.mode, videoContext(6000), () => questionContext(t, text, here.id, 12000, recentlyRead())));
  else if (lastExchange()) setWhere(threadLine()); // the start page or results: only the exchange
}

/** The last question and answer, while a reply to it is likely: a short reply ("yes", "more simply") is read against it. */
export function threadLine(): string {
  const x = lastExchange();
  return x && inThread({ ...currentCtx(), thread: x }) ? `PREVIOUS EXCHANGE (the student's next words may reply to it): the student said "${x.q.slice(0, 200)}"; you answered "${x.a.slice(0, 400)}"\n\n` : "";
}

let statusAt = 0; // when Arc last said a line of its own (where you are, how much is left): "say that again" then means the page
const speak = (line: string) => {
  said(line);
  // A long line in a short first clip: its sound starts sooner (it is made on the spot). A short one stays whole: it may be warm.
  void speaker.say(line.length > 100 ? shortFirst(splitSentences(line)).lines : [line]);
};
const send = (name: string, args: object = {}) => window.dispatchEvent(new CustomEvent("arc:command", { detail: { name, args } }));

/**
 * The local grammar (lib/intent.ts), 0 ms, no model: runs a short request at once and returns what it did, or null.
 * alternatives: other readings of the same speech; the first that resolves wins.
 */
export function runLocal(text: string, alternatives: string[] = []): Resolved | null {
  const t0 = performance.now();
  const c = currentCtx();
  let r: Resolved | null = null;
  for (const t of [text, ...alternatives]) if ((r = resolveLocal(t, c))) break;
  if (!r) return null;
  offer = r.offer ? { ...r.offer, at: Date.now() } : undefined; // used, refused, or overtaken by another request; or a new one
  // "Say that again" after Arc's own line ("About 9 minutes left"): the page's last sentence, not that line again.
  if (r.name === "read" && r.args?.sentence && statusAt > (lastExchange()?.at ?? 0) && Date.now() - statusAt < 60_000) r = { ...r, args: { ...r.args, page: true } };
  statusAt = r.name === "none" && r.say ? Date.now() : 0;
  // An outline entry on a page not loaded yet: its page is loaded and the cursor lands on its heading (lib/client/pdf.ts).
  const k = r.name === "goto" && typeof r.args?.id === "string" && r.args.id.startsWith(TOC_ID) ? Number(r.args.id.slice(TOC_ID.length)) : -1;
  const entry = k >= 0 ? toc()[k] : undefined;
  if (entry) r = { ...r, name: "page", args: { n: entry.page, title: entry.title } };
  if (r.name !== "none") {
    // The tour takes one step per command; the reader takes one combined move and reads only where it lands. "much slower": three steps.
    if ((c.mode === "tour" || r.name === "faster" || r.name === "slower") && r.steps) for (let i = 0; i < r.steps; i++) send(r.name);
    else send(r.name, { ...r.args, ...(r.steps ? { steps: r.steps } : {}) });
  }
  listed = r.list ? { entries: r.list, at: Date.now() } : undefined;
  if (r.say && r.name !== "search") speak(r.say); // a search says what it searches for itself (components/Twin.tsx)
  console.info(`[arc-timing] local "${text}" -> ${r.name}${r.steps ? ` x${r.steps}` : ""}${r.say ? ` says "${r.say}"` : ""} in ${(performance.now() - t0).toFixed(1)} ms`);
  return r;
}

const key = (text: string) => `${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()}|${here.id}|${lastExchange()?.at ?? 0}`;

/** Asks Decision without acting; the same text asks once per page context and cursor position. */
export function preDecide(text: string): Promise<Decision> {
  const k = key(text);
  let p = cache.get(k);
  if (!p) {
    p = decide(text, ctx.items, ctx.inTour, decisionState(currentCtx()));
    p.catch(() => cache.delete(k)); // a failure is retried next time
    cache.set(k, p);
  }
  return p;
}

// The decision's actions that the local grammar already carries out, by the words it knows for them (worded for each mode there).
const BY_WORDS: Record<string, string> = {
  leave: "leave", more: "more", results: "go back to the results", progress: "how much is left", where: "where am i", help: "help",
  picture: "is there a picture", yes: "yes", no: "no", top: "start over", play: "play", rewind: "rewind", readLecture: "read it to me",
};
/** Runs a decision Arc is sure of. */
export const act = (d: Decision) => {
  if (d.act && BY_WORDS[d.action]) return void (runLocal(BY_WORDS[d.action]) ?? speak(notUnderstood(currentCtx())));
  if (d.act) offer = undefined;
  dispatchDecision(d, ctx.items);
};

/** Decision heard a section name that fits two or more headings (two share a word): ask which instead of guessing. */
function ambiguity(d: Decision): Resolved | undefined {
  if (d.action !== "goto" || ctx.mode !== "article") return;
  const c = labelMatches(outline(), d.query);
  if (c.length < 2) return;
  const f = which(c, `"${d.query}"`);
  return "say" in f ? { name: "none", say: f.say, list: f.list } : undefined;
}

const unsure = (d: Decision) => !d.act && d.action !== "question" && d.action !== "none";

/** Decision is sure the student wants goto or tour, but no section or figure fits. */
const notFound = (d: Decision) => (d.action === "goto" || d.action === "tour") && d.confidence >= ACTION_SURE && !d.act;

/** Nothing on the page fits: a short name ("the hardware section") is said back; anything longer gets what can be said here. */
const notFoundLine = (d: Decision) => {
  const q = d.query.replace(/^(?:take me to|bring me to|go to|jump to|skip to|navigate to|show me|tour|start)\s+(?:the\s+)?/i, "").replace(/\s+(?:section|part|chapter|heading)$/i, "").trim();
  return d.action === "goto" && q && q.split(/\s+/).length <= 4 ? `I could not find a section called ${q}. Say contents to hear the sections.` : notUnderstood(currentCtx());
};

/** A typed question, or a request Decision is unsure of, goes to the question session, as a spoken one does. */
export const viaGemini = (d: Decision) => d.action === "question" || unsure(d);

/** A command the question session called, as Arc runs it: its "read" reads on (a request to read is never one part at a time). */
export const geminiCommand = (name: string, args: Record<string, unknown> = {}) => (name === "read" && ctx.mode === "article" && !ctx.inTour ? { name: "continue", args: {} } : { name, args });

const BUDGET = "\u0000budget"; // askTyped: the question session refused for budget
/** Typed text to the question session: plays its answer, runs its one command, resolves with its transcript (null: the session
 * failed twice; BUDGET: refused). The answer stops if the student starts something else meanwhile. */
async function askTyped(text: string, attempts = 2, since = performance.now()): Promise<string | null> {
  let ran = false;
  primeQuestion(text);
  for (let tries = 0; tries < attempts; tries++) {
    const id = askText(text, (name, args) => {
      if (ran) return; // never run a command twice
      ran = true;
      window.dispatchEvent(new CustomEvent("arc:command", { detail: geminiCommand(name, args) }));
    });
    const mine = turn;
    watchTurn(() => mine !== turn && stopAnswer(id));
    const played = playAnswer(id);
    // A typed question waits like a spoken one: a soft tone from 1.5 s after Enter until the answer sounds or the student moves on.
    let tone = () => {};
    const late = setTimeout(() => void (mine === turn && !answerSounded(id) && (tone = startWaitTone())), Math.max(0, 1500 - (performance.now() - since)));
    const poll = setInterval(() => void ((answerSounded(id) || mine !== turn) && hush()), 150);
    const hush = () => (clearTimeout(late), clearInterval(poll), tone(), void (tone = () => {}));
    const a = await answerText(id);
    hush();
    if (budgetOf(id)) return BUDGET;
    afterAnswer(a, played, mine);
    if (a?.trim() || (a != null && ran)) return a; // an empty answer with no command is a failure: asked again
    if (a != null) await played;
    console.warn("[arc] the question session did not answer", tries ? "(second try)" : "(trying once more)"); // a dropped session reopens on the next ask
  }
  return null;
}

/**
 * A spoken question whose answer failed or came back empty: asked once more as text, on the same path a typed question takes;
 * if that fails too, one short honest line. Never said once the student has moved on.
 */
export async function answerAgain(text: string, mine: number, attempts = 1): Promise<string | null> {
  console.info(`[arc-timing] answer as text (${attempts === 1 ? "once more" : "the typed path"}): "${text}"`);
  const a = await askTyped(text, attempts).catch(() => null);
  if (turn !== mine) return null;
  if (a === BUDGET) speak(unavailableLine());
  else if (!a?.trim()) speak(NO_ANSWER);
  return a === BUDGET ? null : a;
}

/**
 * quiet: the voice path lets Gemini ask what was meant, so Arc does not speak itself.
 * Typed (not quiet): a sure request runs; goto or tour with no match says what was not found; a question, or an unsure
 * request, is answered by Gemini and onAnswer gets its transcript. Kokoro's line is only the fallback when the relay fails.
 */
export async function submitUtterance(
  text: string,
  { quiet = false, onAnswer, alternatives }: { quiet?: boolean; onAnswer?: (text: string) => void; alternatives?: string[] } = {},
): Promise<Decision & { local?: string }> {
  bump();
  noteInput(quiet ? "voice" : "keys");
  const mine = turn;
  const t0 = performance.now();
  if (answerNarrow(text)) return localDecision({ name: "narrow" }); // the answer to an open narrowing question (lib/client/narrow.ts)
  if (ctx.inTour && searchAsked(text) && !inThread(currentCtx())) {
    // A search from inside a tour: the tour closes first and says so, then the search runs on the page.
    send("leave", { quiet: true });
    ctx.inTour = false;
    await speaker.say(["Leaving the tour."]);
    if (mine !== turn) return localDecision({ name: "none" });
  }
  const r = runLocal(text, alternatives);
  if (r) return localDecision(r);
  const say = (line: string) => (line && speak(line), localDecision({ name: "none", say: line }));
  if (isQuestion(text) && geminiDown()) return say(unavailableLine("question")); // known to be out: no waiting on the network
  let d: (Decision & { budget?: string }) | null = null;
  // Typed: a soft tone if the decision itself is slow (just after a page opens the browser is busy fetching its pictures),
  // until it is known or the student moves on. A spoken request has its own tone (components/AskButton.tsx).
  let hush = () => {};
  if (!quiet) {
    const late = setTimeout(() => void (mine === turn && (hush = startWaitTone())), 1500);
    hush = () => clearTimeout(late);
    watchTurn(() => hush());
  }
  try {
    d = await preDecide(text);
  } catch {
    d = null; // the decision service is unreachable: the local answer below, never silence
  }
  hush();
  if (mine !== turn) return localDecision({ name: "none" }); // the student has moved on: this request is dropped
  if (!d || d.budget) {
    downAt = Date.now();
    return say(offline(text));
  }
  const amb = ambiguity(d);
  if (amb) {
    listed = { entries: amb.list!, at: Date.now() };
    speak(amb.say!);
    return localDecision(amb);
  }
  if (quiet && notFound(d)) return say(notFoundLine(d)); // by voice nobody can read "not found": say it
  // What to do with the decision (lib/intent.ts routeDecision, measured by scripts/intent-eval.ts).
  const c = currentCtx();
  const to = routeDecision(text, c, d);
  if (to.to === "find") {
    const t = topicFind(text);
    return t ? localDecision({ name: "find", say: t }) : say(`I did not find that on this page.${ctx.pages ? " I have only read some of its pages so far." : ""}`);
  }
  if (to.to === "offer") return localDecision(runLocal(text) ?? (speak(to.r.say!), (offer = { ...to.r.offer!, at: Date.now() }), to.r));
  if (to.to === "help") return say(help(c));
  if (to.to === "act") {
    d = { ...d, ...(to.query ? { query: to.query } : {}) };
    if (ctx.inTour && d.action === "search") {
      // A search from inside a tour: the tour closes first and says so, then the search runs on the page.
      send("leave", { quiet: true });
      ctx.inTour = false;
      await speaker.say(["Leaving the tour."]);
      if (mine !== turn) return localDecision({ name: "none" });
    }
    act(d);
    if (!quiet && notFound(d)) speak(notFoundLine(d));
    return d;
  }
  if (to.to === "notCaught" || to.to === "notUnderstood") {
    const line = to.to === "notCaught" ? NOT_CAUGHT_LINE : notUnderstood(c);
    if (quiet) return { ...d, act: false, action: "none", confidence: to.to === "notCaught" ? 0 : Math.max(d.confidence, 0.6) }; // components/AskButton.tsx says it
    return say(line);
  }
  // The question session: it answers, asks what was meant, or runs its own command (checked in lib/client/voice.ts).
  d = { ...d, act: false, action: "question", confidence: Math.max(d.confidence, 0.6) };
  if (quiet) return d;
  void askTyped(text, 2, t0)
    .catch(() => null)
    .then((a) => {
      const fail = a === BUDGET ? unavailableLine("question") : NO_ANSWER;
      const ok = a != null && a !== BUDGET;
      if (!ok && turn === mine) speak(fail); // a failure nobody waits for any more is not said
      if (ok || turn === mine) onAnswer?.(ok ? a! : fail);
    });
  return d;
}

/** A local grammar result in the shape callers already handle: sure, nothing more to dispatch. */
export const localDecision = (r: Resolved): Decision & { local: string } => ({
  action: "none", confidence: 1, target: null, targetConfidence: 1, setting: null, settingConfidence: 0, query: "", ms: 0, act: true,
  local: `${r.name}${r.steps ? ` x${r.steps}` : ""}${r.say ? `: "${r.say}"` : ""}`,
});

/** One short plain line: what was decided, how sure, how fast. */
export function describe(d: Decision & { local?: string }): string {
  if (d.local) return `${d.local} · local grammar · 0 ms`;
  if (notFound(d)) return notFoundLine(d);
  if (unsure(d)) return `not sure what you meant · ${Math.round(d.confidence * 100)}% sure · ${Math.round(d.ms)} ms`;
  const label = ctx.items.find((i) => i.id === d.target)?.label;
  const what: Record<string, string> = {
    goto: `go to "${label ?? d.target}"`,
    tour: label ? `tour "${label}"` : "tour a figure",
    search: `search for "${d.query}"`,
    open: `open "${label ?? d.target}"`,
    refresh: "fetch the page live",
    next: "next",
    prev: "previous",
    nextFigure: "next figure",
    prevFigure: "previous figure",
    nextHeading: "next heading",
    prevHeading: "previous heading",
    read: "read again",
    continue: "read on",
    stop: "stop",
    faster: "faster",
    slower: "slower",
    question: "a question",
    display: `display: ${d.setting}`,
    none: "not a request",
  };
  return `${what[d.action]} · ${Math.round(d.confidence * 100)}% sure · ${Math.round(d.ms)} ms`;
}
