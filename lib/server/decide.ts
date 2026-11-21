// Fast decision step: the Gemini Decisions API turns one spoken or typed request into a command with a probability (about 0.35 s).
// Arc acts only when `act` is true; otherwise the caller lets the voice model answer or asks "Did you mean ...?".
import { DISPLAY_COMMANDS } from "@/lib/client/display";
import { GEMINI_DECISION_MODEL } from "@/lib/models";
import { BudgetError, DEPLETED_LINE, checkModel, noteGeminiFailure, recordDecision } from "@/lib/server/budget";

const URL = "https://generativelanguage.googleapis.com/v1beta/decisions";

export const ACTION_MIN = 0.6; // action confidence needed to act
export const TARGET_MIN = 0.6; // target confidence needed for goto and tour

export type Action =
  | "next" | "prev" | "nextFigure" | "prevFigure" | "nextHeading" | "prevHeading" | "goto" | "find" | "read" | "continue" | "stop" | "faster" | "slower" | "top"
  | "where" | "progress" | "help" | "picture" | "tour" | "leave" | "more" | "results" | "play" | "rewind" | "readLecture" | "yes" | "no"
  | "search" | "open" | "refresh" | "question" | "display" | "none";
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

// Each action in plain words, with the ways people say it. The words differ by where the student is, so a few are per mode.
const ACTIONS: Record<Action, string> = {
  next: "move on to the next paragraph or part (\"next\", \"the one after this\", \"skip this paragraph\", \"siguiente\", \"avanza\", \"weiter\", \"tiếp theo\")",
  prev: "go back to the previous paragraph or part (\"back\", \"the one before\", \"anterior\", \"atrás\", \"vuelve atrás\", \"zurück\")",
  nextFigure: "move to the next figure, picture or chart",
  prevFigure: "move back to the previous figure, picture or chart",
  nextHeading: "skip the rest of this section, to the next section or heading (\"next section\", \"skip this section\")",
  prevHeading: "go back to the previous section or heading",
  goto: "jump to a section, figure or table this page has, named by its title, its number or what it is about (\"go to the discussion\", \"section 2.2\", \"figure 3\")",
  find: "find a word or phrase in the text of this page (\"find sampling rate\", \"where does it mention bluetooth\", \"busca clorofila\")",
  read: "say the current part again, repeat it (\"again\", \"say that again\", \"I didn't catch that\", \"repite\", \"¿cómo?\", \"redis-le\", \"nochmal\")",
  continue: "read on, keep reading, carry on or resume from here (\"go on\", \"read it to me\", \"sigue leyendo\", \"lee\")",
  stop: "pause, be quiet, hold on, wait (\"hold on\", \"give me a minute\", \"para\", \"espera\", \"arrête\", \"dừng lại\")",
  faster: "speak or read faster (\"you are too slow\", \"speed up\", \"más rápido\")",
  slower: "speak or read slower (\"you are going too fast\", \"I can't keep up\", \"más despacio\")",
  top: "start again from the very beginning of the page (\"start over\", \"from the top\", \"go to the beginning\")",
  where: "say where the student is: which section, which part (\"where am I\", \"tell me where I am\", \"¿dónde estoy?\", \"wo bin ich\")",
  progress: "say how much is left and how long it will take (\"how much more is there\", \"am I nearly done\", \"how many stops are left\")",
  help: "say what the student can say or do here, and how Arc works (\"help\", \"what can I say\", \"I'm lost\", \"how do I leave\", \"how does this work\", \"¿qué puedo decir?\", \"¿cómo funciona esto?\", \"comment ça marche\", \"Hilfe\")",
  picture: "say whether there is a picture, figure or chart here or nearby (\"is there a picture\", \"¿hay una imagen?\")",
  tour: "start the guided tour of a figure: explore it part by part (\"walk me through this picture\", \"describe the figure\", \"tour figure 3\")",
  leave: "leave where the student is now and go back (out of a picture tour back to the reading; out of the search results back to the page)",
  more: "hear more search results, the next few results (\"more\", \"what else is there\", \"any more\")",
  results: "the search results, only when the student names them (results, the list, the search): go back to the list, or have the current results read out (\"go back to the results\", \"back to the list\", \"read me the results\", \"did you find anything\")",
  play: "play or resume the lecture video (\"play\", \"start the lecture\", \"let's watch it\")",
  rewind: "go back ten seconds in the lecture, replay the last bit (\"rewind\", \"play that again\", \"skip back\")",
  readLecture: "have Arc read the lecture's words aloud instead of playing its sound (\"read it to me instead\", \"read the transcript\")",
  yes: "say yes to what Arc just offered or asked (\"yes please\", \"sure\", \"that would be lovely\", \"go ahead\")",
  no: "say no to what Arc just offered or asked (\"no thanks\", \"not now\", \"never mind\")",
  search: "search the web for study material on a topic or subject the student names (\"find me papers about knee rehab\", \"I want to study biology\")",
  open: "open one of the listed search results, by its number, title or site (\"open the second one\", \"the openstax one\")",
  refresh: "fetch the current page again, live from the web",
  question: "a question or remark about the content, or a reply to something Arc said (\"what does the belt unit contain\", \"why\", \"explain that more simply\", \"what do you mean\")",
  display: "change how the page looks: text size, colours, contrast, brightness, spacing, font, focus line or motion; or say they are blind (voice first)",
  none: "not a request to Arc, or nothing in it Arc can do",
};
// What can happen where the student is: fewer choices, fewer mistakes ("go back" means something else in each mode).
const MODE: Record<string, { actions: Action[]; say: Partial<Record<Action, string>>; rule: string }> = {
  landing: {
    actions: ["search", "open", "help", "stop", "yes", "no", "question", "display", "none"],
    say: { open: "open one of the examples Arc offers: the example paper, the video or the textbook" },
    rule: "Nothing is open yet. Any sentence that names something to study, however it is wrapped (greetings, politeness, a quiz on Friday, their level), is search. A sentence with nothing to study in it (\"hello\", \"I'm new here\", \"what can I do\") is help.",
  },
  article: {
    actions: ["next", "prev", "nextFigure", "prevFigure", "nextHeading", "prevHeading", "goto", "find", "read", "continue", "stop", "faster", "slower", "top", "where", "progress", "help", "picture", "tour", "search", "results", "yes", "no", "refresh", "question", "display", "none"],
    say: {},
    rule: "A page is open and Arc reads it aloud. find is only for a request to find words in this page; a request for other material on the web is search; going back to the search results (\"back to the list\") is results.",
  },
  results: {
    actions: ["next", "prev", "open", "more", "results", "leave", "read", "stop", "faster", "slower", "where", "help", "search", "yes", "no", "question", "display", "none"],
    say: {
      next: "move to the next result in the list",
      prev: "move to the previous result in the list (\"the one before\", \"previous result\")",
      read: "read the current result again",
      results: "read the list of results out again from the start (\"read me the results\", \"what did you find\", \"did you find anything\", \"list them\")",
      leave: "leave the results and go back to the page the student was reading (\"go back\", \"back to the paper\", \"close the results\", \"I'm done with the results\")",
      search: "a new search with other words (\"search for gait analysis instead\", \"look up cell division\")",
    },
    rule: "Search results are listed, numbered in order. A question about a result (who wrote it, is it free, which is best) is question, not open.",
  },
  tour: {
    actions: ["next", "prev", "read", "continue", "stop", "faster", "slower", "leave", "progress", "where", "help", "search", "yes", "no", "question", "none"],
    say: {
      next: "the next stop of the picture tour (\"next stop\", \"the next part\", \"skip this stop\")",
      prev: "the previous stop of the picture tour (\"the stop before\", \"go back a stop\")",
      read: "say this stop again",
      continue: "resume the tour after a pause (\"go on\", \"carry on\", \"resume the tour\")",
      stop: "pause the tour for a moment (\"hold on\", \"wait\", \"pause the tour\")",
      leave: "leave the picture tour and go back to the reading (\"that is enough\", \"leave it and take me back to the reading\", \"no more picture please\", \"get me out\", \"basta\", \"salir\")",
      progress: "how many stops are left, or whether this is the last one",
    },
    rule: "A picture tour is open: Arc describes a figure stop by stop. Leaving the tour is leave, never next or continue.",
  },
  video: {
    actions: ["play", "stop", "rewind", "readLecture", "next", "prev", "goto", "read", "faster", "slower", "where", "progress", "help", "tour", "search", "yes", "no", "question", "display", "none"],
    say: { stop: "pause the lecture video, or be quiet (\"pause\", \"stop the video\", \"hold on\")", next: "the next part of the lecture", prev: "the previous part of the lecture", read: "say the current part again" },
    rule: "A lecture video is open.",
  },
};

