// Fast decision step: SubQ Snap turns one spoken or typed request into a command with a probability (about 0.4 s).
// Arc acts only when `act` is true; otherwise the caller lets the voice model answer or asks "Did you mean ...?".
import { DISPLAY_COMMANDS } from "@/lib/client/display";

const URL = "https://api.subq.ai/v1/systemone";
const MODEL = "subq-snap-1.2";

export const ACTION_MIN = 0.6; // action confidence needed to act
export const TARGET_MIN = 0.6; // target confidence needed for goto and tour

export type Action = "next" | "prev" | "nextFigure" | "prevFigure" | "nextHeading" | "prevHeading" | "goto" | "read" | "stop" | "tour" | "search" | "open" | "refresh" | "question" | "display" | "none";
export interface Item {
  id: string;
  label: string;
}
export interface Decision {
  action: Action;
  confidence: number;
  target: string | null;
  targetConfidence: number;
  setting: string | null; // display: which of DISPLAY_COMMANDS
  settingConfidence: number;
  query: string;
  ms: number;
  act: boolean;
}

const ACTIONS: Record<Action, string> = {
  next: "move to the next item on the page (\"the one after that\", \"next\")",
  prev: "move back to the previous item on the page (\"the one before\", \"back\")",
  nextFigure: "move to the next figure, image or chart",
  prevFigure: "move back to the previous figure, image or chart",
  nextHeading: "skip to the next heading or section (\"skip this part\", \"next section\")",
  prevHeading: "go back to the previous heading or section",
  goto: "jump to a named section or figure of this page",
  read: "read the current item aloud, or read it again",
  stop: "be quiet, stop talking",
  tour: "start the guided tour of a figure",
  search: "find a different study page on the web",
  open: "open one of the listed search results, or a link the student names",
  refresh: "fetch the current page again, live from the web",
  question: "answer a question about the content of this page",
  display: "change how the page looks: text size, colours, contrast, brightness, spacing, font, focus line or motion",
  none: "not a request to Arc",
};

/** Pure: whether Arc may act on this decision without asking. */
export function shouldAct(action: Action, confidence: number, target: string | null, targetConfidence: number): boolean {
  if (confidence < ACTION_MIN) return false;
  if (action === "none" || action === "question") return false;
  if (action === "goto" || action === "tour" || action === "open" || action === "display") return targetConfidence >= TARGET_MIN && target !== null && target !== "none";
  return true;
}

const FILLER = /^(?:(?:hey|ok|okay|um|uh|please|arc|now|so|and|just|can you|could you|would you|will you|i want you to|i want to|i'd like to|i would like to|let's|lets)\b[\s,]*)+/i;
const SEARCH = /^(?:search(?:\s+the web)?\s+for|search|find\s+me|find|look\s+up|look\s+for|get\s+me|show\s+me)\b[\s,]*(?:(?:a|an|the|some)\s+)?(?:(?:papers?|articles?|pages?|study|studies)\s+(?:about|on|for|of)\s+)?/i;

/** Pure: the utterance without leading filler; for search also without the search verb. */
export function cleanQuery(utterance: string, action?: Action): string {
  let q = utterance.trim().replace(FILLER, "");
  if (action === "search") q = q.replace(SEARCH, "");
  return q.replace(/[\s.?!]+$/, "").trim();
}

let envTried = false;
function key(): string {
  if (!process.env.SUBQ_API_KEY && !envTried) {
    envTried = true;
    try {
      process.loadEnvFile(".env.local"); // the dev server may have started before the key was added
    } catch {}
  }
  const k = process.env.SUBQ_API_KEY;
  if (!k) throw new Error("SUBQ_API_KEY is not set");
  return k;
}

async function post(body: unknown): Promise<Response> {
  const go = () =>
    fetch(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  let res = await go();
  if (res.status === 429 || res.status >= 500) {
    await new Promise((r) => setTimeout(r, 300));
    res = await go();
  }
  return res;
}

type Choice = { choice: string; probabilities?: Record<string, number>; confidence?: number };
const conf = (a: Choice) => a.confidence ?? a.probabilities?.[a.choice] ?? 0;

/** Opens the TLS connection to SubQ ahead of the first request; Node's fetch keeps it alive in its pool. */
export const warm = () => fetch(URL, { method: "HEAD", signal: AbortSignal.timeout(4000) }).catch(() => {});

export async function decide(input: { utterance: string; items: Item[]; inTour?: boolean; state?: Record<string, string> }): Promise<Decision> {
  const t0 = Date.now();
  const items = input.items.slice(0, 120).map((i) => ({ id: i.id, label: i.label.slice(0, 120) }));
  const body = {
    model: MODEL,
    state: { ...input.state, utterance: input.utterance, in_tour: input.inTour ?? false },
    questions: {
      action: {
        type: "choice",
        instructions:
          "A blind student is using a voice reader on a study page. The state says where the reader's cursor is now (mode, current item, position) and the last commands. " +
          "Short requests depend on it: \"the one after that\" is next; \"skip this part\" is nextHeading; \"the next figure\" is nextFigure; \"go back to the methods\" is goto; \"the figure\" or \"tour it\" on a figure is tour. " +
          "A question about the content (\"what is this\", \"why\") is question. What does the utterance ask the reader to do? Choose none if it is not addressed to the reader.",
        criteria: ACTIONS,
      },
      target: {
        type: "choice",
        instructions:
          "Which listed section, figure or search result does the utterance refer to? \"The second one\" means Result 2. \"This\", \"it\" or \"this one\" means the current item in the state. Choose none if it names none of them.",
        criteria: { ...Object.fromEntries(items.map((i) => [i.id, i.label])), none: "no listed item is named" },
      },
      setting: {
        type: "choice",
        instructions: "If the utterance asks to change how the page looks, which display change does it ask for? Choose none otherwise.",
        criteria: { ...DISPLAY_COMMANDS, none: "not a display change" },
      },
    },
  };
  const res = await post(body);
  if (!res.ok) throw new Error(`SubQ answered HTTP ${res.status}`);
  const answers = (await res.json()).answers as { action: Choice; target: Choice; setting?: Choice };
  const action = (answers.action.choice in ACTIONS ? answers.action.choice : "none") as Action;
  const confidence = conf(answers.action);
  const targetConfidence = conf(answers.target);
  const target = answers.target.choice === "none" ? null : answers.target.choice;
  const setting = answers.setting && answers.setting.choice in DISPLAY_COMMANDS ? answers.setting.choice : null;
  const settingConfidence = answers.setting ? conf(answers.setting) : 0;
  return {
    action,
    confidence,
    target,
    targetConfidence,
    setting,
    settingConfidence,
    query: cleanQuery(input.utterance, action),
    ms: Date.now() - t0,
    act: action === "display" ? shouldAct(action, confidence, setting, settingConfidence) : shouldAct(action, confidence, target, targetConfidence),
  };
}
