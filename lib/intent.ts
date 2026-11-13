// Local grammar for the one- and two-word requests a blind student actually says ("next", "next next", "that one",
// "again", "where am i"). Pure, no DOM, 0 ms. Called first by submitUtterance in lib/client/command.ts (typed and
// spoken); null means "not one of these" and the Snap/Gemini path runs as before. Checked by scripts/checks/intent.ts.
//
// Only a WHOLE short utterance (at most five words after filler is removed) resolves: "what comes next in the
// experiment" is a question and goes on to Snap and Gemini.
//
// Meaning by context:
// | said                        | landing        | article / video                 | results                 | tour                 |
// |-----------------------------|----------------|---------------------------------|-------------------------|----------------------|
// | next, skip, forward (x n)   | nothing open   | next item (n steps)             | next result (n)         | next stop (n)        |
// | back, previous (x n)        | nothing open   | previous item (n steps)         | previous result (n)     | previous stop (n)    |
// | again, repeat, what         | nothing open   | read the item again             | read the result again   | repeat the stop      |
// | more, go on, read it        | nothing open   | keep reading from here          | read the snippet        | repeat the stop      |
// | open, that one, this one    | nothing open   | on a figure: its tour; else -   | open result under cursor| already in the tour  |
// | tour, explore, this         | nothing open   | tour (this = only on a figure)  | -                       | already in the tour  |
// | leave, exit, done, close    | nothing open   | -                               | back to the page        | leave the tour       |
// | first..tenth, last, 3       | nothing open   | first = top, last = end         | move to that result     | -                    |
// | open the second one         | nothing open   | -                               | open that result        | -                    |
// | next/previous figure/heading| nothing open   | move by figure or heading       | -                       | say leave first      |
// | start/top, end/bottom       | nothing open   | first or last item              | first or last result    | -                    |
// | go back, return             | nothing open   | the place before the last jump  | same                    | -                    |
// | yes / no                    | runs or clears an offer made in the last 20 s (for example "Say tour to explore it.")   |
// | stop, faster, slower, where am i, help: everywhere, worded for the mode                                           |

export type Mode = "landing" | "article" | "results" | "video" | "tour";
export interface Offer {
  name: string;
  args?: Record<string, unknown>;
  say?: string;
  at: number; // ms timestamp when offered
}
export interface Ctx {
  mode: Mode;
  onKind: "section" | "figure" | "segment" | "result" | null;
  index: number; // -1: no cursor yet
  total: number;
  lastCommand?: string;
  pendingOffer?: Offer;
  canGoBack: boolean;
  label?: string; // current item heading (in a tour: the figure)
  title?: string; // page title
  stop?: string; // in a tour: "stop 2 of 6: right thigh"
  now?: number;
}
export interface Resolved {
  name: string; // an arc:command name, or "none" (only speak `say`)
  args?: Record<string, unknown>;
  steps?: number;
  say?: string;
}

export const OFFER_MS = 20_000;
const MAX_WORDS = 5;
export const LANDING_LINE = "Nothing is open yet. Say what you want to study, or paste a link.";
export const HELP: Record<Mode, string> = {
  landing: "Say what you want to study, or paste a link.",
  article: "Say next, back, or a section name. Say tour on a figure. Ask a question any time.",
  video: "Say next, back, or a part name. Ask a question any time.",
  results: "Say next, or open the first one.",
  tour: "Say next or back, ask about this part, or say leave.",
};

const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const ORD: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5, "6th": 6, "7th": 7, "8th": 8, "9th": 9, "10th": 10,
};
// Mishearings that can only mean one thing.
const MISHEARD: Record<string, string> = { necks: "next", nex: "next", nexts: "next", neckst: "next", bak: "back", stahp: "stop", stopp: "stop", agin: "again", agan: "again" };

type Word =
  | "next" | "prev" | "again" | "more" | "stop" | "open" | "tour" | "this" | "leave" | "yes" | "no" | "faster" | "slower"
  | "louder" | "where" | "help" | "top" | "end" | "goback" | "nextFigure" | "prevFigure" | "nextHeading" | "prevHeading";

