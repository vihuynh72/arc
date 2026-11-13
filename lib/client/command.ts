// One typed or spoken request: decide, act only when sure, say "not sure" once. Used by CommandBox and AskButton.
import { decide, dispatchDecision, type Decision } from "@/lib/client/decide";
import { said, speaker } from "@/lib/client/reader";
import { answerText, askText, playAnswer } from "@/lib/client/voice";
import type { Item } from "@/lib/server/decide";

export const NOT_SURE = "I am not sure what you meant. Try again.";
const ASK_ALOUD = "Hold Space and ask that out loud.";
const ACTION_SURE = 0.6; // same as ACTION_MIN in lib/server/decide.ts, which the browser does not import

// What Twin currently shows; Twin keeps it fresh so callers only pass the text.
const ctx = { items: [] as Item[], inTour: false };
// Decisions by text for the current context: the held-key pre-ask, the early transcript and Live's "heard" share one call.
let cache = new Map<string, Promise<Decision>>();
export function setCommandContext(items: Item[], inTour: boolean) {
  ctx.items = items;
  ctx.inTour = inTour;
  cache = new Map();
}

const key = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Asks Snap without acting; the same text asks once per page context. */
export function preDecide(text: string): Promise<Decision> {
  const k = key(text);
  let p = cache.get(k);
  if (!p) {
    p = decide(text, ctx.items, ctx.inTour);
    p.catch(() => cache.delete(k)); // a failure is retried next time
    cache.set(k, p);
  }
  return p;
}

/** Runs a decision Arc is sure of. */
export const act = (d: Decision) => dispatchDecision(d, ctx.items);

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
export async function submitUtterance(text: string, { quiet = false, onAnswer }: { quiet?: boolean; onAnswer?: (text: string) => void } = {}): Promise<Decision> {
  const d = await preDecide(text);
  act(d);
  if (quiet) return d;
  const speak = (line: string) => {
    said(line);
    void speaker.say([line]);
  };
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

/** One short plain line: what was decided, how sure, how fast. */
export function describe(d: Decision): string {
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
    read: "read again",
    stop: "stop",
    question: "a question",
    none: "not a request",
  };
  return `${what[d.action]} · ${Math.round(d.confidence * 100)}% sure · ${Math.round(d.ms)} ms`;
}