/** Pure: whether Arc may act on this decision without asking. */
export function shouldAct(action: Action, confidence: number, target: string | null, targetConfidence: number): boolean {
  if (confidence < ACTION_MIN) return false;
  if (action === "none" || action === "question") return false;
  if (action === "goto" || action === "open" || action === "display") return targetConfidence >= TARGET_MIN && target !== null && target !== "none";
  if (action === "tour") return target === null || targetConfidence >= TARGET_MIN; // no figure named: the one here or the nearest (components/Reader.tsx)
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

const key = () => {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error("GEMINI_API_KEY is not set");
  return k;
};

/** One request, 2.5 s timeout, one quick retry on a timeout, 429 or 5xx. */
async function post(body: unknown): Promise<Response> {
  const go = () =>
    fetch(URL, {
      method: "POST",
      headers: { "x-goog-api-key": key(), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2500),
    });
  const bad = (r: Response) => r.status === 429 || r.status >= 500;
  let res: Response | undefined;
  try {
    res = await go();
  } catch {}
  if (!res || bad(res)) {
    await new Promise((r) => setTimeout(r, 150));
    res = await go();
  }
  return res;
}

type Choice = { choice: string; probabilities?: Record<string, number>; confidence?: number };
const conf = (a: Choice) => a.confidence ?? a.probabilities?.[a.choice] ?? 0;

/** Opens the TLS connection to the Decisions API ahead of the first request; Node's fetch keeps it alive in its pool. */
export const warm = () => fetch(URL, { method: "HEAD", signal: AbortSignal.timeout(4000) }).catch(() => {});

export async function decide(input: { utterance: string; items: Item[]; inTour?: boolean; state?: Record<string, string> }): Promise<Decision> {
  checkModel("decide");
  const t0 = Date.now();
  // Headings only, truncated: the request stays small and fast. Keys must match [A-Za-z0-9_-]+ and "none" is always an option.
  const items = input.items.filter((i) => /^[\w-]{1,64}$/.test(i.id) && i.id !== "none").slice(0, 120);
  if (!items.length) items.push({ id: "top", label: "the top of the page" }); // the API needs at least two options
  const s = { ...input.state };
  const mode = MODE[s.mode ?? (input.inTour ? "tour" : "article")] ?? MODE.article;
  const said = s.arc_last_said; // Arc's last turn, when it was an answer or a question to the student
  const where = [`mode: ${s.mode ?? (input.inTour ? "tour" : "unknown")}`, ...Object.entries(s).filter(([k]) => k !== "mode" && k !== "arc_last_said").map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)];
  const body = {
    model: GEMINI_DECISION_MODEL,
    // Only model, input and questions are accepted. The context rides in the input text.
    input:
      `A blind student is using Arc, a voice reader for study pages. ${mode.rule} Reader state: ${where.join("; ")}. ` +
      (said ? `Arc's last turn, an answer or question to the student: "${said.slice(0, 240)}". ` : "") +
      `The student said: "${input.utterance.slice(0, 300)}"`,
    questions: {
      action: {
        type: "choice",
        instructions:
          "What does the student ask Arc to do? Decide by meaning, not exact words: requests come polite, long, rambling, in non-native word order, or in any language (Spanish, French, German, Vietnamese and others), and the meaning is the same. " +
          "A question or remark about the content (\"what is a quaternion\", \"why is the belt needed\", \"this is interesting\") is question, even when it names a section or a word on the page; never move or find for it. " +
          (said ? "Arc just answered or asked something: a short reply to that (yes, no, that one, explain it more simply, what do you mean, and the second one?, no I mean X) is question, never search, find or next. " : "") +
          "yes and no are only replies to an offer Arc made (offer pending). Choose none when the words are not addressed to Arc or nothing can be made of them. When unsure, give a low confidence: Arc then asks.",
        criteria: Object.fromEntries(mode.actions.map((a) => [a, mode.say[a] ?? ACTIONS[a]])),
      },
      target: {
        type: "choice",
        instructions:
          "Which listed section, figure or search result does the utterance name? \"The second one\" means Result 2. \"This\", \"it\" or \"this one\" means the current item. Choose none if the utterance names none of them or asks for something that needs no item.",
        criteria: { ...Object.fromEntries(items.map((i) => [i.id, i.label.replace(/\s+/g, " ").slice(0, 100)])), none: "no listed item is named" },
      },
      setting: {
        type: "choice",
        instructions: "If the utterance asks to change how the page looks, which display change does it ask for? Choose none otherwise.",
        criteria: { ...DISPLAY_COMMANDS, none: "not a display change" },
      },
    },
  };
  const res = await post(body);
  if (!res.ok && noteGeminiFailure(res.status, await res.clone().text().catch(() => ""))) throw new BudgetError(DEPLETED_LINE, "depleted");
  if (!res.ok) throw new Error(`Decisions API answered HTTP ${res.status}`);
  const reply = await res.json();
  recordDecision(GEMINI_DECISION_MODEL, reply.usage);
  const answers = reply.answers as { action: Choice; target: Choice; setting?: Choice };
  const action = (answers.action.choice in ACTIONS ? answers.action.choice : "none") as Action;
  const confidence = conf(answers.action);
  const targetConfidence = conf(answers.target);
  const target = items.some((i) => i.id === answers.target.choice) ? answers.target.choice : null; // an unknown id counts as none
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
