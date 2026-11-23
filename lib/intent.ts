// Local grammar for the one- and two-word requests a blind student actually says ("next", "next next", "that one",
// "again", "where am i"). Pure, no DOM, 0 ms. Called first by submitUtterance in lib/client/command.ts (typed and
// spoken); null means "not one of these" and the Decision/Gemini path runs as before. Checked by scripts/checks/intent.ts.
//
// Only a WHOLE short utterance (at most five words after filler is removed) resolves: "what comes next in the
// experiment" is a question and goes on to Decision and Gemini.
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
// | go back, return             | nothing open   | the place before the last jump, else the previous stop | same     | -                    |
// | page 4, next page, previous | -              | a PDF: that page (next, previous)| -                      | -                    |
// | open a file, upload a PDF   | the file chooser, in every mode                                                   |
// | show the original page      | -              | a web page: the live page beside the text | -               | -                    |
// | yes / no                    | runs or clears an offer made in the last 20 s (for example "Say tour to explore it.")   |
// | stop, faster, slower, where am i, help: everywhere, worded for the mode                                           |
// | section 3.2, three point two, appendix B, chapter 4, subsection 2 | article: that heading, by its number (or by position when the headings have none) |
// | next / previous section, next / previous subsection, first subsection, up | article: by heading level (lib/outline.ts)              |
// | contents, outline, what is in this section | article: the headings spoken as a list; "the second one" then picks from it        |

import { byName, contents, figureByWords, figureRef, findRef, findText, inside, ordinal, parseRef, path, relate, topicWords, topLevel, type Entry, type Found, type Unit } from "./outline";
import { HELPER_LINE, SPEED_KEYS, tourOffer, type Style } from "./keys";

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
  paged?: boolean; // a PDF: "page 4", "next page"
  label?: string; // current item heading (in a tour: the figure)
  title?: string; // page title
  stop?: string; // in a tour: "stop 2 of 6: right thigh"
  now?: number;
  outline?: Entry[]; // article: the page's headings with their levels and numbering (lib/outline.ts)
  para?: { at: number; of: number }; // article: the paragraph the cursor is on, among those of its section
  list?: { entries: Entry[]; at: number }; // headings Arc just spoke as a list: "the second one" picks from it
  units?: Unit[]; // article: the blocks and captions, for "find" and for a bare word that is on the page
  page?: number; // a PDF: the page the cursor is on
  pages?: number; // a PDF: its page count
  read?: { total: number; left: number }; // words in the document and after the cursor (a PDF: extrapolated to all its pages)
  rate?: number; // the reading speed
  next?: string; // the label of the item after the cursor
  counts?: { sections: number; figures: number };
  lastFigure?: string; // id of the figure the student was last on
  how?: Style; // how the student has been acting lately: prompts name keys only to someone using keys (undefined: keys, as before)
  results?: string[]; // results: each one's label, "Result 1: title (host)", for "the OpenStax one"
  tourStops?: number; // in a tour: how many stops it has
  blocks?: number[]; // article: how many paragraphs each item has, for "two paragraphs on"
  pageOf?: Record<string, number>; // a PDF: the page each outline entry is on, by id, for "which page does the Attention section start on"
  whole?: boolean; // a PDF: the outline covers the whole document (lib/outline.ts withToc), not only the pages read so far
  thread?: { q: string; a: string; at: number }; // Arc's last turn was this answer (or question back) from the question session
  behind?: string; // results: the title of the page they were searched from; a page: the results it was opened from
  findAt?: number; // when the last find landed: "next one" then means the next match
}
export const THREAD_MS = 90_000; // a reply to Arc's answer or question comes within this
/** Arc's last turn was an answer or a question, and nothing was read since: the next words are first a reply to it. */
export const inThread = (c: Ctx) => !!c.thread && (c.now ?? Date.now()) - c.thread.at < THREAD_MS;
export interface Resolved {
  name: string; // an arc:command name, or "none" (only speak `say`)
  args?: Record<string, unknown>;
  steps?: number;
  say?: string;
  list?: Entry[]; // headings this line listed; the next "the second one" resolves against them
  offer?: Omit<Offer, "at">; // what a following "yes" does ("Do you want me to search for ...? Say yes.")
}

export const OFFER_MS = 20_000;
export const LIST_MS = 30_000; // how long "the second one" refers to a list Arc just spoke
const MAX_WORDS = 5;
export const LANDING_LINE = "Nothing is open yet. Say what you want to study, or paste a link.";
// A stop with nothing open still stops Arc's own voices, and one word says it was heard (a silent start page reads as "not heard").
const halt = (c: Ctx): Resolved => (c.mode === "landing" ? { name: "stop", say: "Okay." } : { name: "stop" });
export const PAGES_ONLY = "I know the sections only for the pages I have read so far. Say page and a number to go further.";
export const NOT_CAUGHT_LINE = "Sorry, I didn't catch that. Could you say it again?";

/** Help by voice, for a student who has only been talking: no key is named. */
function voiceHelp(c: Ctx): string {
  if (c.mode === "landing") return "Say what you want to study, for example: photosynthesis for biology. Or say open the example paper. I read pages to you, and you can ask me anything about them. Say stop to make me quiet.";
  if (c.mode === "tour") return "You are in a picture tour. Say that's enough to leave it. It goes through the parts by itself: say hold on to pause it and go on to carry on. Say next or back to move yourself, and again to hear one again. You can also ask me about the picture.";
  if (c.mode === "results") return `These are search results. Say open and a number, for example open the first one. Say more to hear more of them, or say a new topic to search again.${c.behind ? " Say go back to return to your page." : ""}`;
  if (c.mode === "video") return `This is a lecture video. Say play or pause, back ten seconds or skip ahead, next for the next part, faster or slower, or what is on the screen. You can ask me anything about the lecture.${c.behind ? " Say go back to the results to leave it." : ""}`;
  if (c.onKind === "figure") return "You are on a picture. Say tour to explore it, or go on to keep reading. You can ask me anything about it.";
  const pdf = c.paged ? " Say page and a number to jump to a page." : "";
  return `Say read, and I read on until you stop me. Say next or go back to move, slower or faster for the speed, where am I, contents, or is there a picture.${pdf} Hold on, or stop, pauses me. You can also ask me any question about the page.${c.behind ? " Say go back to the results to leave this page." : ""}`;
}

/** Two or three things to say next, for where the student is: the end of every "I'm not sure" line. */
export function suggest(c: Ctx): string {
  if (c.mode === "landing") return "You can say what you want to study, for example photosynthesis, or say open the example paper.";
  if (c.mode === "results") return "You can say open the first one, say more, or say a new topic to search for.";
  if (c.mode === "tour") return "You can say next, back, again, or that's enough. Or ask me about the picture.";
  if (c.mode === "video") return "You can say play, next, or ask me a question about the lecture.";
  if (c.onKind === "figure") return "You can say tour, go on, or ask me a question about the picture.";
  return "You can say read, next section, where am I, or ask me a question about the page.";
}
/** A request Arc did not understand: no echo of what was heard, then what could be said. */
export const notUnderstood = (c: Ctx) => `I'm not sure what you meant. ${suggest(c)}`;

/** Help for where the student is: three to five short sentences. `more`: the fuller list, in groups. */
export function help(c: Ctx, more = false): string {
  // A tour, said both ways: the same steps, by voice and by key, so the two never disagree.
  if (c.mode === "tour" && c.how === "both" && !more) return "You are in a picture tour. Say that's enough, or press Escape, to leave it. It plays by itself: say hold on, or press P, to pause, and go on to carry on. Say next or back, or use the Right and Left Arrows, to move yourself. You can also ask me about the picture.";
  if (c.how === "voice" || (c.how === "both" && !more)) return voiceHelp(c) + (c.how === "both" ? " With the keyboard, press question mark for the keys." : "");
  if (more) {
    if (c.mode === "landing")
      return "Opening: paste a link and press Enter, or say open the example paper, open the video, or open a PDF file. Searching: say what you want to study, for example photosynthesis for biology. Reading speed: say slower, faster or normal speed once a page is open. Escape or stop makes me quiet.";
    if (c.mode === "tour") return `In a tour: it plays by itself until you press a key. Right or Down Arrow is the next stop, Left or Up the previous one, Enter repeats it. P pauses and resumes. ${SPEED_KEYS} changes the speed. Hold Space to ask about the part you are on. Escape leaves the tour.`;
    if (c.mode === "results") return "In results: Down arrow reads the next result. Say open the first one, or press Enter on the one you want. Say leave to go back to your page. Say a new topic to search again.";
    const pdf = c.paged ? " Pages: page 4, next page, previous page, what page am I on." : "";
    return `Moving: next, back, next section, section 2.1, go to and a section name, figure 3, top, end, go back.${pdf} Finding: find and a word, then next match. Where you are: where am I, how much is left, what comes next, contents, read the title. Reading: again, slower, faster, normal speed, stop. Questions: hold Space and ask anything about the page.`;
  }
  const tail = " Escape stops me. Say more help for the full list.";
  if (c.mode === "landing") return `Paste a link and press Enter, or hold Space and say what you want to study. You can also say open the example paper. Press slash to type.${tail}`;
  if (c.mode === "tour") return "You are in a figure tour. Escape leaves the tour. It plays by itself; P pauses. Right or Down Arrow is the next stop, Left or Up goes back, Enter repeats. Hold Space to ask about this part.";
  if (c.mode === "results") return `These are search results. Down arrow reads the next one. Press Enter on one, or a number key, to open it. Escape goes back${c.behind ? " to your page" : ""}.${tail}`;
  if (c.mode === "video") return `This is a lecture video. K, P or a tap of Space plays and pauses, J and L go back and forward ten seconds, and less-than and greater-than change its speed. Down and Up move between parts, and V switches between its sound and my reading. Hold Space to ask a question.${tail}`;
  if (c.onKind === "figure") return `You are on a figure. Press Enter or say tour to explore it. Down arrow moves on, Up goes back. Hold Space to ask about it.${tail}`;
  if (c.paged) return `Down arrow reads the next part, Up goes back. Say page and a number to jump there, or next page. Hold Space and say what you want: go to results, find a word, or ask a question.${tail}`;
  return `Down arrow reads the next part, Up goes back. H jumps by heading. Hold Space and say what you want: go to results, find a word, or ask a question.${tail}`;
}

const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const ORD: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5, "6th": 6, "7th": 7, "8th": 8, "9th": 9, "10th": 10,
};
// Mishearings that can only mean one thing.
const MISHEARD: Record<string, string> = { necks: "next", nex: "next", nexts: "next", neckst: "next", bak: "back", stahp: "stop", stopp: "stop", agin: "again", agan: "again" };

type Word =
  | "next" | "prev" | "again" | "more" | "stop" | "open" | "tour" | "picture" | "this" | "leave" | "yes" | "no" | "faster" | "slower"
  | "louder" | "where" | "help" | "top" | "end" | "goback" | "nextFigure" | "prevFigure" | "nextHeading" | "prevHeading";

