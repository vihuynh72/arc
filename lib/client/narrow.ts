// Narrowing a broad search by asking ("I want to study biology" -> "Which part: cells, genetics, evolution, or ecology?").
// components/Twin.tsx sends every search through narrowSearch; lib/client/command.ts hands each typed or spoken request to
// answerNarrow first while a question is open. The model (app/api/narrow) only writes the question; the limits are here, in code:
// at most MAX_QUESTIONS, never the same question twice, short options, and any failure or slow answer searches with what there is.
// The pure part (broad, classify, pick, nextStep, questionLine) is checked offline by scripts/checks/narrow.ts.
import { currentCtx, geminiDown, inputStyle, watchTurn } from "@/lib/client/command";
import { said, speaker, startWaitTone } from "@/lib/client/reader";
import { BACK_TO_RESULTS, normalise, resolveLocal } from "@/lib/intent";
import { contentWords } from "@/lib/server/search";
import type { Style } from "@/lib/keys";

export const MAX_QUESTIONS = 4;
export const STEP_MS = 1500; // the first narrowing step slower than this is dropped: the search goes ahead
const ANSWER_MS = 3500; // after an answer the student expects a beat: a soft tone from 1.5 s, the model up to 3.5 s
const REMIND_MS = 20_000;

export type Ask = { question: string; options: string[]; kind: string };
export type Ex = { request: string; asked: { q: string; a: string; kind: string }[]; level?: string };
type Step = { specific?: boolean; query?: string; said?: string; question?: string; options?: string[]; kind?: string };

// Whole subjects too big to search well on their own; anything else (a topic, a site, a level, a title, a link) searches at once.
const SUBJECTS = new Set(
  "biology chemistry physics math maths mathematics science history geography economics psychology sociology philosophy english literature algebra geometry calculus statistics anatomy physiology medicine engineering astronomy geology ecology genetics art music law politics computing programming biochemistry neuroscience".split(" "),
);
const PAIRS = new Set(["computer science", "earth science", "world history", "us history", "american history", "social studies", "political science", "organic chemistry", "life science", "physical science"]);
const SOFT = new Set("study studying learn learning about some stuff things basics basic general intro introduction to in on the a an me with help my for class course subject topic homework".split(" "));

/** True for a request that names only a whole subject ("biology", "help me with math", "chemistry stuff"). */
export function broad(query: string): boolean {
  if (/[/:.]\w/.test(query)) return false; // a link or a file
  const w = normalise(query).split(" ").filter((x) => x && !SOFT.has(x));
  return (w.length === 1 && SUBJECTS.has(w[0])) || (w.length === 2 && PAIRS.has(w.join(" ")));
}

const SKIP = /^(?:just )?(?:search|go|go ahead|search now|just search|just go|anything|any|any of them|all of them|whatever|either|either one|skip|skip it|surprise me|you choose|you pick|no idea|not sure|i'?m not sure|(?:i )?(?:really )?don'?t know|dont know|i do not know|doesn'?t matter|does not matter|it doesn'?t matter|i don'?t mind|don'?t mind|no preference)(?: (?:you (?:pick|choose)|you decide|either way))?$/;
const AGAIN = /^(?:again|repeat|repeat that|repeat the question|say that again|say again|say it again|pardon|what|sorry|sorry what|what was that|what were they|what are they|what were the options|what are the options|the options|options|come again|once more)$/;
const CANCEL = /^(?:cancel|cancel that|cancel it|never mind|nevermind|no|nope|stop|forget it|leave it|no thanks|not now|not)$/; // "not now": normalise drops a final "now"
const NEW = /^(?:search for|search the web|look up|look for|find (?:me )?(?:papers?|articles?|videos?|pages?)|open|go to|play|read)\b|https?:\/\//;
const WHERE = /^(?:where am i|where are we|where was i|help|what can i say|what can i do|what are my options)$/;
const ORD: Record<string, number> = { first: 1, one: 1, "1": 1, "1st": 1, second: 2, two: 2, "2": 2, "2nd": 2, third: 3, three: 3, "3": 3, "3rd": 3, fourth: 4, four: 4, "4": 4, "4th": 4, for: 4 };

