// One typed or spoken request: decide, act only when sure, say "not sure" once. Used by CommandBox and AskButton.
import { decide, dispatchDecision, type Decision } from "@/lib/client/decide";
import { said, speaker } from "@/lib/client/reader";
import type { Item } from "@/lib/server/decide";

export const NOT_SURE = "I am not sure what you meant. Try again.";

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

/** quiet: the voice path lets Gemini ask what was meant, so Arc does not say "not sure" itself. */
export async function submitUtterance(text: string, { quiet = false } = {}): Promise<Decision> {
  const d = await preDecide(text);
  act(d);
  if (unsure(d) && !quiet) {
    said(NOT_SURE);
    void speaker.say([NOT_SURE]);
  }
  return d;
}

/** One short plain line: what was decided, how sure, how fast. */
export function describe(d: Decision): string {
  if (unsure(d)) return NOT_SURE;
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