const PHRASES: Record<Word, string[]> = {
  next: ["next", "forward", "skip", "next one", "the next", "the next one", "go the next one", "go next one", "next 1", "skip this", "skip it", "skip this part", "skip that", "move on", "next bit", "onward", "next paragraph", "down", "move down"],
  prev: ["back", "previous", "prev", "before", "backward", "backwards", "previous one", "go previous", "one back", "back up", "previous paragraph", "up", "move up", "go back a bit", "back a bit", "go back a little", "back a little", "the bit before", "the part before", "a bit back", "the bit before that", "go back one"],
  again: ["again", "repeat", "say that again", "say again", "repeat that", "what", "pardon", "come again", "once more", "sorry what", "what was that", "replay", "replay that", "replay it", "one more time", "say it again", "read it again", "read that again", "read this again", "read the paragraph again", "read the section again"],
  more: [
    "more", "go on", "read it", "read this", "read more", "tell me more", "keep reading", "read on", "read that", "continue", "keep going", "carry on",
    "read", "read it to me", "read to me", "read this to me", "start reading", "begin", "begin reading", "resume", "go on reading", "keep on reading",
    "continue reading", "carry on reading", "read the rest", "read all of it", "read it all", "read everything", "read aloud", "read it aloud", "read it out",
    "you can go on", "go on then", "on you go", "read the whole thing", "read the whole page", "read the whole chapter", "read the whole article",
    "read the chapter", "read the page", "read me the page", "read me the chapter", "read the text", "read the rest of it", "keep reading please",
  ],
  stop: [
    "stop", "quiet", "pause", "shh", "shhh", "shush", "hush", "be quiet", "silence", "enough", "stop talking", "stop reading", "shut up", "stop it", "stop stop",
    "that's enough", "thats enough", "pause it", "pause reading", "hold on", "wait", "hang on", "quiet down", "stop that", "one moment", "just a moment",
    "a moment", "one second", "one sec", "just a second", "just a minute", "wait a moment", "wait a second", "wait a minute", "hold on a moment",
    "hold on a second", "hang on a minute", "hang on a second", "give me a moment", "give me a second", "give me a minute", "enough now", "stop stop stop",
  ],
  open: ["open", "open it", "open this", "open that", "that one", "this one", "go there", "select", "choose", "pick", "open this one", "open that one", "pick this", "pick that", "choose this", "this page", "that page", "open this page"],
  picture: ["picture", "show me the picture", "show the picture", "get the picture", "show me the image", "show me the chart", "show me the graph", "what does it look like"],
  tour: ["tour", "tour this", "tour it", "explore", "explore this", "explore it", "start the tour", "tour this figure", "explore this figure", "explore the figure", "tour the figure", "start tour"],
  this: ["this", "that", "this figure", "that figure"],
  leave: ["leave", "exit", "done", "close", "out", "get out", "leave the tour", "exit the tour", "end the tour", "quit", "i'm done", "im done", "leave tour", "exit tour", "close it", "back to the page"],
  yes: ["yes", "yeah", "yep", "yup", "ok", "okay", "sure", "do it", "go ahead", "please do", "alright", "all right", "yes please", "yeah sure", "sure thing"],
  no: ["no", "nope", "cancel", "never mind", "nevermind", "no thanks", "not now", "no thank you", "don't", "dont"],
  faster: ["faster", "speed up", "quicker", "more quickly", "read faster", "talk faster", "a bit faster", "much faster", "a lot faster", "way faster", "speed up a lot"],
  slower: ["slower", "slow down", "more slowly", "read slower", "talk slower", "a bit slower", "normal speed", "normal", "regular speed", "speed one", "much slower", "a lot slower", "way slower", "slow down a lot", "back to normal speed", "normal speed again"],
  louder: ["louder", "speak up", "volume up", "turn it up"],
  where: ["where am i", "where", "where are we", "where am i now", "where is this", "where are we now", "where am i in the paper", "where am i in the page", "where am i in the document", "where am i in this", "where am i on the page", "where was i"],
  help: ["what can i say to you", "what are my options", "what are my choices", "i don't know what to do", "i dont know what to do", "i do not know what to do", "what should i say", "what should i do", "what do i say", "what can you do for me", "what can i do", "help", "options", "what can i say", "commands", "help me", "what now", "what do i do", "what can you do", "how does this work", "how does it work", "how do i use this", "how do i use it", "instructions", "what are the commands", "i need help", "i'm lost", "im lost", "i am lost", "how do i do this", "what do i do now", "what can i ask", "what can you help with", "who are you", "what are you"],
  top: ["start", "top", "beginning", "start over", "the top", "the beginning", "from the top", "back to the top", "back to the start", "restart"],
  end: ["end", "bottom", "the end", "the bottom", "to the end", "to the bottom"],
  goback: ["go back", "return", "take me back", "go back to where i was", "back to where i was", "where i was", "go back there", "go back to the other part", "back to the other part", "the other part", "go back to that part", "back to that part", "go back to the last part", "go back to where i was before", "back where i was", "go back to the part before", "take me back there", "the place before"],
  nextFigure: ["next figure", "the next figure", "next image", "next picture", "next chart", "next graph", "next diagram"],
  prevFigure: ["previous figure", "the previous figure", "figure before", "previous image", "previous picture", "previous chart"],
  nextHeading: ["next heading", "next section", "the next section", "next part", "next chapter", "skip this section", "skip section", "skip the section", "skip to the next section"],
  prevHeading: ["previous heading", "previous section", "the previous section", "previous part", "section before"],
};
// Whole-utterance mishearings from real voices in a noisy room. Used only when the utterance is exactly one of these,
// and tour and leave ones only where the real word makes sense (on a figure; in a tour or a result list).
const MISHEARD_PHRASES: Partial<Record<Word, string[]>> = {
  next: ["text", "nest", "necks", "nex", "next to", "neck's"],
  prev: ["pack", "bach", "beck"],
  stop: ["stab", "stob"], // measured: a synthetic "stop" is heard as "Stab" by both live transcribers
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

/** "two", "number two", "result 3": 0-based, else undefined. */
const numbered1 = (w: string) => {
  const n = num(w.replace(/^(?:the )?(?:number|result) /, ""));
  return n && n >= 1 ? n - 1 : undefined;
};

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

// "Say that again", "pardon": the last sentence heard (lib/client: Reader), not the whole block; "sentence" in it: the page's.
const SENTENCE = new Set(["say that again", "say again", "say it again", "pardon", "pardon me", "what", "what was that", "sorry what", "come again", "repeat that", "once more", "one more time", "sorry", "what did you say", "say that once more"]);
const sentence = (s: string): Resolved => ({ name: "read", args: { sentence: true, ...(/\b(?:sentence|line)\b/.test(s) ? { page: true } : {}) } });
const SKIPS = new Set(["skip", "skip this", "skip it", "skip this part", "skip that", "move on", "next bit"]);
// In a tour: the words that start it or go on, and the ones that leave it.
const TOUR_GO = new Set(["go on", "carry on", "continue", "keep going", "resume", "keep playing", "carry on playing"]); // resumes the self-running tour
const TOUR_ON = new Set(["start", "begin", "go ahead", "start the tour", "begin the tour", "first stop", "the first stop", "next stop", "the next stop", "next part", "the next part", "next one"]);
const TOUR_LEAVE = new Set(["that's enough", "thats enough", "that is enough", "enough", "enough now", "that will do", "that'll do", "stop the tour", "i'm finished", "im finished", "finished", "back to the reading", "back to reading", "no more", "no more picture", "no more pictures", "get me out", "take me out", "let me out"]);
const RESULTS_MORE = new Set([
  "more", "more results", "read more", "tell me more", "the next ones", "next ones", "the next three", "next three", "more please", "any more", "what else", "what else is there", "keep going", "go on", "carry on", "continue",
  "the others", "others", "the other ones", "other ones", "the other results", "other results", "the rest", "the rest of them", "the rest of the results", "the next few", "next few", "the next results", "next results", "some more", "more of them", "the remaining ones", "the remaining results", "more results please",
]);

const FIND_MS = 60_000; // after a find, "next one" is its next match for this long
const FIND_NEXT = /^(?:(?:the )?next(?: one)?|another(?: one)?|(?:the )?(?:previous|one before|last) one|go to the next one|the next please)$/;
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
// A lecture video: what is on the screen, ten seconds back or ahead (the J and L keys), play and pause (P or K).
const SCREEN = /^(?:what(?:'s| is) (?:on (?:the )?screen|on the slide|she pointing at|he pointing at|the (?:teacher|lecturer|professor) pointing at|being shown)(?: right now| right| now)?|describe (?:the|what'?s on the) (?:screen|slide)|what does (?:it|the slide|the screen) show(?: now)?|what am i looking at)$/;
const SEEK = /^(?:(?:go |skip |jump )?back|rewind|skip ahead|skip forward|jump ahead|go forward|forward|fast forward)(?: (?:ten|10) seconds| a bit| a little)?$/;
const PLAY = new Set(["play", "play it", "play the video", "resume", "resume the video", "start the video", "play the lecture", "carry on playing", "keep playing", "unpause"]);
const PAUSE = new Set(["pause", "pause it", "pause the video", "stop the video", "pause the lecture"]); // stop: the video and both voices

const DISPLAY_PHRASES: Record<string, string> = {
  "i am blind": "voice-first", "i'm blind": "voice-first", "im blind": "voice-first", "i cannot see": "voice-first", "i can't see": "voice-first",
  "i cant see": "voice-first", "i can't see the screen": "voice-first", "i cannot see the screen": "voice-first", "i cant see the screen": "voice-first",
  "blind mode": "voice-first", "voice first": "voice-first", "turn on voice first": "voice-first",
  "turn off voice first": "voice-first-off", "voice first off": "voice-first-off",
  "reset display": "reset", "reset the display": "reset",
};

// The prepared examples the landing screen links to (components/Landing.tsx); only said on the landing.
const PAPER = "https://www.mdpi.com/1424-8220/24/6/1935";
const VIDEO = "https://www.youtube.com/watch?v=4JqH55rLGKY"; // Khan Academy, Reading pie graphs: the lecture the start page shows
const TEXTBOOK = "https://openstax.org/books/anatomy-and-physiology-2e/pages/17-9-the-endocrine-pancreas";
const EXAMPLES: Record<string, string> = {
  "open the paper": PAPER, "open a paper": PAPER, "open the research paper": PAPER, "open a research paper": PAPER,
  example: PAPER, "an example": PAPER, "open the example paper": PAPER, "the example paper": PAPER, "example paper": PAPER, "show me an example": PAPER, "open an example": PAPER, "open the example": PAPER,
  "open the video": VIDEO, "open a video": VIDEO, "open the video outline": VIDEO,
  "open the textbook": TEXTBOOK, "open a textbook": TEXTBOOK, "open the textbook chapter": TEXTBOOK,
};

const UPLOAD = new Set(["open a file", "open file", "upload a file", "upload file", "upload a pdf", "upload pdf", "open a pdf", "open pdf", "choose a file", "choose a pdf", "open my file", "open my pdf", "upload"]);
const ORIGINAL = new Set(["show the original page", "show original page", "show the original", "show the live page", "open the original page"]);

const SECTION_NEXT = new Set(["next section", "the next section", "skip this section", "skip section", "skip the section", "skip to the next section", "next part", "next chapter", "next sections"]);
const SECTION_PREV = new Set(["previous section", "the previous section", "previous part", "section before", "go to the previous section", "go to previous section"]);
const SUB_NEXT = new Set(["next subsection", "the next subsection", "next sub section", "skip this subsection", "skip subsection", "next subsections"]);
const SUB_PREV = new Set(["previous subsection", "the previous subsection", "previous sub section", "go to the previous subsection"]);
const SUB_FIRST = new Set(["first subsection", "the first subsection", "first sub section", "go to the first subsection"]);
const UP = new Set(["up", "go up", "parent", "parent section", "the parent section", "go to the parent section", "go to parent section", "up one level", "go up one level", "up a level", "go up a level", "section above", "the section above"]);
const CONTENTS = new Set(["contents", "table of contents", "the contents", "outline", "the outline", "show the outline", "read the outline", "what sections are there", "what are the sections", "list the sections", "list sections", "sections", "show contents", "what is the outline", "whats the outline"]);
const INSIDE = new Set(["what is in this section", "what's in this section", "whats in this section", "what is in this section here", "subsections", "list the subsections", "what subsections are there", "what are the subsections", "what subsections", "what is in here", "what's in here"]);

/** "Where am I" on a figure: the place first (its number and the section it sits in), then the offer, never its description. */
export function figureWhere(o: Entry[], c: Ctx): string {
  const fig = o.find((e) => e.i === c.index);
  const name = fig?.label.match(/^\s*(?:figure|fig\.?|table|scheme|chart)\s*[\w.]+/i)?.[0].trim().replace(/^fig\.?\s*(?=\d)/i, "Figure ").replace(/\.$/, "") ?? "A figure";
  const sec = [...o].reverse().find((e) => e.kind === "section" && e.i < c.index && (!c.title || e.label !== c.title));
  const inSec = sec ? path(o, sec.i) : undefined;
  return `${name}${inSec ? `, in ${inSec}` : "."} ${tourOffer(c.how ?? "both")}`;
}

/** Moving around the headings, by number or by relation, and hearing them listed. Article pages with headings only. */
function outlineLocal(utterance: string, s: string, c: Ctx): Resolved | null {
  const o = c.outline!;
  const out = (f: Found): Resolved => ("id" in f ? { name: "goto", args: { id: f.id } } : { name: "none", say: f.say, ...(f.list ? { list: f.list } : {}) });
  const part = c.paged && !c.whole; // a PDF whose sections are known only for the pages read so far
  if (c.list && (c.now ?? Date.now()) - c.list.at <= LIST_MS) {
    // "more" right after contents: the subsections too.
    if (/^(?:more|say more|tell me more|the subsections|subsections|more sections|all of them|the rest)$/.test(s) && c.list.entries.every((e) => e.level === topLevel(o))) return out(contents(o, true));
    const e = ordinal(utterance, c.list.entries);
    if (e) return out({ id: e.id });
  }
  const ref = parseRef(utterance);
  if (ref) {
    const f = findRef(o, ref, c.index);
    return out(part && "say" in f && !f.list ? { say: PAGES_ONLY } : f);
  }
  if (SECTION_NEXT.has(s)) {
    const f = relate(o, c.index, "nextSection");
    return out(part && "say" in f ? { say: PAGES_ONLY } : f);
  }
  if (SECTION_PREV.has(s)) return out(relate(o, c.index, "prevSection"));
  if (SUB_NEXT.has(s)) return out(relate(o, c.index, "nextSub"));
  if (SUB_PREV.has(s)) return out(relate(o, c.index, "prevSub"));
  if (SUB_FIRST.has(s)) return out(relate(o, c.index, "firstSub"));
  if (UP.has(s)) return out(relate(o, c.index, "up"));
  if (CONTENTS.has(s)) {
    const f = contents(o);
    return out(part && "say" in f ? { ...f, say: `${f.say} ${PAGES_ONLY}` } : f);
  }
  if (INSIDE.has(s)) return out(inside(o, c.index));
  if (LOOKUP.get(s) === "where") {
    if (c.onKind === "figure") return { name: "none", say: figureWhere(o, c) };
    const p = path(o, c.index, c.para);
    if (p) return { name: "none", say: p };
  }
  return null;
}

// Words that do not name a source: "open the OpenStax one my teacher uses" leaves only "openstax".
const SOURCE_STOP = new Set("open the one ones from that this my teacher teachers uses use used please i want like page site website result link choose pick select go to with on by a an of read".split(" "));
/** The site a name like "the OpenStax one" points to: the one-word name of each result's host ("openstax" of openstax.org). */
export const siteWord = (host: string) => {
  const parts = host.replace(/^www\./, "").split(".");
  return (parts.length > 2 && parts[parts.length - 2].length <= 3 ? parts[parts.length - 3] : parts[parts.length - 2] ?? parts[0]).toLowerCase();
};
/** The result whose site the words name, and nothing else ("the openstax one", "open the one from wikipedia"), else -1. */
export function bySource(s: string, labels: string[]): number {
  const w = s.split(" ").filter((x) => x && !SOURCE_STOP.has(x));
  if (!w.length || w.length > 3) return -1;
  const said = w.join("");
  return labels.findIndex((l) => {
    const host = l.match(/\(([^()]+)\)\s*$/)?.[1];
    const site = host ? siteWord(host) : "";
    return site.length >= 3 && (said === site || (said.length >= 5 && site.startsWith(said)));
  });
}

/** The whole utterance as a command for this context, or null to let Decision and Gemini decide. */
function core(utterance: string, s: string, c: Ctx): Resolved | null {
  if (c.mode === "article" && c.outline?.length && s && s.split(" ").length <= 8) {
    const r = outlineLocal(utterance, s, c);
    if (r) return r;
  }
  if (c.mode === "video" && s) {
    if (SCREEN.test(s)) return { name: "screen" }; // components/VideoPlayer.tsx answers from the on-screen descriptions, no model
    const sk = s.match(SEEK);
    if (sk) return { name: "seek", args: { by: /^(?:go |skip |jump )?back|rewind/.test(s) ? -10 : 10 } };
    if (PLAY.has(s)) return { name: "play" };
    if (PAUSE.has(s)) return { name: "stop" };
    if (/^(?:(?:can|could) you )?read (?:it|the lecture|the video|me the lecture)(?: to me| aloud| instead)*$/.test(polite(s))) return { name: "readLecture" };
  }
  if (c.mode === "article" && c.findAt && (c.now ?? Date.now()) - c.findAt < FIND_MS && FIND_NEXT.test(s)) return { name: "findNext", args: { by: /previous|before|last/.test(s) ? -1 : 1 } };
  if (c.mode === "results" && s && RESULTS_MORE.has(s.replace(/^(?:read |say |give me |tell me )?(?:me )?/, ""))) return { name: "moreResults" };
  if (c.mode === "results" && c.results?.length && s) {
    const about = s.match(/^(?:open )?the (?:one|result|page|paper) (?:about|on|with) (.+)$/);
    const w = about ? topicWords(about[1]) : [];
    const hits = w.length ? c.results.flatMap((l, i) => (w.every((x) => topicWords(l).includes(x)) ? [i] : [])) : [];
    if (hits.length === 1) return { name: "open", args: { at: hits[0] } };
    const k = bySource(s, c.results); // "the OpenStax one my teacher uses": any length, only the site's name left
    if (k >= 0) return { name: "open", args: { at: k } };
  }
  if (!s || (s.split(" ").length > MAX_WORDS && !LOOKUP.has(s))) return null; // a listed phrase may be longer
  if (DISPLAY_PHRASES[s]) return { name: "display", args: { setting: DISPLAY_PHRASES[s] } };
  if (UPLOAD.has(s)) return { name: "upload" };
  if (c.mode === "landing" && EXAMPLES[s]) return { name: "open", args: { url: EXAMPLES[s] } };
  if (c.mode === "article" && ORIGINAL.has(s)) return { name: "original" };
  const pg = c.mode === "article" && c.paged ? s.match(/^(?:(?:go|turn) to )?page (\w+)$/) : null; // "go to page 40", "page 40"
  if (pg && num(pg[1])) return { name: "page", args: { n: num(pg[1]) } };
  // A PDF turns its pages; a web page follows its own next and previous links (components/Twin.tsx, twin.links).
  if (c.mode === "article" && /^(?:go to )?(?:the )?(?:next|previous) page$/.test(s)) return { name: "page", args: { by: /next/.test(s) ? 1 : -1 } };
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
  // In results "open two" and "open number two" too (a bare "two" stays unclear).
  const opened = openPos ? (position(openPos[1]) ?? (c.mode === "results" ? numbered1(openPos[1]) : undefined)) : undefined;
  if (c.mode === "tour") {
    if (TOUR_LEAVE.has(s)) return { name: "leave" };
    if (/^(?:go to )?(?:the )?first (?:stop|one|part)$/.test(s)) return { name: "goto", args: { at: 0 } };
    if (TOUR_GO.has(s)) return { name: "continue" };
    if (TOUR_ON.has(s)) return { name: "next" };
    if (word === "end" || /^(?:skip )?to the end$|^(?:go to )?(?:the )?last (?:stop|one|part)$/.test(s)) return { name: "goto", args: { at: "last" } };
  }
  if (!word && !cnt && pos === undefined && opened === undefined && !(c.pendingOffer && s === "go")) return null;

  const fresh = c.pendingOffer && (c.now ?? Date.now()) - c.pendingOffer.at <= OFFER_MS ? c.pendingOffer : undefined;
  // An offer ("Say tour to explore it.") is accepted by yes and by the words it asked for.
  if (fresh && (word === "yes" || word === "tour" || word === "this" || s === "start" || s === "go" || s === "go ahead")) return { name: fresh.name, args: fresh.args, say: fresh.say };
  if ((word === "yes" || word === "no") && !fresh && inThread(c)) return null; // a reply to Arc's own answer or question: the question session has it
  if (word === "yes") return fresh ? { name: fresh.name, args: fresh.args, say: fresh.say } : { name: "none", say: "There is nothing waiting for a yes. Say help for what you can do." };
  if (word === "no") return { name: "none", say: "Okay." };
  if (word === "stop") return halt(c);
  if (word === "help") return { name: "none", say: help(c) };
  if (word === "where") return { name: "none", say: where(c) };
  if (word === "louder") return { name: "none", say: "Use your computer's volume keys to make me louder." };
  if ((word === "faster" || word === "slower") && c.mode === "tour") return { name: word };
  if (word === "faster" || word === "slower") return c.mode === "landing" ? { name: "none", say: `Say ${word} while reading a page.` } : /normal|regular|one/.test(s) ? { name: word, args: { normal: true } } : /much|a lot|way/.test(s) ? { name: word, steps: 3 } : { name: word };

  if (c.mode === "landing") return (word && !NAV.has(word)) || inThread(c) ? null : { name: "none", say: LANDING_LINE };

  const last = Math.max(c.total - 1, 0);
  const here = Math.max(c.index, 0);
  const move = cnt?.word ?? (word === "next" || word === "prev" ? word : undefined);
  const steps = cnt?.steps;

  if (c.mode === "tour") {
    if (move) return steps ? { name: move, steps } : { name: move };
    if (word === "again" || word === "more") return { name: "read" };
    if (word === "leave") return { name: "leave" };
    if (word === "open" || word === "tour" || word === "this") return { name: "none", say: "You are in the tour. Say next, or leave." };
    if ((word === "nextHeading" || word === "prevHeading") && /\bpart\b/.test(s)) return { name: word === "nextHeading" ? "next" : "prev" }; // "the previous part": a stop
    if (word === "nextFigure" || word === "prevFigure" || word === "nextHeading" || word === "prevHeading") return { name: "none", say: "Say leave first, then ask again." };
    return null;
  }

  if (move) return steps ? { name: move, steps } : move === "next" && SKIPS.has(s) ? { name: move, args: { skip: true } } : { name: move };
  if (word === "again") return SENTENCE.has(s) ? sentence(s) : { name: "read" };
  if (word === "top") return { name: "goto", args: { at: 0 } };
  if (word === "end") return { name: "goto", args: { at: last } };
  if (word === "goback") return c.mode === "results" && c.behind ? { name: "leave" } : { name: "return" }; // Reader: back from a jump, else the previous stop; results: back to the page behind
  if (word === "nextFigure" || word === "prevFigure" || word === "nextHeading" || word === "prevHeading") return c.mode === "results" ? null : { name: word };

  if (c.mode === "results") {
    if (opened !== undefined) return { name: "open", args: { at: opened === "last" ? last : Math.min(opened, last) } };
    if (pos !== undefined) return { name: "goto", args: { at: pos === "last" ? last : Math.min(pos, last) } };
    if (word === "open") return { name: "open", args: { at: here } };
    if (RESULTS_MORE.has(s)) return { name: "moreResults" };
    if (word === "more") return { name: "read" };
    if (word === "leave") return { name: "leave" };
    return null; // tour, this: Decision decides
  }

  // article or video
  if (word === "more") return { name: "continue" };
  if (word === "picture") return c.mode === "video" ? { name: "picture" } : onFigure ? { name: "tour" } : null; // a lecture part: fetch its still frame
  if (word === "tour" || ((word === "this" || word === "open") && onFigure)) return { name: "tour" };
  if (pos === "last") return { name: "goto", args: { at: last } };
  if (pos === 0 && /^(?:the )?first$/.test(go)) return { name: "goto", args: { at: 0 } };
  return null; // open on a section, "this", "leave", other ordinals: Decision and Gemini decide
}

// ---- the rules that need no model: filler, help, orientation, broken links, finding words, headings and figures by name ----

const FILLER = /^(?:(?:um+|uh+|er+|erm+|hmm+|hm+|mm+|mhm+|ah+|eh+|huh|oh+|uh huh|ugh)\s*)+$/;
const MORE_HELP = new Set(["more help", "full help", "all commands", "help more", "list commands", "the full list", "full list", "list all commands", "more options", "tell me everything", "what else can i do", "what else can i say", "more"]);

/** A web address that went wrong ("htp:/biology notes week 3", "www.biology notes"): the words to search for, else undefined. */
export function brokenLink(u: string): string | undefined {
  const t = u.trim();
  const m = t.match(/^([a-z]{2,6})\s*[:;]\s*\/+\s*(.*)$/i);
  const w = t.match(/^www\.(.*\s.*)$/i);
  const rest = m && (!/^https?$/i.test(m[1]) || /\s/.test(m[2])) ? m[2] : w ? w[1] : undefined;
  if (rest == null) return undefined;
  return rest.replace(/^www\./i, "").replace(/[/_+=&?#]+/g, " ").replace(/\.(?=\s|$)/g, "").replace(/\s+/g, " ").trim();
}

/** Reads like a question: a question word or verb first, or a question mark. */
export const isQuestion = (u: string) =>
  /\?\s*$/.test(u) || /^(?:what|what's|whats|why|how|who|whom|whose|when|which|is|are|was|were|do|does|did|can|could|should|would|will|has|have|explain|describe|tell me|define|summari[sz]e|compare|give me)\b/i.test(normalise(u));

const minutes = (words: number, rate = 1.25) => {
  const m = Math.round(words / (165 * rate)); // measured: the reading voice is about 165 words a minute at 1x
  return m < 1 ? "less than a minute" : m === 1 ? "about a minute" : `about ${m} minutes`;
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// "How much is left", said any natural way: "how much more is there", "how many sections are left", "is there much left".
const LEFT =
  /^how much (?:is )?(?:left|more|longer|is there left|to go)$|^how much of (?:this|it) is left$|^how far (?:am i|along am i|in am i)$|^how much (?:have i|did i) read$|^am i nearly done$|^(?:so )?how (?:much|many|long|far)\b.*\b(?:left|remaining|to go|to read|longer|further|more (?:is there|to go|to read|have i got|do i have|is left)|more of (?:it|this|the \w+)|till the end|until the end|to the end)(?: (?:in|of|on) (?:this|the) (?:page|paper|article|document|chapter|text))?$|^(?:is there|have i got|do i have) (?:much|a lot|lots|long) (?:more|left|to go)(?: to read)?$|^(?:are we|am i) (?:nearly|almost) (?:done|there|finished|at the end)$/;
/** "what page am I on", "how many pages", "how long is this", "how much is left", "what section is this", "what comes next", "read the title". */
function orient(s: string, c: Ctx): Resolved | null {
  const say = (line: string): Resolved => ({ name: "none", say: line });
  const doc = c.mode === "article" || c.mode === "video";
  if (/^(?:read|say|tell me|what is|what's|whats) (?:me )?the title$|^(?:the )?title$|^what is (?:this|the) (?:page|paper|document|article|video) called$|^what am i reading$|^what is this (?:page|paper|document)$/.test(s))
    return say(c.mode === "landing" ? LANDING_LINE : `The title is ${c.title || "not given"}.`);
  if (/^(?:what|which) page (?:am i on|is this|are we on|am i at|am i)$|^(?:what|which) page$|^what page number(?: is this)?$/.test(s)) {
    if (c.mode === "landing") return say(LANDING_LINE);
    return say(c.paged ? (c.page ? `Page ${c.page} of ${c.pages}.` : `This PDF has ${c.pages} pages. ${c.how === "keys" ? "Press Down" : "Say read"} to start on page 1.`) : "This is a web page, not split into numbered pages. Say where am I to hear the section.");
  }
  if (/^how many pages(?: (?:are there|is it|is this|does it have|does this have|in this|in total|are in this))?$/.test(s)) {
    if (c.mode === "landing") return say(LANDING_LINE);
    return say(c.paged ? `${plural(c.pages ?? 0, "page")}.${c.page ? ` You are on page ${c.page}.` : ""}` : `This web page is one long page, with ${plural(c.counts?.sections ?? 0, "section")} and ${plural(c.counts?.figures ?? 0, "figure")}.`);
  }
  if (/^how long(?: is (?:this|it|the page|this page|the paper|this paper|the document|this document|the article|this article|the video|this video))?$|^how long will (?:this|it) take(?: to read)?$/.test(s)) {
    if (!doc || !c.read) return say(LANDING_LINE);
    const what = c.paged ? `${plural(c.pages ?? 0, "page")}` : `${plural(c.counts?.sections ?? 0, "section")} and ${plural(c.counts?.figures ?? 0, "figure")}`;
    return say(`${what}, ${minutes(c.read.total, c.rate)} of reading at this speed.`);
  }
  if (LEFT.test(s.replace(/^(?:tell me|i wonder|do you know|any idea|i want to know|i'd like to know) /, "").replace(/ (?:is (?:it|this|that|there)|are there|have i got|do i have|have we got|do we have)$/, "")) && !/\babout\b/.test(s)) {
    if (c.mode === "tour") return null; // a tour's own count (canon: stopsLeft)
    if (!doc || !c.read) return say(LANDING_LINE);
    const secs = (c.outline ?? []).filter((e) => e.kind === "section" && e.i > c.index && (!c.title || e.label !== c.title)).length;
    const more = c.paged ? "" : `, ${plural(secs, "section")}`;
    if (c.index < 0) return say(`All of it: ${minutes(c.read.total, c.rate)} of reading${more}. ${c.how === "keys" ? "Press Down to start." : "Say read to start."}`);
    return say(`${minutes(c.read.left, c.rate).replace(/^./, (x) => x.toUpperCase())} left ${c.paged ? "in this document" : "on this page"}${more}${c.paged && c.page ? `, from page ${c.page} of ${c.pages}` : ""}.`);
  }
  if (/^(?:what|which) (?:section|part|chapter|heading) (?:is this|am i in|are we in|is it|am i on)$|^what am i on$/.test(s)) {
    if (!doc) return say(LANDING_LINE);
    const p = c.outline?.length ? path(c.outline, c.index, c.para) : undefined;
    return say(p ?? (c.label ? `${c.label}.` : "At the top. Say next to start."));
  }
  if (/^what(?:'s| is| comes)? next$|^what comes after (?:this|that|here)$|^what follows$|^what is after this$/.test(s)) {
    if (!doc) return say(LANDING_LINE);
    const more = c.para && c.para.at < c.para.of ? `${plural(c.para.of - c.para.at, "more paragraph")} of this section, then ` : "";
    return say(c.next ? `${more ? more.replace(/^./, (x) => x.toUpperCase()) : "Next: "}${c.next}.` : more ? `${more.replace(/^./, (x) => x.toUpperCase()).replace(/, then $/, "")}, and then the end.` : "This is the end of the page.");
  }
  return null;
}

const FIND = /^(?:find|search for|look for|find the words?|search (?:this|the) (?:page|paper|document|pdf) for|look (?:on|in) (?:this|the) (?:page|paper) for|where does (?:it|this|the (?:page|paper|article|document)) (?:mention|say|talk about)|where is the word|is there anything about|does it mention|does (?:this|the) (?:page|paper) mention)\s+(.+?)(?:\s+(?:on|in) (?:this|the) (?:page|paper|document|pdf|article))?$/;
const WEB = /^(?:(?:search|look) (?:the web|online|the internet|google) for|search (?:the web|online|google)|google)\s+(.+)$|^(?:find|search for|look for|look up|get)\s+(?:me\s+)?(?:(?:a|an|some|the|other|more)\s+)?(?:papers?|articles?|pages?|videos?|studies|study material|notes|something|textbooks?|textbook chapters?|chapters?|books?|lectures?|lessons?|websites?|sources?)\s+(?:about|on|for|of)\s+(.+)$/;
const GOTO = /^(?:(?:go|jump|skip|move|navigate|get)(?: back)? to|take me(?: back)? to|bring me(?: back)? to|show me|open|read|let's go to|lets go to|i want to go to|i want|i need)\s+(.+)$/;
const DISPLAYISH = /\b(?:bigger|smaller|larger|contrast|font|colou?rs?|dark|light|bright|brightness|spacing|zoom|text size|motion|focus line|blind)\b/;

// A request that names a section ("section", "the ... part", "called ..."), and the questions about where one is.
const SECTIONY = /\b(?:section|sections|part|chapter|heading|called|named|titled)\b/;
const PAGE_Q = /^(?:on )?(?:which|what) page (?:does|is|do|did) (?:the )?(.+?)(?: (?:start|starts|begin|begins|start on|begin on|on|at|in))?$|^(?:on )?(?:which|what) page (?:has|holds) (?:the )?(.+?)$/;
const WHERE_Q = /^where (?:is|does|do) (?:the )?(.+?)(?: (?:start|starts|begin|begins))?$/;
/** The heading's name alone: "the section called attention" and "the attention section" are both "attention". */
export const sectionName = (x: string) => x.replace(/\b(?:the|a|an|section|sections|part|chapter|heading|called|named|titled|start|starts|begin|begins|on|at)\b/g, " ").replace(/\s+/g, " ").trim();
const plainLabel = (l: string) => l.toLowerCase().replace(/^\s*(?:(?:appendix|chapter|section|part)\s+)?(?:\d{1,3}(?:\.\d{1,3})*|[a-z](?:\.\d{1,3})*)[.:)]?\s+/, "").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
/** The one section whose name is exactly this ("attention": 3.2 Attention, not 3.2.1 Scaled Dot-Product Attention). */
function exactHeading(o: Entry[], name: string): Entry | undefined {
  const hits = o.filter((e) => e.kind === "section" && plainLabel(e.label) === name);
  return hits.length === 1 ? hits[0] : undefined;
}
/** byName, as an entry when one fits, or its question when several do. */
function onlyByName(o: Entry[], name: string): Entry | { say: string; list?: Entry[] } | undefined {
  const f = byName(o, name);
  if (!f) return undefined;
  return "id" in f ? o.find((e) => e.id === f.id) : { say: f.say, list: f.list };
}

/** After the fixed grammar: words a model is not needed for. */
function finders(utterance: string, s: string, c: Ctx): Resolved | null {
  const n = s.split(" ").length;
  // In the article: the other one, that figure
  if (c.mode === "article" && /^(?:the )?other one$|^the other$/.test(s)) {
    const l = c.list && (c.now ?? Date.now()) - c.list.at <= LIST_MS * 4 ? c.list.entries : undefined;
    const curId = c.index >= 0 ? c.outline?.find((e) => e.i === c.index)?.id : undefined;
    if (l?.length === 2) return { name: "goto", args: { id: (l[0].id === curId ? l[1] : l[0]).id } };
    if (c.canGoBack) return { name: "return" };
    return { name: "none", say: "Which one? Say contents to hear the sections, or say a section name." };
  }
  if (c.mode === "article" && /^(?:go (?:back )?to )?(?:that|the last|the previous) (?:figure|picture|image|chart)$/.test(s)) {
    if (c.lastFigure) return { name: "goto", args: { id: c.lastFigure } };
    return { name: "none", say: "Which figure? Say figure and its number." };
  }
  if (c.mode === "article" && /^(?:(?:find|go to|show me)(?: the)? )?(?:next|another) (?:match|one like that|place)$|^find (?:next|again)$|^next match$|^keep looking$/.test(s)) return { name: "findNext", args: { by: 1 } };
  if (c.mode === "article" && /^(?:(?:find|go to)(?: the)? )?(?:previous|last) match$|^find previous$/.test(s)) return { name: "findNext", args: { by: -1 } };
  // Search the web for study material
  const web = s.match(WEB);
  if (web && c.mode !== "tour") {
    const t = web[1] ?? web[2];
    const q = searchQuery(t) ?? t;
    return { name: "search", args: { query: q }, say: `Searching for ${q}.` };
  }
  if (c.mode === "landing" && !inThread(c)) {
    // A question or a display change: the models decide. The topic without the small talk; a request still long after that goes
    // to the models. A sentence with nothing to study in it ("hello", "I'm new here") gets the help line, never a search.
    if (isQuestion(utterance) || DISPLAYISH.test(s)) return null;
    const q = searchQuery(utterance);
    if (!studyWords(q ?? s.replace(/[^\p{L}\p{N}' ]+/gu, " ")).length) return { name: "none", say: help(c) };
    return q ? { name: "search", args: { query: q }, say: `Searching for ${q}.` } : null;
  }
  if (c.mode !== "article") return null;
  // Find words in the open document
  const f = s.match(FIND);
  if (f && !/^(?:find|search for|look for) (?:the )?(?:section|heading|part)\b/.test(s)) return { name: "find", args: { query: f[1].replace(/^(?:the word|the words|the phrase)\s+/, "") } };
  // Figures and tables by number
  const fr = figureRef(utterance) ?? figureRef(polite(s));
  const o = (c.outline ?? []).filter((e) => !c.title || e.label !== c.title); // a PDF's title heading is not a section to go to
  if (fr && o.length) {
    const re = new RegExp(`^${fr.kind} ${fr.n.replace(".", "\\.")}(?![\\d.])`, "i");
    const node = o.find((e) => re.test(e.label));
    if (node) return { name: "goto", args: { id: node.id } };
    const u = fr.kind === "table" ? c.units?.find((x) => new RegExp(`^\\W*table ${fr.n.replace(".", "\\.")}(?![\\d])`, "i").test(x.text)) : undefined;
    if (u) return { name: "land", args: { id: u.id, block: u.block, b: u.b } };
    return { name: "none", say: `${c.paged ? `${fr.kind === "table" ? "Table" : "Figure"} ${fr.n} is not in the pages I have read so far. Say page and a number to go further.` : `There is no ${fr.kind} ${fr.n} on this page.`}` };
  }
  // "Which page does the Attention section start on?", "where is the methods section": answered from the outline, no model.
  const pq = s.match(PAGE_Q) ?? (SECTIONY.test(s) ? s.match(WHERE_Q) : null);
  if (pq && o.length) {
    const name = sectionName(pq[1] ?? pq[2] ?? "");
    const e = name ? (exactHeading(o, name) ?? onlyByName(o, name)) : undefined;
    if (e && "say" in e) return { name: "none", say: e.say, list: e.list };
    if (e) {
      const p = c.pageOf?.[e.id];
      const at = p != null ? `${e.label} starts on page ${p}${c.pages ? ` of ${c.pages}` : ""}.` : `${e.label} is ${e.i > c.index ? "further on" : e.i < c.index ? "earlier" : "where you are"} on this page.`;
      return e.i === c.index ? { name: "none", say: at } : { name: "none", say: `${at} Say yes to go there.`, offer: { name: "goto", args: { id: e.id } } };
    }
    if (name) return { name: "none", say: c.paged && !c.whole ? PAGES_ONLY : `I did not find a section called ${name}${c.paged ? "" : " on this page"}. Say contents to hear the sections.` };
  }
  // Headings by name: "go to the hardware section", "conclusions", "the attention section", "the section called attention".
  // Spoken and typed alike: the heading's own name alone ("attention"), and the one heading named exactly wins.
  const g = s.match(GOTO);
  const raw = g ? g[1] : n <= 4 || /\b(?:section|part|chapter|heading)$/.test(s) ? s : undefined;
  const asked = raw && SECTIONY.test(raw) ? sectionName(raw) || raw : raw;
  if (asked && o.length) {
    const one = SECTIONY.test(raw ?? "") ? exactHeading(o, asked) : undefined;
    if (one) return { name: "goto", args: { id: one.id } };
    const hit = byName(o, asked);
    if (hit) return "id" in hit ? { name: "goto", args: { id: hit.id } } : { name: "none", say: hit.say, list: hit.list };
    const figs = /\b(?:figure|picture|image|chart|graph|diagram)\b/.test(asked) ? figureByWords(o, asked) : [];
    if (figs.length === 1) return { name: "goto", args: { id: figs[0].id } };
    if (figs.length > 1) {
      const w = { say: `${figs.length > 4 ? figs.length : ["", "One", "Two", "Three", "Four"][figs.length]} figures fit: ${figs.slice(0, 4).map((e) => e.label).join("; ")}. Say first or second.`, list: figs.slice(0, 4) };
      return { name: "none", ...w };
    }
  }
  return null;
}

/**
 * A bare word or two that the decision step did not place but that is on the page: offer to find it. Run only after the decision,
 * so a command in any language ("siguiente", "para") is never taken for a word to find.
 */
export function wordOffer(utterance: string, c: Ctx): Resolved | null {
  const s = normalise(utterance);
  if (c.mode !== "article" || !c.units?.length || s.split(" ").length > 3 || isQuestion(utterance) || !distinctWords(utterance).length) return null;
  const m = findText(c.units, s);
  if (!m.length) return null;
  return {
    name: "none",
    say: `${s.replace(/^./, (x) => x.toUpperCase())} is on this page ${m.length === 1 ? "once" : `${m.length} times`}. Say yes to go to ${m.length === 1 ? "it" : "the first"}.`,
    offer: { name: "find", args: { query: s } },
  };
}

// ---- meaning, not exact words: the requests every listener makes, said any polite way ----

const P_LEAD = /^(?:oh dear|oh my|dear|oh|well|um+|uh+|er+|erm|hmm+|mm+|ah+|so|okay|ok|alright|all right|now|sorry|excuse me|hey|hi|hello|arc|please|kindly|just|and|but|then|actually|look|listen|no wait|right then)\s+/;
const P_MODAL = /^(?:would you mind|do you mind|(?:could|can|would|will|won't|wont) you(?: please| kindly| just| maybe| possibly)?|if you (?:could|can|would)|i'?d like you to|i would like you to|i want you to|i need you to|i'?d like to|i would like to|is it possible to|try and|try to|maybe|perhaps|let'?s|lets|you could|you can|i'?d love (?:it if you|you to))\s+/;
const P_TAIL = /\s+(?:please|dear|love|for me|if you can|if you could|if you would|if you don't mind|if you dont mind|thank you|thanks|now|then|arc|okay|ok|would you|could you|will you|can you|for a moment|then please|for me please)$/;

/** A request without its polite wrapper: "could you read a little slower for me, dear" is "read slower". Normalised input. */
export function polite(s: string): string {
  let t = s.replace(/\b(?:please|kindly)\s+/g, "").replace(/\b(?:a little|a bit|a tad|a touch|little bit) (?=(?:slower|faster|louder|quieter|more slowly|more quickly|slow|quick)\b)/g, "");
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(P_LEAD, "").replace(P_MODAL, "").replace(P_TAIL, "").trim();
  }
  return /^(?:please|dear|thanks|thank you|okay|ok|oh|oh dear|well|um+|uh+|right|alright|now|so)$/.test(t) ? "" : t;
}

const QSTART = /^(?:what|what's|whats|why|how|who|whom|whose|when|which|is|are|was|were|do|does|did|can|could|should|would|will|has|have|explain|tell me about|define)\b/;
const PIC = "(?:picture|pictures|image|images|figure|figures|diagram|diagrams|chart|charts|graph|graphs|photo|photos|illustration|illustrations|drawing|drawings)";
const PIC_Q = new RegExp(
  `^(?:is there|are there|is there any|are there any|do you have|have you got|does (?:this|it|the \\w+|this \\w+) have|any|got)(?: (?:a|an|any))? ${PIC}(?: (?:here|in here|in it|in this(?: \\w+)?|on this(?: \\w+)?|nearby|around here|on the page|in the chapter|to look at|for this|at all|anywhere))*$|^where(?:'s| is) (?:the|a) (?:next )?${PIC}$`,
);
const PIC_GO = new RegExp(`^(?:go|take me|bring me|jump|skip|move|get me)(?: (?:over|back|on))? to (?:the |that |a )?(next |previous |last )?${PIC}$|^(?:show me|open) (?:the|that) (?:picture|image)$`);
const TOUR_ASK = new RegExp(
  `^(?:(?:walk|talk|take|guide|lead) me (?:through|round|around) (?:it|this|that|(?:the|this|that) ${PIC})|describe (?:the|this|that) ${PIC}|what'?s in (?:the|this|that) ${PIC}|what is in (?:the|this|that) ${PIC}|what does (?:the|this|that) ${PIC} show|(?:start|begin|take|give me|do) (?:the |a )?(?:picture |figure |image )?tour(?: of (?:it|this|that|the ${PIC}))?|tour (?:the )?${PIC}|explain (?:the|this|that) ${PIC}|show me the picture)(?: (?:bit by bit|step by step|part by part|piece by piece|one part at a time|slowly|in detail|properly))?$`,
);
const UNSUPPORTED: [RegExp, string][] = [
  [/^(?:e ?mail|mail)\b/, "send email"],
  [/^(?:text|message|whatsapp|sms)\b/, "send messages"],
  [/^(?:send|forward)\b/, "send things to other people"],
  [/^print\b/, "print"],
  [/^(?:share|post|tweet)\b/, "share pages"],
  [/^(?:download|save|bookmark)\b/, "save files"],
  [/^(?:call|phone|ring|dial)\b/, "make calls"],
  [/^(?:buy|order|pay)\b/, "buy things"],
];
const OBJECT = /^\S+ (?:this|it|that|these|them|me|him|her|us|my|the|a|an|to|out|off|up|over)\b/;

/** What Arc can do instead, for where the student is. */
export function instead(c: Ctx): string {
  if (c.mode === "landing") return "I can find study pages and read them to you.";
  if (c.mode === "results") return "I can read these results to you and open one.";
  if (c.mode === "tour") return "I can describe this picture and answer questions about it.";
  if (c.mode === "video") return "I can play this lecture, read it to you, and answer questions about it.";
  return "I can read this to you, explain it, or find things in it.";
}

/** Paragraphs from the cursor to item i (forward), or from item i to the cursor (back). */
function paragraphsTo(c: Ctx, i: number): number {
  const b = c.blocks ?? [];
  const at = Math.max(c.index, 0);
  if (i > c.index) {
    const rest = c.index < 0 ? 0 : c.para ? c.para.of - c.para.at : (b[at] ?? 0);
    return rest + b.slice(c.index < 0 ? 0 : at + 1, i).reduce((x, y) => x + y, 0);
  }
  return b.slice(i + 1, at).reduce((x, y) => x + y, 0) + (c.para ? c.para.at - 1 : 0);
}
const farLine = (n: number, back = false) => (n === 0 ? (back ? "just before this" : "right after this") : `${n === 1 ? "one paragraph" : `${n} paragraphs`} ${back ? "back" : "on"}`);

/** The pictures around the cursor: in this section, the next one, the one before. Article pages only. */
function pictures(c: Ctx) {
  const o = c.outline ?? [];
  const figs = o.filter((e) => e.figure);
  const secs = o.filter((e) => e.kind === "section");
  const start = [...secs].reverse().find((e) => e.i <= c.index);
  const end = start ? secs.find((e) => e.i > start.i && e.level <= start.level) : secs.find((e) => e.i > c.index);
  const inSec = (e: Entry) => e.i > (start?.i ?? -1) && e.i < (end?.i ?? Infinity);
  const sectionOf = (e: Entry) => [...secs].reverse().find((x) => x.i < e.i);
  return { figs, here: figs.find((e) => e.i === c.index), ahead: figs.find((e) => e.i > c.index), before: [...figs].reverse().find((e) => e.i < c.index), inSec, sectionOf, start };
}

/** The text a question is answered from: on a lecture video everything Arc knows about it (lib/client/video.ts videoContext), else the page's. */
export const questionSource = (mode: Mode, video: string, page: () => string) => (mode === "video" && video ? video : page());

/** "Is there a picture here?", answered from the page. */
function pictureLine(c: Ctx): Resolved {
  const p = pictures(c);
  const go = (e: Entry, line: string): Resolved => ({ name: "none", say: `${line} Say go to the picture.`, offer: { name: "goto", args: { id: e.id } } });
  if (!p.figs.length) return { name: "none", say: "There are no pictures on this page." };
  if (p.here) return { name: "none", say: `Yes, you are on it: ${p.here.label}. Say walk me through it for a tour.`, offer: { name: "tour", args: { id: p.here.id } } };
  if (p.ahead && p.inSec(p.ahead)) return go(p.ahead, `Yes. ${p.ahead.label} is in this section, ${farLine(paragraphsTo(c, p.ahead.i))}.`);
  const sec = (e: Entry) => {
    const x = p.sectionOf(e);
    return x && x !== p.start ? `, in ${x.label}` : "";
  };
  if (p.ahead) return go(p.ahead, `Not in this section. The next picture is ${p.ahead.label}${sec(p.ahead)}, ${farLine(paragraphsTo(c, p.ahead.i))}.`);
  const b = p.before!;
  return go(b, `Not here. The last picture was ${b.label}${sec(b)}, ${farLine(paragraphsTo(c, b.i), true)}.`);
}

/** "Go to the picture": the one just offered, else the one here or ahead, else the last one. */
function pictureGo(m: RegExpMatchArray, c: Ctx): Resolved {
  if (m[1]?.startsWith("next")) return { name: "nextFigure" };
  if (m[1]) return { name: "prevFigure" };
  const fresh = c.pendingOffer && (c.now ?? Date.now()) - c.pendingOffer.at <= OFFER_MS ? c.pendingOffer : undefined;
  if (fresh?.name === "goto" && fresh.args?.id) return { name: "goto", args: fresh.args };
  const p = pictures(c);
  if (p.here) return { name: "none", say: `You are on it: ${p.here.label}. Say walk me through it for a tour.` };
  const e = p.ahead ?? p.before;
  return e ? { name: "goto", args: { id: e.id } } : { name: "none", say: "There are no pictures on this page." };
}

/** In a tour: how many stops are left. */
function stopsLeft(c: Ctx): Resolved {
  const m = c.stop?.match(/stop (\d+) of (\d+)/i);
  const n = m ? Number(m[2]) : (c.tourStops ?? 0);
  if (!m) return { name: "none", say: `There are ${plural(n, "stop")}, and you have not started yet. ${c.how === "keys" ? "Press Right Arrow to begin." : "Say next to begin."}` };
  const left = n - Number(m[1]);
  return { name: "none", say: left ? `Stop ${m[1]} of ${n}. ${left === 1 ? "One more" : `${left} more`} after this one.` : `This is the last stop, ${m[1]} of ${n}. Say that's enough to leave.` };
}

type Canon = { re: RegExp; to: string | ((m: RegExpMatchArray, p: string, c: Ctx) => Resolved | null); q?: boolean };
// One clause, already polite(): the meaning, when the exact words are not in the grammar. q: also when it is worded as a question.
const CANON: Canon[] = [
  {
    re: /^(?:read|start|go|begin)(?: it| reading| again)? (?:from|at) the (?:very )?(?:beginning|start|top)$|^(?:start|begin) (?:again|over)(?: from the (?:beginning|start|top))?$|^read (?:it|this|the page|the chapter) from the (?:beginning|start|top)$/,
    to: (__, ___, c) => (c.mode === "article" ? { name: "continue", args: { from: "top" } } : null),
  },
  { re: /\b(?:too|so|very|bit|little|rather|quite|really|you'?re|you are|it'?s|that'?s|this is) slow\b|\b(?:going|reading|talking|speaking) (?:too |so |very |rather )?slow(?:ly)?\b|\bfaster\b|\bspeed (?:it |things )?up\b|\bquicker\b|\bhurry(?: up)?\b|\bmore quickly\b|\bpick up the pace\b/, to: "faster" },
  {
    re: /\b(?:too|so|very|bit|little|rather|quite|really|going|reading|talking|speaking) (?:fast|quick(?:ly)?)\b|\bslow(?:er|ly)?\b|\bcan'?t keep up\b|\bcan ?not keep up\b|\bhard to (?:follow|keep up)\b/,
    to: "slower",
  },
  { re: /\b(?:louder|quieter|softer|volume|speak up|too loud|too quiet|too soft|turn (?:it|you|that) (?:up|down)|can'?t hear you|cannot hear you|hard to hear)\b/, to: "louder", q: true },
  {
    re: /^(?:stop|wait|hold on|hang on|pause|quiet|hush|shh+|be quiet|silence|enough|that'?s enough|one moment|just a moment|a moment|one second|one sec|just a second|just a minute|give me a (?:moment|second|minute|sec))(?: (?:a (?:moment|second|minute|sec|bit)|for a (?:moment|second|minute|bit)|reading|talking|there|now|for now|it|that|stop|wait|on|then))*$/,
    to: (__, p, c) => (c.mode === "tour" && /enough/.test(p) ? { name: "leave" } : halt(c)),
  },
  {
    re: /^(?:(?:go|carry|keep|read) on|keep (?:going|reading)|continue|resume|go ahead|begin)(?: (?:reading|to read|with it|with the reading|from here|where (?:you|we) (?:left off|stopped|were)|then|now|again))*$|^(?:read|start reading|begin reading)(?: (?:it|this|that|me|the|whole|entire|full|rest|of|all|everything|chapter|page|text|article|section|book|thing|lot|aloud|out|loud|to|for|on|now))*$/,
    to: (__, p, c) =>
      c.mode === "tour" ? { name: "continue" } : c.mode === "results" ? (/^read/.test(p) ? { name: "read" } : { name: "moreResults" }) : c.mode === "landing" ? { name: "none", say: LANDING_LINE } : { name: "continue" },
  },
  {
    re: /^(?:(?:say|repeat|read) (?:that|it|this|the) ?(?:last |final )?(?:sentence|line)(?: again| once more| one more time)?|(?:say|read) (?:the|that) (?:last|final) (?:sentence|line)(?: again)?|(?:the )?last sentence(?: again)?|repeat (?:the|that) (?:last )?(?:sentence|line))$/,
    to: (__, p) => sentence(p),
    q: true,
  },
  { re: /^(?:read|say|repeat|go over|start) (?:that|this|the|it)(?: whole| last)? (?:part|paragraph|section|bit|block|passage)(?: again| once more| one more time| over| from the (?:start|beginning))$/, to: "read that again" },
  {
    re: /^(?:(?:say|repeat|read) (?:that|it|this) (?:again|once more|one more time)|pardon(?: me)?|what was that(?: again)?|what did you (?:just )?say|sorry what|come again|i (?:didn'?t|did not) (?:catch|hear|get) that|repeat that)$/,
    to: (__, p) => sentence(p),
    q: true,
  },
  { re: /^(?:go |move |jump )?back (?:a (?:bit|little|step|paragraph)|one|a bit more|a little more)$|^(?:the )?(?:bit|part|paragraph) (?:before|before that|just before)$|^(?:go )?back to the (?:bit|part|paragraph) before$/, to: "back" },
  { re: /^(?:skip|move on|next bit|skip ahead|skip on|skip forward|move along|go on to the next (?:bit|part|paragraph))(?: (?:this|that|it|this bit|this part|that part|that bit|ahead|from this|then|a bit|a little|a little bit|a few|a bit more))*$/, to: "skip this" },
  { re: /^(?:where (?:am i|are we|is this|was i|were we)(?: now| up to| before| earlier| again)?(?: in (?:the|this) (?:chapter|page|book|paper|text))?|what part (?:is this|am i in|are we in))$/, to: "where am i", q: true },
  {
    re: /^how (?:much|long|many (?:stops|parts|sections|more))(?: (?:is|are|do i have|have i got|have we got|do we have|is there))?(?: still)? ?(?:left|remaining|to go|more)?(?: (?:in|of|on) (?:this|the) (?:chapter|page|book|paper|section|tour|picture))?$|^how (?:far|long) (?:is it )?(?:to the end|left)$|^how many are left$/,
    to: (__, p, c) => (c.mode === "tour" ? stopsLeft(c) : /^how (?:much|long|far)/.test(p) ? orient("how much is left", c) : null),
    q: true,
  },
  {
    re: /^(?:what (?:can|could|should|do) i (?:say|do|ask)(?: (?:to you|now|here|next|with this|with you))?|what can you do(?: for me)?|what are (?:my|the) (?:options|choices)|i(?:'m| am) (?:lost|confused|stuck)|i don'?t know what to (?:do|say)(?: now| next)?|i do not know what to (?:do|say)|how does this work|how do i use (?:this|you|it)|how do i (?:leave|get out|exit|go back|stop the tour)(?: (?:of )?(?:here|this|the tour|it))?|help(?: me)?)$/,
    to: "help",
    q: true,
  },
  { re: PIC_Q, to: (__, ___, c) => (c.mode === "article" ? pictureLine(c) : null), q: true },
  { re: PIC_GO, to: (m, __, c) => (c.mode === "article" ? pictureGo(m, c) : null) },
  // In a tour: "begin the tour without arrow keys", "start with the first stop".
  { re: /^(?:start|begin|go(?! back)|carry on|continue)\b.*\b(?:tour|stop|stops|picture|part|parts)\b/, to: (__, p, c) => (c.mode !== "tour" ? null : /\bfirst\b/.test(p) ? { name: "goto", args: { at: 0 } } : { name: "next" }) },
  {
    re: TOUR_ASK,
    // In a tour that has not started, "start the tour" is its first stop.
    to: (__, ___, c) => (c.mode === "tour" ? (c.stop ? { name: "none", say: "You are in the tour. Say next for the next part." } : { name: "next" }) : c.mode === "article" || c.mode === "video" ? { name: "tour" } : null),
    q: true,
  },
];

function canon(p: string, c: Ctx): Resolved | null {
  if (p.split(" ").length > 12) return null;
  const q = QSTART.test(p);
  for (const r of CANON) {
    if (q && !r.q) continue;
    const m = p.match(r.re);
    if (!m) continue;
    const to = typeof r.to === "string" ? (core(r.to, r.to, c) ?? orient(r.to, c)) : r.to(m, p, c);
    if (to) return to;
  }
  if (!q && OBJECT.test(p)) for (const [re, what] of UNSUPPORTED) if (re.test(p)) return { name: "none", say: `I can't ${what}. ${instead(c)}` };
  return null;
}

/** One clause: orientation, the grammar, then its meaning. */
function one(p: string, c: Ctx): Resolved | null {
  if (!p) return null;
  return (p.split(" ").length <= 12 ? orient(p, c) : null) ?? core(p, p, c) ?? canon(p, c);
}

/**
 * The request by meaning: the whole without its polite wrapper, else clause by clause ("Stop. Hold on, wait."; "where are we,
 * and how much is left?"). Every clause with words in it must be understood, or nothing is (a question after a command goes on).
 */
function meaning(utterance: string, s: string, c: Ctx): Resolved | null {
  const w = polite(s);
  const whole = w !== s ? one(w, c) : canon(s, c);
  if (whole) return whole;
  const parts = utterance
    .split(/[.!?;,:]+|\s+(?:and then|and|then|but|so)\s+/i)
    .map((x) => polite(normalise(x)))
    .filter(Boolean);
  if (parts.length < 2) return null;
  const hits = parts.map((p) => one(p, c));
  if (hits.some((h) => !h)) return null;
  const all = hits as Resolved[];
  const says = [...new Set(all.map((h) => h.say).filter(Boolean))];
  const act = all.filter((h) => h.name !== "none").at(-1);
  const offer = all.at(-1)?.offer;
  return act ? { ...act, ...(says.length ? { say: says.join(" ") } : {}) } : { name: "none", say: says.join(" "), ...(offer ? { offer } : {}) };
}

const FILLER_WORD = /^(?:u+m+|u+h+|e+r+m*|h+m+|m{2,}h*|mh+m*|a+h+|e+h+|o+h+|huh)$/;
/** Mostly noise: two filler sounds or more ("MMM the ah thing"), or one short word that means nothing alone. */
export function mumbled(u: string): boolean {
  const w = u
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const fill = w.filter((x) => FILLER_WORD.test(x)).length;
  return fill >= 2 || (w.length === 1 && /^(?:the|a|an|and|but|so|i|it|is|of|to|in|on|uh|um|er|ah|oh|mm)$/.test(w[0]));
}

// What a spoken search request says around its topic: "oh dear, could you look again please?", "the chapter about",
// "the one my teacher uses"; and what the student says about their situation ("I have a quiz on Friday", "I'm a first-year
// student"), which is context, never search words.
const SQ_LEAD = /^(?:(?:oh dear|oh|dear|well|um+|uh+|er+|so|okay|ok|hi|hello|hey|there|good (?:morning|afternoon|evening)|sorry|please|now|and|then|right|alright|actually|arc)(?:\s+|$))+/;
const SQ_ASK =
  /^(?:(?:could|can|would|will) (?:you|we)(?: please)?\s+|please\s+|let'?s\s+)?(?:(?:look|search|check|try)(?: again| once more)?(?: for)?|(?:i'?m|i am) (?:looking|searching) for|(?:i'?m|i am) trying to (?:find|learn|understand)|(?:(?:i|i'd|id|i would|i really)\s+)?(?:want|need|like|would like)(?: to (?:find|read|study|learn about|learn|see|look at|get|understand|revise|review|know about|know))?(?: more)?(?: about)?|(?:find|get|show|give) me|find|look up|look for|search for|search|help me (?:find|with|study|learn|understand)|(?:i'?m|i am) (?:studying|reading about|learning about|learning|revising|reviewing|doing|working on)|teach me(?: about)?|tell me about|do|study|learn(?: about)?|revise)(?:\s+|$)/;
const SQ_TOPIC = /^(?:(?:the|a|an|some|that|this)\s+)?(?:(?:chapter|section|page|article|lesson|unit|bit|part|reading|text|book|textbook|one|thing|stuff|material)s?\s+(?:about|on|for|of|that covers|covering)|(?:a )?(?:bit|little|lot)\s+(?:of|about|more about))\s+/;
const SQ_DROP =
  /\b(?:that |which )?(?:my |our |the )?(?:teacher|teachers|tutor|professor|lecturer|class|school)(?:'s)? (?:uses|use|used|gave (?:me|us)|set|wants|assigned|recommended|likes|told me about)(?: (?:us|me|for class|in class))?\b|\bfor (?:my |our |the |a )?(?:\w+ )?(?:class|school|homework|exam|exams|test|course|quiz|module)\b|\b(?:please|thanks|thank you|for me|again|dear|if you can|if you could|if possible|if (?:that'?s|that is|it'?s|it is) (?:all right|alright|ok|okay|fine))\b|\b(?:today|tonight|tomorrow|this (?:week|term|semester|year|morning|afternoon|evening)|next (?:week|term|month|year)|(?:on )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|right now)\b/g;
// A clause about the student, not the topic: "I have a quiz on Friday", "I'm a nursing student"; a topic after "about" stays.
const SQ_SITUATION = /^(?:i (?:have|'ve got|got|'ve|am having)|i'?ve got|(?:i'?m|i am) (?:a|an|in)\b|(?:it'?s|it is|this is) (?:for|due)|because|since|my (?:quiz|test|exam|teacher|class))\b/;
const SQ_WORD_DROP = new Set(["the", "a", "an", "one", "ones", "something", "anything", "stuff", "things", "that", "which", "about", "on", "some", "it", "this", "is", "i", "me", "my", "uses", "use", "to", "more"]);
/**
 * The topic of a spoken search request without the small talk around it, at most seven words ("photosynthesis openstax
 * biology"); undefined when nothing is left, or when it is still long: then a model picks the words.
 */
export function searchQuery(u: string): string | undefined {
  const parts = u.split(/[.!?;,]+|\s+(?:and|but|so)\s+(?=i\b|i'|want|need|would|my\b)/i).map((x) => {
    let t = x.toLowerCase().replace(/[’`]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
    t = t.replace(SQ_LEAD, "").trim();
    if (SQ_SITUATION.test(t)) t = t.match(/\babout (.+)$/)?.[1] ?? "";
    for (let prev = ""; prev !== t; ) {
      prev = t;
      t = t.replace(SQ_LEAD, "").replace(SQ_ASK, "").replace(SQ_TOPIC, "").trim();
    }
    return t
      .replace(SQ_DROP, " ")
      .split(" ")
      .filter((w) => w && !SQ_WORD_DROP.has(w))
      .join(" ");
  });
  const q = parts.filter(Boolean).join(" ").trim();
  return q && q.split(" ").length <= 7 ? q : undefined;
}
// Words that never name something to study: a greeting, a mood, a wish with no topic in it.
const NO_STUDY = new Set("hello hi hey there good morning afternoon evening dear how are you doing i i'm im am new here blind fine well thanks thank start started ready begin help what can do know don't dont not sure study studying learn learning anything everything something stuff today now first time use this work works".split(" "));
/** The words of a search request that could name a topic ("biology"); none for "hello there" or "I'm new here". */
export const studyWords = (q: string) => q.split(" ").filter((w) => w && !NO_STUDY.has(w));

// ---- the page word search: only when asked for, or when nothing else placed a request that names real content ----

/** A request that asks to find words on the page ("find", "search for", "where does it mention", "where they talk about"). */
export const EXPLICIT_FIND =
  /^(?:(?:please |can you |could you )?(?:find|search for|search the page for|look for|look up)\b|where (?:does|do|did) (?:it|they|this|the (?:page|paper|article|text|authors?)) (?:mention|say|talk about|discuss|describe|explain)\b|(?:go |take me |jump |skip )?to (?:where|the (?:part|bit|place|paragraph)s? (?:where|about|on|that talks? about))\b|where (?:it|they) (?:mentions?|talks? about|discuss(?:es)?|says?)\b)/;
// Words that name a request, not the page's content: they never send a request to the word search.
const GENERIC = new Set(
  "walk through talk picture pictures image images figure figures chart graph diagram photo skip ahead next back previous read reading again more less slow slower slowly fast faster quick quicker bit little part parts section sections page pages paper chapter start beginning end top bottom continue stop pause explain simple simpler simply easier easy mean means meaning tell please want need help last sentence line repeat left much long okay right could would should maybe like just really thing things kind sort step steps detail details everything something anything else other others here where there this that these those good great thanks thank sure know think said says going doing make give show take bring move jump hear listen look tour explore describe paragraph paragraphs keep going before after earlier later longer shorter search find mention mentions word words hear heard slide slides video lecture lecturer screen again".split(" "),
);
/** A clear request to search (the page or the web): in a tour it leaves the tour first (lib/client/command.ts). */
export const searchAsked = (u: string) => {
  const s = normalise(u);
  return EXPLICIT_FIND.test(s) || WEB.test(s) || /^(?:search|google)\b/.test(s);
};
/** The content words of a request a word search could use ("bluetooth", "accurate"); none for "skip ahead a bit". */
export const distinctWords = (u: string) => topicWords(normalise(u)).filter((w) => w.length >= 4 && !GENERIC.has(w) && !/^\d+$/.test(w));
/** May a request the decision did not place go to the page word search? Only when it asks to find ("find", "where does it mention"). */
export const wordSearchAllowed = (u: string, d: { act: boolean; action?: string }) => !d.act && distinctWords(u).length > 0 && EXPLICIT_FIND.test(normalise(u));

// In a tour, the natural ways of asking to leave it ("take me back to the page", "I'm done with the picture", "get me out of here").
const TOUR_OUT =
  /^(?:(?:leave|exit|close|quit|end|stop|finish)(?: (?:the|this|that))? (?:tour|picture|figure|image|diagram|chart)\b.*|(?:go |take me |bring me |get me )?back to (?:the )?(?:page|reading|text|article|paper|chapter)\b.*|(?:i'?m|i am|we'?re|we are) (?:done|finished)(?: with (?:the|this|that) (?:tour|picture|figure|image|diagram|chart))?|get me out(?: of (?:here|this|the tour))?|take me out(?: of (?:here|this|the tour))?|let me out|exit|i want to (?:leave|go back|stop the tour))$/;

/** The whole utterance as a command for this context, or null to let Decision and Gemini decide. */
// Never plain "results" or "go to results": a paper's Results section owns those.
export const BACK_TO_RESULTS = /^(?:(?:go |take me |bring me )?back to (?:the |my )?(?:search )?(?:results|result list|results list|list)|(?:show me |read |go to )?(?:my|the search|my search) results(?: again)?)$/;
// "Read me the results", "what did you find": the current list read out (or "none yet"), never a search for those words.
const READ_RESULTS = /^(?:read|tell me|say|list|give me)(?: me)? (?:the |my )?(?:search )?(?:results|list|them|the list)(?: again| out| please)*$|^(?:list them|read them(?: out)?(?: again)?|what (?:did|have) you found?|what (?:did|have) you find|did you find anything|have you found anything|what are the results|any results(?: yet)?)$/;
// The most basic commands, said alone, in other languages Arc reads aloud: answered here with no model, so they also work when the
// model is refused. Only whole short requests; anything longer, and every other language, goes to the decision model by meaning.
const ABROAD: Record<string, string> = {
  // Spanish
  siguiente: "next", "el siguiente": "next", "la siguiente": "next", anterior: "back", "atrás": "back", atras: "back", retrocede: "back", para: "stop", detente: "stop", pausa: "pause",
  repite: "again", "repítelo": "again", repitelo: "again", "otra vez": "again", "de nuevo": "again", ayuda: "help", sigue: "go on", "continúa": "go on", continua: "go on", "sigue leyendo": "go on", leer: "read",
  "más despacio": "slower", "mas despacio": "slower", "más lento": "slower", "mas lento": "slower", "más rápido": "faster", "mas rapido": "faster", "dónde estoy": "where am i", "donde estoy": "where am i",
  "qué puedo decir": "what can i say", "que puedo decir": "what can i say",
  // French
  suivant: "next", suivante: "next", "précédent": "back", precedent: "back", "arrête": "stop", arrete: "stop", "répète": "again", repete: "again", aide: "help", continuer: "go on",
  "plus lentement": "slower", "moins vite": "slower", "plus vite": "faster", "où suis je": "where am i", "ou suis je": "where am i",
  // German
  weiter: "go on", "nächste": "next", "nächster": "next", "nächstes": "next", "zurück": "back", zuruck: "back", stopp: "stop", halt: "stop", wiederhole: "again", wiederholen: "again", nochmal: "again",
  "noch einmal": "again", hilfe: "help", langsamer: "slower", schneller: "faster", "wo bin ich": "where am i",
  // Vietnamese
  "tiếp": "next", "tiếp theo": "next", "kế tiếp": "next", "trước": "back", "quay lại": "back", "lùi lại": "back", "dừng": "stop", "dừng lại": "stop", "ngừng": "stop", "lặp lại": "again", "nhắc lại": "again",
  "đọc lại": "again", "trợ giúp": "help", "giúp tôi": "help", "tiếp tục": "go on", "đọc tiếp": "go on", "chậm hơn": "slower", "chậm lại": "slower", "nhanh hơn": "faster", "tôi đang ở đâu": "where am i",
};

// "How do I install the helper?": answered here, because the mode's help line would otherwise take it and never mention the helper.
// Narrow on purpose: a page may talk about helper cells or browser extensions.
const ASKS_HELPER = /\barc helper\b|\b(?:install|add|get|set up|download)\b.*\b(?:helper|extension)\b|\bsend (?:this|a|any|the|my) (?:page|tab)\b/;

export function resolveLocal(utterance: string, c: Ctx): Resolved | null {
  const s = normalise(utterance.normalize("NFC"));
  if (!s) return null;
  if (ABROAD[s]) return resolveLocal(ABROAD[s], c);
  if (c.mode === "tour" && TOUR_OUT.test(polite(s))) return { name: "leave" };
  if (c.mode === "tour" && /^play(?: it| the tour| it by itself)?$/.test(s)) return { name: "play" }; // the tour goes through the parts by itself again (components/FigureTour.tsx)
  const broken = brokenLink(utterance);
  if (broken != null)
    return broken
      ? { name: "none", say: `That does not look like a link. Do you want me to search for ${broken}? Say yes.`, offer: { name: "search", args: { query: broken }, say: `Searching for ${broken}.` } }
      : { name: "none", say: "That does not look like a link. Paste the whole address, starting with https." };
  if (FILLER.test(s)) return { name: "none", say: NOT_CAUGHT_LINE };
  if (ASKS_HELPER.test(s)) return { name: "none", say: HELPER_LINE };
  if (MORE_HELP.has(s) && !(s === "more" && c.mode !== "landing")) return { name: "none", say: help(c, true) };
  if (s.split(" ").length <= 12) {
    const o = orient(s, c);
    if (o) return o;
  }
  // After opening a result: the same list, at the same place, without searching again (components/Twin.tsx "results").
  if (BACK_TO_RESULTS.test(s) || READ_RESULTS.test(polite(s))) return { name: "results" };
  const r = core(utterance, s, c) ?? meaning(utterance, s, c);
  if (r) return r;
  if (mumbled(utterance)) return { name: "none", say: NOT_CAUGHT_LINE };
  return finders(utterance, s, c);
}

/** The short state the decision step decides over (lib/server/decide.ts), from the same context the local grammar uses. */
export function decisionState(c: Ctx): Record<string, string> {
  const offer = c.pendingOffer && (c.now ?? Date.now()) - c.pendingOffer.at < OFFER_MS ? c.pendingOffer : undefined;
  return {
    mode: c.mode,
    current_item: c.label ? `${c.label} (${c.onKind})` : "none yet",
    position: c.index >= 0 ? `${c.index + 1} of ${c.total}` : `before the first of ${c.total}`,
    last_commands: c.lastCommand ?? "none",
    offer_pending: offer ? `${offer.say ?? offer.name} ${JSON.stringify(offer.args ?? {})}`.slice(0, 200) : "none",
    ...(c.stop ? { tour_stop: c.stop } : {}),
    ...(c.behind ? { [c.mode === "results" ? "page_behind_results" : "search_results_behind"]: c.behind.slice(0, 120) } : {}),
    ...(inThread(c) ? { arc_last_said: c.thread!.a.slice(0, 240) } : {}),
  };
}

export type Route =
  | { to: "act"; name: string; query?: string } // run the decision (name: its action)
  | { to: "question" } // the question session answers, asks back, or runs its own command
  | { to: "find" } // the page word search (lib/client/command.ts topicFind)
  | { to: "offer"; r: Resolved } // a bare word on the page: offer to find it
  | { to: "help" } // the mode's help line
  | { to: "notCaught" } // speech that was not caught: asked for again
  | { to: "notUnderstood" }; // understood as nothing Arc can do: what can be said here

// Moves that stay safe right after an answer: the student takes the reading back.
const THREAD_ACTS = new Set(["next", "prev", "nextHeading", "prevHeading", "nextFigure", "prevFigure", "goto", "read", "continue", "stop", "faster", "slower", "top", "where", "progress", "help", "leave", "results", "more", "open", "tour", "play", "rewind", "readLecture", "picture", "display"]);
const UNSURE = 0.4; // below this, anything but a question is speech that was not caught

/**
 * What Arc does with a decision, once the local grammar had nothing (lib/client/command.ts submitUtterance; checked by
 * scripts/intent-eval.ts). The decision wins over the old word rules: it reads the meaning, in any language; the local grammar
 * keeps the short exact forms that must answer in 0 ms, and it runs first, so for those it wins.
 */
export function routeDecision(text: string, c: Ctx, d: { action: string; confidence: number; act: boolean; query?: string }): Route {
  const thread = inThread(c);
  // Right after an answer or a question from Arc: a reply to it ("yes", "explain that more simply", "no, I mean X") goes back to
  // the question session, which holds the exchange; never a web search or a word search.
  if (thread && !(d.act && THREAD_ACTS.has(d.action))) return { to: "question" };
  if (d.act && d.action === "find") return { to: "find" };
  if (wordSearchAllowed(text, d)) return { to: "find" };
  if (d.act && d.action === "search") {
    const q = searchQuery(text) ?? (c.mode === "landing" ? undefined : d.query);
    if (q && studyWords(q).length) return { to: "act", name: "search", query: q };
    return c.mode === "landing" && q ? { to: "help" } : { to: "question" }; // long: the question session picks the words, from hers
  }
  if (d.act) return { to: "act", name: d.action };
  if (d.action === "question" || isQuestion(text)) return { to: "question" };
  const w = wordOffer(text, c);
  if (w) return { to: "offer", r: w };
  if (mumbled(text) || d.confidence < UNSURE) return { to: "notCaught" };
  if (d.action === "none" && d.confidence >= 0.6) return c.mode === "tour" ? { to: "help" } : { to: "notUnderstood" };
  return { to: "question" }; // unsure of a command: the question session asks what was meant
}