export type Said = "skip" | "again" | "cancel" | "where" | "new" | "answer";
/** What an utterance during an open question is. */
export function classify(text: string): Said {
  const s = normalise(text);
  if (!s) return "again";
  if (CANCEL.test(s)) return "cancel";
  if (SKIP.test(s)) return "skip";
  if (AGAIN.test(s)) return "again";
  if (WHERE.test(s)) return "where";
  if (NEW.test(s)) return "new";
  return "answer";
}

/** The option an answer picks: by place ("the second one", "2", "number two", "last") or by its words; else undefined (free words). */
export function pick(text: string, options: string[]): number | undefined {
  const s = normalise(text).replace(/^(?:the |number |option |choice )+/, "").replace(/ (?:one|option|choice|please)$/, "");
  if (s === "last" && options.length) return options.length - 1;
  const n = ORD[s];
  if (n && n <= options.length) return n - 1;
  const words = (o: string) => normalise(o);
  const exact = options.findIndex((o) => words(o) === s);
  if (exact >= 0) return exact;
  // "genetics please" picks genetics; a longer answer ("the one about how cells divide") is the student's own words.
  const inside = s.split(" ").length <= 3 ? options.map((o, i) => (` ${s} `.includes(` ${words(o)} `) ? i : -1)).filter((i) => i >= 0) : [];
  return inside.length === 1 ? inside[0] : undefined;
}

const norm = (q: string) => normalise(q).split(" ").slice(0, 6).join(" ");
const shortOption = (o: string) => o.trim().split(/\s+/).length <= 4 && o.trim().length <= 32;
/** The answers' meaning: skips dropped, each answer reduced to its content words ("the one about how cells divide" -> "cells divide").
 * A picked option is already its text (answer() stores the option, not "the second one"). */
const meant = (ex: Ex) => [...new Set(ex.asked.filter((x) => x.a && classify(x.a) !== "skip").map((x) => contentWords(x.a).join(" ")).filter(Boolean))];
/** The words searched when the model gives none, built in code: the subject plus the content words of each real answer. */
export const assembled = (ex: Ex) => [ex.request, ...meant(ex)].join(" ").replace(/\s+/g, " ").trim();
const spoken = (ex: Ex) => [ex.request, ...meant(ex)].join(", ");

/** The next move after a model step (null: it failed or was too slow). Code, not the model, holds every limit. */
export function nextStep(ex: Ex, step: Step | null): { search: string; said: string } | { ask: Ask } {
  const fallback = { search: assembled(ex), said: spoken(ex) };
  if (!step) return fallback;
  if (step.specific || !step.question?.trim()) return step.query?.trim() ? { search: step.query.trim(), said: step.said?.trim() || step.query.trim() } : fallback;
  if (ex.asked.length >= MAX_QUESTIONS) return fallback;
  const kind = ["part", "level", "material"].includes(step.kind ?? "") ? step.kind! : "other";
  const q = step.question.trim().replace(/[?:.\s]+$/, "");
  const again = ex.asked.some((x) => norm(x.q) === norm(q) || (kind !== "other" && x.kind === kind)) || (kind === "level" && !!ex.level);
  if (again) return fallback;
  const options = [...new Set((step.options ?? []).map((o) => o.trim().replace(/[.?]+$/, "")).filter((o) => o && shortOption(o)))].slice(0, 4);
  if (options.length < 2) return fallback;
  return { ask: { question: q, options, kind } };
}

