// One typed or spoken request: decide, act only when sure, say "not sure" once. Used by CommandBox and AskButton.
import { decide, dispatchDecision, type Decision } from "@/lib/client/decide";
import { said, speaker } from "@/lib/client/reader";
import { answerText, askText, playAnswer } from "@/lib/client/voice";
import type { Item } from "@/lib/server/decide";
import { resolveLocal, type Ctx, type Mode, type Offer, type Resolved } from "@/lib/intent";

export const NOT_SURE = "I did not catch that. Say help for what you can do.";
const ASK_ALOUD = "Hold Space and ask that out loud.";
const ACTION_SURE = 0.6; // same as ACTION_MIN in lib/server/decide.ts, which the browser does not import

// What Twin currently shows; Twin keeps it fresh so callers only pass the text.
const ctx = { items: [] as Item[], inTour: false, mode: "landing" as Mode, title: "" };
// Where the cursor is (from Reader's arc:cursor), the last two commands, and an offer such as "Say tour to explore it."
const here = { id: null as string | null, kind: null as string | null, heading: "", back: false };
let recent: string[] = [];
let offer: Offer | undefined;
let listening = false;
function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("arc:cursor", (e) => {
    const d = (e as CustomEvent<{ id: string; kind: string; heading: string; back?: boolean }>).detail;
    if (d) Object.assign(here, { id: d.id, kind: d.kind, heading: d.heading, back: !!d.back });
  });
  window.addEventListener("arc:command", (e) => {
    const n = (e as CustomEvent<{ name: string; args?: { silent?: boolean } }>).detail;
    if (n?.name && !n.args?.silent) recent = [...recent, n.name].slice(-2);
  });
  window.addEventListener("arc:offer", (e) => void (offer = { ...(e as CustomEvent<Omit<Offer, "at">>).detail, at: Date.now() }));
}

// Decisions by text for the current context: the held-key pre-ask, the early transcript and Live's "heard" share one call.
let cache = new Map<string, Promise<Decision>>();
export function setCommandContext(items: Item[], inTour: boolean, page: { mode: Mode; title: string } = { mode: "landing", title: "" }) {
  listen();
  ctx.items = items;
  ctx.inTour = inTour;
  ctx.mode = page.mode;
  ctx.title = page.title;
  cache = new Map();
}

/** The state the local grammar, Snap and "where am i" decide over. */
export function currentCtx(): Ctx {
  const index = here.id ? ctx.items.findIndex((i) => i.id === here.id) : -1;
  const kind = index < 0 ? null : ctx.mode === "results" ? "result" : (here.kind as Ctx["onKind"]);
  // The tour's own line ("Stop 2 of 6: right thigh."), read from the page: FigureTour does not announce its stops.
  const stop = ctx.inTour ? document.querySelector("[data-tour] p strong")?.textContent?.replace(/\.$/, "").replace(/^S/, "s") : undefined;
  return {
    mode: ctx.inTour ? "tour" : ctx.mode,
    onKind: ctx.inTour ? "figure" : kind,
    index,
    total: ctx.items.length,
    lastCommand: recent.join(", ") || undefined,
    pendingOffer: offer,
    canGoBack: here.back,
    label: index >= 0 ? here.heading : undefined,
    title: ctx.title,
    stop: stop || undefined,
    now: Date.now(),
  };
}

const speak = (line: string) => {
  said(line);
  void speaker.say([line]);
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
  offer = undefined; // used, refused, or overtaken by another request
  if (r.name !== "none") {
    // The tour takes one step per command; the reader takes one combined move and reads only where it lands.
    if (c.mode === "tour" && r.steps) for (let i = 0; i < r.steps; i++) send(r.name);
    else send(r.name, { ...r.args, ...(r.steps ? { steps: r.steps } : {}) });
  }
  if (r.say) speak(r.say);
  console.info(`[arc-timing] local "${text}" -> ${r.name}${r.steps ? ` x${r.steps}` : ""}${r.say ? ` says "${r.say}"` : ""} in ${(performance.now() - t0).toFixed(1)} ms`);
  return r;
}

/** Short state for Snap, so "the one after that" or "this figure" can be decided. */
function snapState(): Record<string, string> {
  const c = currentCtx();
  const item = ctx.items[c.index];
  return {
    mode: c.mode,
    current_item: item ? `${item.label} (${c.onKind})` : "none yet",
    position: c.index >= 0 ? `${c.index + 1} of ${c.total}` : `before the first of ${c.total}`,
    last_commands: c.lastCommand ?? "none",
    offer_pending: c.pendingOffer && Date.now() - c.pendingOffer.at < 20_000 ? `${c.pendingOffer.name} ${JSON.stringify(c.pendingOffer.args ?? {})}` : "none",
    ...(c.stop ? { tour_stop: c.stop } : {}),
  };
}

const key = (text: string) => `${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()}|${here.id}`;

/** Asks Snap without acting; the same text asks once per page context and cursor position. */
export function preDecide(text: string): Promise<Decision> {
  const k = key(text);
  let p = cache.get(k);
  if (!p) {
    p = decide(text, ctx.items, ctx.inTour, snapState());
    p.catch(() => cache.delete(k)); // a failure is retried next time
    cache.set(k, p);
  }
  return p;
}

/** Runs a decision Arc is sure of. */
export const act = (d: Decision) => {
  if (d.act) offer = undefined;
  dispatchDecision(d, ctx.items);
};

const unsure = (d: Decision) => !d.act && d.action !== "question" && d.action !== "none";

/** Snap is sure the student wants goto or tour, but no section or figure fits. */
const notFound = (d: Decision) => (d.action === "goto" || d.action === "tour") && d.confidence >= ACTION_SURE && !d.act;

const notFoundLine = (d: Decision) =>
  `I could not find "${d.query.replace(/^(?:take me to|bring me to|go to|jump to|skip to|navigate to|show me|tour|start)\s+(?:the\s+)?/i, "")}" on this page.`;

/** A typed question, or a request Snap is unsure of, goes to the question session, as a spoken one does. */
export const viaGemini = (d: Decision) => d.action === "question" || unsure(d);

/** Typed text to the question session: plays its answer, runs its one command, resolves with its transcript (null: relay failed). */
async function askTyped(text: string): Promise<string | null> {
  let ran = false;
  const id = askText(text, (name, args) => {
    if (ran) return; // never run a command twice
    ran = true;
    window.dispatchEvent(new CustomEvent("arc:command", { detail: { name, args } }));
  });
  void playAnswer(id);
  return answerText(id);
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
  const r = runLocal(text, alternatives);
  if (r) return localDecision(r);
  const d = await preDecide(text);
  act(d);
  if (quiet) return d;
  if (notFound(d)) speak(notFoundLine(d));
  else if (viaGemini(d))
    void askTyped(text)
      .catch(() => null)
      .then((a) => {
        if (a == null) speak(d.action === "question" ? ASK_ALOUD : NOT_SURE);
        onAnswer?.(a ?? (d.action === "question" ? ASK_ALOUD : NOT_SURE));
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
    stop: "stop",
    question: "a question",
    display: `display: ${d.setting}`,
    none: "not a request",
  };
  return `${what[d.action]} · ${Math.round(d.confidence * 100)}% sure · ${Math.round(d.ms)} ms`;
}