const PHRASES: Record<Word, string[]> = {
  next: ["next", "forward", "continue", "keep going", "skip", "next one", "skip this", "skip it", "skip this part", "move on", "onward"],
  prev: ["back", "previous", "prev", "before", "backward", "backwards", "previous one", "go previous", "one back"],
  again: ["again", "repeat", "say that again", "say again", "repeat that", "what", "pardon", "come again", "once more", "sorry what", "what was that"],
  more: ["more", "go on", "read it", "read this", "read more", "tell me more", "keep reading", "read on", "read that"],
  stop: ["stop", "quiet", "pause", "shh", "shhh", "shush", "hush", "be quiet", "silence", "enough", "stop talking", "stop reading"],
  open: ["open", "open it", "open this", "open that", "that one", "this one", "go there", "select", "choose", "pick", "open this one", "open that one", "pick this", "pick that", "choose this", "this page", "that page", "open this page"],
  tour: ["tour", "tour this", "tour it", "explore", "explore this", "explore it", "start the tour", "tour this figure", "explore this figure", "explore the figure", "tour the figure", "start tour"],
  this: ["this", "that", "this figure", "that figure"],
  leave: ["leave", "exit", "done", "close", "out", "get out", "leave the tour", "exit the tour", "end the tour", "quit", "i'm done", "im done", "leave tour", "exit tour", "close it", "back to the page"],
  yes: ["yes", "yeah", "yep", "yup", "ok", "okay", "sure", "do it", "go ahead", "please do", "alright", "all right", "yes please", "yeah sure", "sure thing"],
  no: ["no", "nope", "cancel", "never mind", "nevermind", "no thanks", "not now", "no thank you", "don't", "dont"],
  faster: ["faster", "speed up", "quicker", "more quickly", "read faster", "talk faster", "a bit faster"],
  slower: ["slower", "slow down", "more slowly", "read slower", "talk slower", "a bit slower"],
  louder: ["louder", "speak up", "volume up", "turn it up"],
  where: ["where am i", "where", "where are we", "where am i now", "what page is this", "where is this"],
  help: ["what can i do", "help", "options", "what can i say", "commands", "help me", "what now", "what do i do"],
  top: ["start", "top", "beginning", "start over", "the top", "the beginning", "from the top", "back to the top", "back to the start", "restart"],
  end: ["end", "bottom", "the end", "the bottom", "to the end", "to the bottom"],
  goback: ["go back", "return", "take me back", "go back to where i was", "back to where i was", "where i was", "go back there"],
  nextFigure: ["next figure", "the next figure", "next image", "next picture", "next chart", "next graph", "next diagram"],
  prevFigure: ["previous figure", "the previous figure", "figure before", "previous image", "previous picture", "previous chart"],
  nextHeading: ["next heading", "next section", "the next section", "next part", "next chapter"],
  prevHeading: ["previous heading", "previous section", "the previous section", "previous part", "section before"],
};
// Whole-utterance mishearings from real voices in a noisy room. Used only when the utterance is exactly one of these,
// and tour and leave ones only where the real word makes sense (on a figure; in a tour or a result list).
const MISHEARD_PHRASES: Partial<Record<Word, string[]>> = {
  next: ["text", "nest", "necks", "nex", "next to", "neck's"],
  prev: ["pack", "bach", "beck"],
  again: ["a game", "the game", "again again", "gain"],
  open: ["hoping", "opened", "opening", "oven", "open in"],
  more: ["moor", "mor", "mohr", "maur"],
  leave: ["live", "leaf", "leaves", "lead"],
  tour: ["tor", "to her", "two were", "store", "door", "tore", "torr", "to", "two", "tour tour", "toward"],
};
const FUZZY = new Map<string, Word>();
for (const [w, list] of Object.entries(MISHEARD_PHRASES) as [Word, string[]][]) for (const p of list) FUZZY.set(p, w);
const LOOKUP = new Map<string, Word>();
for (const [w, list] of Object.entries(PHRASES) as [Word, string[]][]) for (const p of list) LOOKUP.set(p, w);