const or = (o: string[]) => (o.length < 3 ? o.join(" or ") : `${o.slice(0, -1).join(", ")}, or ${o[o.length - 1]}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** The question as spoken, in one breath, worded for how the student has been acting (a talker never hears "press"). */
export function questionLine(a: Ask, how: Style, lead = ""): string {
  const pre = lead ? `${lead} ` : "";
  if (how === "keys") return `${pre}${a.question}? ${a.options.map((o, i) => `${i + 1}, ${o}.`).join(" ")} Press a number, or type something else.`;
  return `${pre}${a.question}: ${or(a.options)}? ${how === "voice" ? "Or say something else." : "Say one, or press its number."}`;
}
const remindLine = (a: Ask, how: Style) => `Still here. ${a.question}? ${how === "keys" ? "Press a number, or Escape to cancel." : "Say one, or say just search."}`;

// ---- in the browser ----

const LEVEL = "arc.level";
const readLevel = () => {
  try {
    return sessionStorage.getItem(LEVEL) ?? undefined;
  } catch {
    return undefined;
  }
};
const keepLevel = (l: string) => {
  try {
    sessionStorage.setItem(LEVEL, l);
  } catch {}
};

let ex: (Ex & { open?: Ask; run: (q: string, said: string) => void; gen: number; answeredAt: number; remind?: ReturnType<typeof setTimeout> }) | null = null;
let gen = 0;
export const narrowOpen = () => !!ex?.open;

const speak = (line: string) => {
  said(line);
  void speaker.say([line]);
};
// After this key's other listeners have run: the reader and the ask button cancel speech on a key.
const later = (f: () => void) => setTimeout(f, 0);

function close() {
  if (!ex) return;
  clearTimeout(ex.remind);
  ex = null;
  window.removeEventListener("keydown", onKey, true);
}

function finish(search: string, saidAs: string) {
  const run = ex?.run;
  close();
  run?.(search, saidAs);
}

function ask(a: Ask) {
  if (!ex) return;
  ex.open = a;
  const line = questionLine(a, inputStyle(), ex.asked.length ? "" : `${cap(ex.request)} is a big subject.`);
  const mine = ex.gen;
  said(line);
  void speaker.say([line]).then(() => {
    if (!ex || ex.gen !== mine) return;
    clearTimeout(ex.remind);
    // A silence after a question is fine: one short reminder after about 20 s, then nothing.
    ex.remind = setTimeout(() => ex?.gen === mine && !speaker.busy && speak(remindLine(a, inputStyle())), REMIND_MS);
  });
}

async function step() {
  if (!ex) return;
  const mine = ++gen;
  ex.gen = mine;
  ex.open = undefined;
  if (ex.asked.length >= MAX_QUESTIONS) return finish(assembled(ex), spoken(ex)); // no fifth question: no call
  let s: Step | null = null;
  let toneOff = () => {};
  const tone = ex.asked.length ? setTimeout(() => ex?.gen === mine && (toneOff = startWaitTone()), 1500) : undefined;
  try {
    const res = await fetch("/api/narrow", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: ex.request, asked: ex.asked, level: ex.level }), signal: AbortSignal.timeout(ex.asked.length ? ANSWER_MS : STEP_MS) });
    s = res.ok ? ((await res.json()) as Step) : null;
  } catch {
    s = null; // slow, offline, refused: the search goes ahead with what there is
  }
  clearTimeout(tone);
  toneOff();
  if (!ex || ex.gen !== mine) return;
  const n = nextStep(ex, s);
  if ("ask" in n) ask(n.ask);
  else finish(n.search, n.said);
}

function answer(a: string) {
  if (!ex?.open) return;
  clearTimeout(ex.remind);
  if (ex.open.kind === "level" && classify(a) !== "skip") keepLevel(a);
  ex.asked.push({ q: ex.open.question, a, kind: ex.open.kind });
  ex.answeredAt = Date.now();
  void step();
}

function cancel() {
  close();
  const where = resolveLocal("where am i", currentCtx())?.say ?? "";
  speak(`Cancelled. ${where}`.trim());
}

function onKey(e: KeyboardEvent) {
  if (!ex?.open || e.repeat || e.ctrlKey || e.metaKey || e.altKey || ["Shift", "Control", "Alt", "Meta", " ", "`", "Tab"].includes(e.key)) return;
  const t = e.target as HTMLElement | null;
  const field = t?.closest?.("input, textarea, [contenteditable='true']") as HTMLInputElement | null;
  const k = Number(e.key);
  const take = () => (e.preventDefault(), e.stopImmediatePropagation());
  if (e.key === "Escape") return later(cancel);
  if (k >= 1 && k <= ex.open.options.length && !field?.value) {
    take();
    return answer(ex.open.options[k - 1]);
  }
  if (e.key === "Enter" && !field?.value) {
    take();
    const a = ex.open;
    return later(() => ex?.open === a && speak(questionLine(a, inputStyle())));
  }
  // A reading key leaves the exchange and does what it always does; slash (the ask box's key) and question mark do not.
  if (!field && (/^(?:Arrow|Home|End|Page)/.test(e.key) || /^[a-z]$/i.test(e.key))) close();
}

/** Every search goes through here: a broad one asks first; anything else, or with the models known to be out, searches at once. */
export function narrowSearch(query: string, run: (q: string, said: string) => void) {
  close();
  // "go back to the results" is a command, never search words, whichever way it arrived (the decision model too).
  if (BACK_TO_RESULTS.test(normalise(query)))
    return void window.dispatchEvent(new CustomEvent("arc:command", { detail: { name: "results" } }));
  if (!broad(query) || geminiDown()) return run(query, query);
  ex = { request: normalise(query).split(" ").filter((x) => !SOFT.has(x)).join(" "), asked: [], level: readLevel(), run, gen: 0, answeredAt: 0 };
  window.addEventListener("keydown", onKey, true);
  void step();
}

/** A typed or spoken request while a question is open: true when it was the answer (or a repeat, skip or cancel). */
export function answerNarrow(text: string): boolean {
  if (!ex) return pend && pend.read === false ? whileSearching(text) : false;
  if (!ex.open) return Date.now() - ex.answeredAt < 3000; // the step is on its way; a late revision of the same speech is not a second answer
  // shortcut: a voice revision of an answer can arrive 1 to 2 s later; anything within 3 s of an answer is taken as that revision.
  if (Date.now() - ex.answeredAt < 3000) return true;
  const a = ex.open;
  const c = classify(text);
  if (c === "cancel") return cancel(), true;
  if (c === "skip") return finish(assembled(ex), `${spoken(ex)}${ex.asked.length ? "" : " in general"}`), true; // "Searching for biology in general."
  if (c === "again") return speak(questionLine(a, inputStyle())), true;
  if (c === "where") {
    speak(`${resolveLocal(text, currentCtx())?.say ?? ""} ${questionLine(a, inputStyle(), "I asked:")}`.trim());
    return true;
  }
  const k = pick(text, a.options);
  if (k !== undefined) return answer(a.options[k]), true;
  const r = c === "new" ? null : resolveLocal(text, currentCtx());
  if (c === "new" || (r && r.name !== "none" && r.name !== "search")) {
    close(); // a new request or a reading command: the exchange is left and the request runs as usual
    return false;
  }
  answer(text.trim());
  return true;
}

// ---- while a search runs and nothing is read yet (components/Twin.tsx search) ----

let pend: { mine: number; cancel: () => void; open?: number; read: boolean } | null = null;
export const searchPending = () => !!pend && !pend.read;
export const searchStarted = (mine: number, cancel: () => void) => void (pend = { mine, cancel, read: false });
export const searchDone = (mine: number) => void (pend?.mine === mine && (pend.read = true));
/** The result asked for while searching ("open the first one", a number key), once: Twin opens it instead of reading the list. */
export function takePendingOpen(): number | undefined {
  const k = pend?.open;
  if (pend) pend.open = undefined;
  return k;
}
const ORDS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
function waitFor(k: number, how: string) {
  if (!pend) return;
  pend.open = k;
  const p = pend;
  watchTurn(() => void (p.open === k && (p.open = undefined))); // the student acted again: that wins
  speak(`Still searching. I will open ${how} when it is here.`);
}
function whileSearching(text: string): boolean {
  const r = resolveLocal(text, { ...currentCtx(), mode: "results", onKind: null, index: -1, total: 10, results: undefined });
  if (r?.name === "open" && typeof r.args?.at === "number") return waitFor(r.args.at, `the ${ORDS[r.args.at] ?? `number ${r.args.at + 1}`} one`), true;
  if (r && ["next", "prev", "read", "goto", "moreResults"].includes(r.name)) return speak("Still searching."), true;
  return false;
}
function onSearchKey(e: KeyboardEvent) {
  if (!searchPending() || ex?.open || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest?.("input, textarea, [contenteditable='true'], dialog")) return;
  const k = Number(e.key);
  const take = () => (e.preventDefault(), e.stopImmediatePropagation());
  if (e.key === "Escape") {
    take();
    pend?.cancel();
    return later(() => speak(`Search cancelled. ${resolveLocal("where am i", currentCtx())?.say ?? ""}`.trim()));
  }
  if (k >= 1 && k <= 9) return take(), later(() => waitFor(k - 1, `number ${k}`));
  if (["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) return take(), later(() => speak("Still searching."));
}

if (typeof window !== "undefined") window.addEventListener("keydown", onSearchKey, true);

if (typeof window !== "undefined")
  // Opening a page, a file or another search leaves the exchange.
  window.addEventListener("arc:command", (e) => {
    const n = (e as CustomEvent<{ name?: string }>).detail?.name;
    if (ex && n && ["load", "open", "pdf-file", "refresh", "results"].includes(n)) close();
  });