const LEAD = /^(?:hey arc|ok arc|okay arc|arc|hey|ok|okay|um+|uh+|er+|erm|hmm+|please|can you|could you|would you|will you|can we|let's|lets|just|now|so|and|oh|alright then)\s+/;
const TAIL = /\s+(?:please|arc|now|thanks|thank you)$/;

/** Lower case, no punctuation, mishearings fixed, filler removed from both ends (only while words remain). */
export function normalise(u: string): string {
  let s = u.toLowerCase().replace(/[’`]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
  s = s.split(" ").map((w) => MISHEARD[w] ?? w).join(" ");
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(LEAD, "").replace(TAIL, "").trim();
  }
  return s;
}

const num = (w: string) => NUM[w] ?? (/^\d+$/.test(w) ? Number(w) : undefined);

/** A position named on its own: "second", "the second one", "number 3", "last", "3", "result 2". 0-based, or "last". */
function position(s: string): number | "last" | undefined {
  const m = s.match(/^(?:the )?(?:(?:number|result|item) )?(\w+)(?: (?:one|result|item|link|page|paper))?$/);
  if (!m) return undefined;
  if (m[1] === "last") return "last";
  const n = ORD[m[1]] ?? (/^(?:number|result|item) /.test(s.replace(/^the /, "")) || /^\d+$/.test(m[1]) ? num(m[1]) : undefined);
  return n && n >= 1 ? n - 1 : undefined;
}

/** One move word repeated ("next next"), or a move word and a count ("next three", "skip 2 sections", "back two"). */
function counted(s: string): { word: "next" | "prev"; steps: number } | undefined {
  const words = s.split(" ");
  const base = (w: string) => (w === "next" || w === "forward" || w === "skip" ? "next" : w === "back" || w === "previous" || w === "prev" ? "prev" : undefined);
  const b = base(words[0]);
  if (!b) return undefined;
  if (words.length > 1 && words.every((w) => base(w) === b)) return { word: b, steps: Math.min(words.length, 10) };
  const m = s.match(/^(?:next|forward|skip|back|previous|prev)(?: by)? (\w+)(?: (?:more|times|items|sections|results|stops|parts|steps|ones))?$/);
  const n = m && num(m[1]);
  return n ? { word: b, steps: Math.min(n, 10) } : undefined;
}

const NAV = new Set<Word>(["next", "prev", "again", "more", "open", "tour", "this", "leave", "top", "end", "goback", "nextFigure", "prevFigure", "nextHeading", "prevHeading"]);

function where(c: Ctx): string {
  if (c.mode === "landing") return "Nothing is open yet. Say what you want to study, or paste a link.";
  if (c.mode === "tour") return `${c.label ?? "Figure"} tour, ${c.stop ?? "at the overview"}.`;
  const at = c.index + 1;
  if (c.mode === "results") return c.index < 0 ? `Search results, ${c.total} of them. Say next.` : `Search results, ${at} of ${c.total}.`;
  const kind = c.onKind === "figure" ? "figure" : c.mode === "video" ? "part" : "section";
  const page = c.title ? `, in ${c.title}` : "";
  if (c.index < 0) return `At the top${page}. Say next to start.`;
  return `${c.label ? `${c.label}, ` : ""}${kind} ${at} of ${c.total}${page}.`;
}

// "I am blind" and its kin turn on voice first (lib/client/display.ts) in every mode, at once.
const DISPLAY_PHRASES: Record<string, string> = {
  "i am blind": "voice-first", "i'm blind": "voice-first", "im blind": "voice-first", "i cannot see": "voice-first", "i can't see": "voice-first",
  "i cant see": "voice-first", "i can't see the screen": "voice-first", "i cannot see the screen": "voice-first", "i cant see the screen": "voice-first",
  "blind mode": "voice-first", "voice first": "voice-first", "turn on voice first": "voice-first",
  "turn off voice first": "voice-first-off", "voice first off": "voice-first-off",
  "reset display": "reset", "reset the display": "reset",
};

/** The whole utterance as a command for this context, or null to let Snap and Gemini decide. */
export function resolveLocal(utterance: string, c: Ctx): Resolved | null {
  const s = normalise(utterance);
  if (!s || s.split(" ").length > MAX_WORDS) return null;
  if (DISPLAY_PHRASES[s]) return { name: "display", args: { setting: DISPLAY_PHRASES[s] } };
  const go = s.replace(/^go (?:to )?(?:the )?(?=\S)/, ""); // "go next", "go to the top"; "go back" and "go on" are phrases of their own
  const onFigure = c.onKind === "figure";
  const exact = LOOKUP.get(s) ?? (go !== s && !LOOKUP.has(s) ? LOOKUP.get(go) : undefined);
  const fuzzy = exact ? undefined : FUZZY.get(s);
  // A misheard tour only counts on a figure (or in an offer); a misheard leave only where leave means something.
  const fuzzyOk = fuzzy && (fuzzy === "tour" ? onFigure || c.mode === "tour" || !!c.pendingOffer : fuzzy === "leave" ? c.mode === "tour" || c.mode === "results" : true);
  const word = exact ?? (fuzzyOk ? fuzzy : undefined);
  // "tour figure 1", and on a figure the way it is misheard: "to figure one", "tor figure one", "the figure one".
  const tf = s.match(/^(tour|explore|to|tor|the|two|door|store|tore) (?:the )?figure (\w+)$/);
  const tfn = tf && num(tf[2]);
  if (tf && tfn && (c.mode === "article" || c.mode === "video") && (tf[1] === "tour" || tf[1] === "explore" || onFigure)) return { name: "tour", args: { figure: tfn } };
  const cnt = word ? undefined : counted(go);
  const openPos = s.match(/^(?:open|choose|pick|select|read) (.+)$/);
  const pos = word || cnt ? undefined : position(go);
  const opened = openPos ? position(openPos[1]) : undefined;
  if (!word && !cnt && pos === undefined && opened === undefined && !(c.pendingOffer && s === "go")) return null;

  const fresh = c.pendingOffer && (c.now ?? Date.now()) - c.pendingOffer.at <= OFFER_MS ? c.pendingOffer : undefined;
  // An offer ("Say tour to explore it.") is accepted by yes and by the words it asked for.
  if (fresh && (word === "yes" || word === "tour" || word === "this" || s === "start" || s === "go" || s === "go ahead")) return { name: fresh.name, args: fresh.args, say: fresh.say };
  if (word === "yes") return fresh ? { name: fresh.name, args: fresh.args, say: fresh.say } : { name: "none", say: "There is nothing waiting for a yes. Say help for what you can do." };
  if (word === "no") return { name: "none", say: "Okay." };
  if (word === "stop") return { name: "stop" };
  if (word === "help") return { name: "none", say: HELP[c.mode] };
  if (word === "where") return { name: "none", say: where(c) };
  if (word === "louder") return { name: "none", say: "Use your computer's volume keys to make me louder." };
  if (word === "faster" || word === "slower") return c.mode === "landing" || c.mode === "tour" ? { name: "none", say: `Say ${word} while reading a page.` } : { name: word };

  if (c.mode === "landing") return word && !NAV.has(word) ? null : { name: "none", say: LANDING_LINE };

  const last = Math.max(c.total - 1, 0);
  const here = Math.max(c.index, 0);
  const move = cnt?.word ?? (word === "next" || word === "prev" ? word : undefined);
  const steps = cnt?.steps;

  if (c.mode === "tour") {
    if (move) return steps ? { name: move, steps } : { name: move };
    if (word === "again" || word === "more") return { name: "read" };
    if (word === "leave") return { name: "leave" };
    if (word === "open" || word === "tour" || word === "this") return { name: "none", say: "You are in the tour. Say next, or leave." };
    if (word === "nextFigure" || word === "prevFigure" || word === "nextHeading" || word === "prevHeading") return { name: "none", say: "Say leave first, then ask again." };
    return null;
  }

  if (move) return steps ? { name: move, steps } : { name: move };
  if (word === "again") return { name: "read" };
  if (word === "top") return { name: "goto", args: { at: 0 } };
  if (word === "end") return { name: "goto", args: { at: last } };
  if (word === "goback") return c.canGoBack ? { name: "return" } : { name: "none", say: "There is nowhere to go back to yet." };
  if (word === "nextFigure" || word === "prevFigure" || word === "nextHeading" || word === "prevHeading") return c.mode === "results" ? null : { name: word };

  if (c.mode === "results") {
    if (opened !== undefined) return { name: "open", args: { at: opened === "last" ? last : Math.min(opened, last) } };
    if (pos !== undefined) return { name: "goto", args: { at: pos === "last" ? last : Math.min(pos, last) } };
    if (word === "open") return { name: "open", args: { at: here } };
    if (word === "more") return { name: "read" };
    if (word === "leave") return { name: "leave" };
    return null; // tour, this: Snap decides
  }

  // article or video
  if (word === "more") return { name: "continue" };
  if (word === "tour" || ((word === "this" || word === "open") && onFigure)) return { name: "tour" };
  if (pos === "last") return { name: "goto", args: { at: last } };
  if (pos === 0 && /^(?:the )?first$/.test(go)) return { name: "goto", args: { at: 0 } };
  return null; // open on a section, "this", "leave", other ordinals: Snap and Gemini decide
}
