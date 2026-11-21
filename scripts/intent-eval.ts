// How well Arc understands natural requests: a table of intents by mode, each said many natural ways (long, polite, non-native,
// in Spanish, French, German and Vietnamese), plus things that must NOT be taken as a command. Each phrasing runs the real
// decision order: the local grammar (lib/intent.ts), then the live decision model (lib/server/decide.ts, the request the app
// sends), then the routing the app applies to the decision (lib/intent.ts routeDecision). Prints per-intent pass rates and every
// failure; an "OPPOSITE" failure is a request taken for its opposite or a destructive action (leave that advances, a question
// that navigates).
// Run: npx tsx --env-file=<repo>/.env.local scripts/intent-eval.ts [twin.json] [--cache file] [--only mode] [--fails]
// twin.json: the demo paper's twin (POST /api/load); model answers are cached in --cache, so a rerun costs nothing.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { decide, type Decision, type Item } from "../lib/server/decide";
import * as intent from "../lib/intent";
import { resolveLocal, help, type Ctx, type Resolved } from "../lib/intent";
import { blocksOf } from "../lib/blocks";
import { entriesOf, type Unit } from "../lib/outline";
import { broad, classify, pick } from "../lib/client/narrow";
import type { TwinNode } from "../lib/types";

const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const TWIN = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "twin.json";
const CACHE = arg("--cache") ?? "decide-cache.json";
const ONLY = arg("--only");
const cache: Record<string, unknown> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
const realFetch = globalThis.fetch;
const MAX_NEW = Number(arg("--max-new") ?? 380); // new decision calls this run, at most; the rest is "not measured"
let fresh = 0;
let refused = false; // a 429 or "out of credit": no more calls this run
// Decision answers by request body: the same request is asked once, ever.
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (!String(url).includes("/decisions") || init?.method !== "POST") return realFetch(url, init);
  const k = createHash("sha1").update(String(init.body)).digest("hex");
  if (!cache[k]) {
    if (refused || fresh >= MAX_NEW) throw new Error("not measured");
    fresh++;
    const r = await realFetch(url, init);
    if (r.status === 429) refused = true;
    if (!r.ok) throw new Error("not measured");
    cache[k] = await r.json();
  }
  return new Response(JSON.stringify(cache[k]), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

// ---- contexts, built as lib/client/command.ts currentCtx builds them ----
const twin = JSON.parse(readFileSync(TWIN, "utf8")) as { nodes: TwinNode[]; source: { title: string } };
const nodes = twin.nodes;
const units: Unit[] = nodes.flatMap((n) =>
  n.kind === "figure" ? [{ id: n.id, b: -1, where: n.heading, text: `${n.heading}. ${n.text}` }] : blocksOf(n).map((b, k) => ({ id: n.id, block: b.id, b: k, where: n.heading, text: b.say ?? b.text })),
);
const outline = entriesOf(nodes);
const pageItems: Item[] = nodes.map((n) => ({ id: n.id, label: n.kind === "figure" ? `${n.heading}: ${n.text.slice(0, 80)}` : n.heading }));
const resultLabels = ["Result 1: Wearable IMU systems for knee rehabilitation (pubmed.ncbi.nlm.nih.gov)", "Result 2: Photosynthesis, an overview (openstax.org)", "Result 3: Inertial sensors in physiotherapy, a review (sciencedirect.com)"];
const resultItems: Item[] = resultLabels.map((label, i) => ({ id: `r0${i + 1}`, label }));
const at = (id: string) => nodes.findIndex((n) => n.id === id);
const NOW = Date.now();
const article = (id: string, extra: Partial<Ctx> = {}): Ctx => ({
  mode: "article", onKind: nodes[at(id)].kind === "figure" ? "figure" : "section", index: at(id), total: nodes.length, canGoBack: false, label: nodes[at(id)].heading,
  title: twin.source.title, outline, units, para: { at: 2, of: 4 }, read: { total: 9000, left: 7000 }, rate: 1.25, counts: { sections: 30, figures: 22 }, how: "voice", now: NOW,
  blocks: nodes.map((n) => (n.kind === "section" ? blocksOf(n).length : 0)), next: "2.2. Software", ...extra,
});
type Mode = "landing" | "article" | "figure" | "results" | "tour" | "video" | "thread" | "offer" | "narrow";
const CTX: Record<Exclude<Mode, "narrow">, () => { c: Ctx; items: Item[] }> = {
  landing: () => ({ c: { mode: "landing", onKind: null, index: -1, total: 0, canGoBack: false, how: "voice", now: NOW, title: "" }, items: [] }),
  article: () => ({ c: article("n05", { behind: "search results for knee rehabilitation" }), items: pageItems }),
  figure: () => ({ c: article("n06"), items: pageItems }),
  results: () => ({ c: { mode: "results", onKind: "result", index: 0, total: 3, canGoBack: false, results: resultLabels, label: resultLabels[0], title: "search results for knee rehabilitation", how: "voice", now: NOW, behind: twin.source.title }, items: resultItems }),
  tour: () => ({ c: { ...article("n35"), mode: "tour", onKind: "figure", label: "Figure 20", stop: "stop 2 of 6: right thigh", tourStops: 6, outline: undefined, units: undefined }, items: pageItems }),
  video: () => ({
    c: { mode: "video", onKind: "segment", index: 1, total: 5, canGoBack: false, label: "Reading a pie graph", title: "Reading pie graphs", how: "voice", now: NOW },
    items: ["Introduction", "Reading a pie graph", "Percent of a whole", "An example", "Summary"].map((label, i) => ({ id: `s${i + 1}`, label })),
  }),
  thread: () => ({ c: article("n05", { thread: { q: "what is a quaternion", a: "A quaternion is a set of four numbers that describes how something is turned in space. The paper uses it to give each sensor's orientation.", at: NOW - 8000 } }), items: pageItems }),
  offer: () => ({ c: { mode: "landing", onKind: null, index: -1, total: 0, canGoBack: false, how: "voice", now: NOW, title: "", thread: { q: "photosynthesis for beginners", a: "I found some pages. Would you like to search specifically for book chapters?", at: NOW - 6000 } }, items: [] }),
};
// An offer Arc made a moment ago ("Say yes to go to the first.").
const OFFERED = { name: "find", args: { query: "bluetooth" }, at: NOW - 3000 };

// ---- the table: mode, intent, phrasings. intent "|" alternatives are also right. ----
type Row = [Mode, string, string[], Partial<Ctx>?];
const ROWS: Row[] = [
  // reading a page
  ["article", "next", ["next", "next paragraph please", "go on to the next bit", "skip this paragraph", "move forward one", "the one after this", "next one please", "can you go to the next paragraph", "forward", "I'd like the next paragraph please", "and the next one?", "please move me to the following paragraph"]],
  ["article", "prev", ["back", "previous paragraph", "go back one paragraph", "the paragraph before", "can you go back a bit", "previous one please", "one back", "I want the previous paragraph", "back up one", "read the one before this", "the paragraph before this one please"]],
  ["article", "nextHeading", ["next section", "skip this section", "go to the next section please", "skip to the next heading", "jump ahead to the next section", "I want to skip this whole section", "move on to the next section", "next heading", "could you skip this part and go to the next section", "the section after this one", "next sub section"]],
  ["article", "prevHeading", ["previous section", "go back to the previous section", "the section before this", "back one section", "previous heading", "can you take me to the section before", "go back to the start of the previous section", "one section back", "the previous heading please", "I want the section before this one"]],
  ["article", "nextFigure", ["next figure", "next picture", "go to the next image", "take me to the next figure please", "skip to the next chart", "show me the next diagram", "the next figure please", "jump to the next figure", "move to the next picture", "I'd like to see the next figure"]],
  ["article", "continue", ["read on", "go on", "keep reading", "carry on please", "continue reading from here", "you can keep going", "resume", "please continue", "start reading again from where you stopped", "read the rest of it to me", "read it to me please"]],
  ["article", "stop", ["stop", "hold on", "wait a moment", "be quiet please", "pause", "shh", "can you stop reading for a second", "give me a minute", "stop talking please", "hang on", "please stop for now"]],
  ["article", "repeat", ["again", "repeat that", "say that again", "read that paragraph again", "could you repeat the last part", "what was that", "one more time please", "can you read it again", "I didn't catch that", "pardon", "read this again please"]],
  ["article", "slower", ["slower", "slow down", "you are going too fast", "a bit slower please", "can you read more slowly", "too fast for me", "please talk slower", "I can't keep up", "slow down a little", "read slower please", "that is very fast"]],
  ["article", "faster", ["faster", "speed up", "you are too slow", "a bit faster please", "can you read more quickly", "this is too slow", "please talk faster", "hurry up", "go quicker", "read faster please", "pick up the pace"]],
  ["article", "where", ["where am I", "where are we", "which section am I in", "what part is this", "where am I in the paper", "what section is this", "tell me where I am", "where was I", "what am I on", "where are we now in the article", "can you tell me where I am please"]],
  ["article", "progress", ["how much is left", "how much more is there", "how long until the end", "how many sections are left", "how much longer is this paper", "am I nearly done", "how much is there still to read", "is there much more to go", "how far am I", "how much of this paper is left to read", "how long will the rest take"]],
  ["article", "goto", ["go to the discussion", "take me to the conclusions", "jump to the results section", "I want to read the methods", "the software section please", "can you go to the section about dynamic time warping", "skip to the introduction", "open the abstract", "go to section 2.2", "read me the conclusions", "go to figure 5", "show me figure 12", "figure 3 please", "take me to the hardware part", "I would like to hear the discussion now"]],
  ["article", "find", ["find sampling rate", "search the page for bluetooth", "where does it mention accuracy", "look for the word gyroscope", "find where they talk about the battery", "is there anything about calibration", "find LSTM", "where does the paper mention the sampling frequency", "can you find the word quaternion", "look for accelerometer on this page"]],
  ["figure", "tour", ["tour", "explore it", "walk me through this picture", "describe the figure", "start the tour", "can you guide me around the picture", "take me through it step by step", "I want to explore this diagram", "show me the picture", "what is in this picture, part by part"]],
  ["article", "top", ["start over", "go back to the beginning", "read from the top", "start from the beginning again", "back to the top please", "take me to the start of the page", "restart", "from the top", "begin again from the start", "go to the very beginning"]],
  ["article", "help", ["help", "what can I say", "what can I do here", "I'm lost", "what are my options", "how does this work", "I don't know what to do", "what commands are there", "can you tell me what I can say", "what should I say"]],
  ["article", "search", ["find me papers about knee rehabilitation", "search the web for exercise recognition with lstm", "look up articles on wearable sensors", "I want to find other studies about gait analysis", "search the web for lstm exercise recognition", "find a textbook chapter on muscle anatomy", "can you search online for imu sensors", "get me some videos about physiotherapy", "search google for smart insoles", "find other papers about fitness trackers"]],
  ["article", "results", ["go back to the results", "back to the list", "go back to the list", "take me back to my search results", "show me the results again", "the search results please", "return to the results list", "back to the search list", "can we go back to the results", "I want the list of results again"]],
  ["article", "yes", ["yes", "yes please", "sure", "okay do it", "yeah go ahead", "that would be great", "yes that would be lovely", "please do", "alright", "yep"], { pendingOffer: OFFERED }],
  ["article", "no", ["no", "no thanks", "not now", "no thank you", "nope", "I don't want that", "never mind", "cancel", "not really", "no, leave it"], { pendingOffer: OFFERED }],
  ["article", "question", ["what does the belt unit contain", "why did they use bluetooth", "how accurate is the system", "who wrote this paper", "what is a quaternion", "explain the software part to me", "why the belt is needed?", "what's an IMU", "is this study reliable", "the sensors are on the legs?", "this is really interesting", "hmm okay", "I think my teacher mentioned this", "my knee hurts sometimes"]],
  // findings A, B, D, G, H, J, O, T in their own words
  ["thread", "reply", ["explain me this more simple please", "no, I mean quaternion... more simple", "what do you mean", "can you say it more simply", "and why is that", "give me an example", "I still don't understand", "yes", "no", "and the second one?", "what about the gyroscope", "tell me more about that"]],
  ["thread", "next", ["next", "next paragraph"]],
  ["thread", "stop", ["stop", "hold on"]],
  ["offer", "reply", ["yes please, that would be lovely, a book chapter", "yes", "no thanks", "yes book chapters please", "sure", "no, videos instead", "a book chapter", "that one"]],
  // results
  ["results", "next", ["next", "next result", "the next one", "go to the next one please", "skip this one", "move on", "and the next?", "next one please", "forward", "what's the next result"]],
  ["results", "prev", ["previous result", "back one", "the one before", "previous", "previous one please", "the result before this", "one result back", "go to the previous result", "the last one again", "back up one result"]],
  ["results", "open", ["open the first one", "open number two", "open result 3", "the second one please, open it", "open it", "let's open the third result", "open the second", "can you open number one", "open that one", "open the one from science direct", "the openstax one", "open the pubmed one", "open the one about photosynthesis", "open the review paper", "I'll take the sciencedirect one"]],
  ["results", "more", ["more", "More.", "more results", "what else is there", "any more", "the next few", "read me more results", "are there other results", "give me more options", "can I hear the rest", "more please"]],
  ["results", "leave", ["go back", "back to the page", "go back to the paper", "leave the results", "take me back to what I was reading", "return to the article", "close the results", "back to my paper please", "I'm done with the results", "get out of the results"]],
  ["results", "results", ["read me the results", "read them", "what did you find", "did you find anything", "read the results again", "what are the results", "tell me the results", "list them", "what have you found", "read the list"]],
  ["results", "search", ["search for gait analysis instead", "find me something about muscle anatomy", "let's look for videos about running", "can you search for photosynthesis", "I want papers about the knee instead", "look up cell division", "search again for exercise sensors", "find something else about wearables", "try searching for smart textiles", "new search for physiotherapy"]],
  ["results", "help", ["help", "what can I say", "what do I do now", "how do I open one", "what are my options", "I'm lost", "what can I do here", "how does this work", "what should I say", "I don't know what to do"]],
  ["results", "question", ["which one is best", "are any of these free", "what is a systematic review", "hmm", "interesting", "is the first one recent", "which of these is a textbook", "who wrote the second one", "what is pubmed", "are these good for a beginner"]],
  // picture tour
  ["tour", "next", ["next", "next stop", "go on to the next part", "the next one please", "move on", "next part of the picture", "forward", "show me the next part", "skip this stop", "the next stop please"]],
  ["tour", "prev", ["back", "previous stop", "the one before", "go back a stop", "previous part", "back one", "go back to the previous part please", "one back", "the stop before", "the part before this one"]],
  ["tour", "repeat", ["again", "repeat that", "say that again", "what was that", "repeat this stop", "can you say it again", "once more", "pardon", "I missed that", "read this part again"]],
  ["tour", "stop", ["hold on", "wait", "pause", "stop for a moment", "give me a second", "hang on please", "be quiet a moment", "wait wait", "one moment please", "pause the tour"]],
  ["tour", "continue", ["go on", "carry on", "continue", "keep going", "resume the tour", "you can continue now", "okay go on", "carry on please", "resume", "start again where you stopped"]],
  ["tour", "leave", ["Leave it and take me back to the reading", "no more picture please", "That is enough", "that's enough", "get me out", "leave the tour", "back to the page", "I'm done with this picture", "stop the tour and go back to the text", "exit", "close the tour please", "I don't want the picture any more", "enough of the picture, back to the article"]],
  ["tour", "slower", ["slower", "slow down", "too fast", "a bit slower please", "can you talk more slowly", "you are going too fast", "slow down please", "that is too quick for me", "read slower", "more slowly"]],
  ["tour", "faster", ["faster", "speed up", "too slow", "a bit faster please", "can you talk faster", "you are very slow", "hurry up", "quicker please", "read faster", "go faster"]],
  ["tour", "progress", ["how many stops are left", "how much more of the tour", "how many parts are left", "is this the last stop", "how many stops are there", "how much is left", "how long is this tour", "are we nearly done", "how many more", "how far through the tour am I"]],
  ["tour", "help", ["help", "what can I say", "how do I leave", "what can I do in the tour", "I'm lost", "what are my options", "how does this work", "what should I say", "what commands are there", "how do I get out of here"]],
  ["tour", "question", ["what is the red line", "why is the angle so high", "what does this part mean", "is that the knee", "interesting", "hmm", "what is a thigh angle", "why does it go down here", "which leg is this", "what colour is it"]],
  // the start page: E and M
  ["landing", "search", [
    "photosynthesis", "I want to learn about photosynthesis", "can you find me something on the cell cycle", "Hello dear, I'd like to learn a bit about photosynthesis today if that's all right", "teach me about mitosis",
    "search for the french revolution", "I need to study the krebs cycle for my exam", "find a textbook chapter on the heart", "I'm looking for something about plate tectonics", "help me study cellular respiration please",
    "the openstax chapter about the endocrine pancreas", "I would like to read about DNA replication", "my teacher wants me to read about the water cycle", "find the wikipedia page on black holes", "good morning, could you find me material on climate change",
    "I have a test on Monday about the nervous system", "I'm a nursing student and I need to understand the kidney", "could you help me find a video on fractions please", "hi, I'm revising the cold war for my history exam", "something on the immune system please",
  ]],
  ["landing", "broad", [
    "biology", "I want to study biology", "Hello dear, I'd like to learn a bit of biology today if that's all right", "I want to study biology, I have a quiz on Friday", "help me with chemistry",
    "I'd like to study some physics please", "can we do math today", "I have a history test tomorrow and want to study history", "I'm studying psychology", "teach me biology",
    "good evening, I would like to learn biology", "I need to revise chemistry for my exam next week", "let's study economics", "I'm a first year student and I want to learn biology", "biology please",
    "Hi, I want to study biology. I have a quiz on Friday.", "um so I'm doing biology this term", "I would like to learn some chemistry if possible",
  ]],
  ["landing", "help", ["hello", "hi there", "good morning", "I'm new here", "help", "can you help me", "I'd like to study", "I don't know what to study", "what can I do", "how does this work", "hello, I'm blind and new to this", "what can I say", "hello dear, how are you today"]],
  ["landing", "open", ["open the example paper", "show me an example", "open the example", "open the video", "open the textbook", "open a research paper", "open the paper", "open an example", "open a video", "open a textbook"]],
  // lecture
  ["video", "play", ["play", "play the video", "start the lecture", "resume the video", "play it please", "can you play the lecture", "unpause", "start playing", "let's watch it", "go ahead and play it"]],
  ["video", "stop", ["pause", "pause the video", "stop the video", "hold on", "wait", "stop", "pause the lecture please", "can you pause it", "stop playing", "one moment"]],
  ["video", "rewind", ["back ten seconds", "rewind", "go back a bit", "replay that bit", "rewind ten seconds", "go back 10 seconds", "play that again", "replay the last bit please", "skip back", "jump back"]],
  ["video", "readLecture", ["read the lecture to me", "can you read it instead", "read me the transcript", "read the lecture", "I'd rather you read it", "switch to reading", "read it aloud instead of playing", "read the text of the lecture", "you read it please", "stop the video and read it to me"]],
  ["video", "videoNext", ["next part", "next", "skip this part", "go to the next part", "the next bit please", "move on to the next part", "skip ahead to the next part", "next section", "the part after this", "next one"]],
  ["video", "question", ["what is a pie graph", "why is the slice blue", "how do you work out the percent", "what does she mean by whole", "is this on the test", "hmm", "interesting", "what is a sector", "who is the teacher", "how many slices are there"]],
  // Spanish (R), on the page and in the tour
  ["article", "next·es", ["siguiente", "el siguiente", "siguiente párrafo", "el que sigue", "pasa al siguiente", "sigue con el próximo párrafo", "el próximo", "próximo párrafo por favor", "avanza", "ve al siguiente"], { how: "voice" }],
  ["article", "prev·es", ["anterior", "atrás", "el párrafo anterior", "vuelve atrás", "regresa un párrafo", "el anterior por favor", "retrocede", "vuelve al anterior", "ve atrás", "uno atrás"]],
  ["article", "stop·es", ["para", "detente", "pausa", "espera", "silencio", "un momento", "cállate por favor", "deja de leer", "para un momento", "espera un segundo"]],
  ["article", "continue·es", ["sigue", "continúa", "sigue leyendo", "lee", "léelo", "continúa leyendo", "adelante, sigue", "sigue por favor", "lee el resto", "reanuda"]],
  ["article", "repeat·es", ["repite", "otra vez", "repítelo", "dilo otra vez", "puedes repetir", "¿cómo?", "lee eso otra vez", "repite por favor", "de nuevo", "vuelve a leerlo"]],
  ["article", "slower·es", ["más despacio", "más lento", "despacio por favor", "habla más despacio", "lee más lento", "vas muy rápido", "baja la velocidad", "un poco más despacio", "demasiado rápido", "más lento por favor"]],
  ["article", "faster·es", ["más rápido", "rápido", "lee más rápido", "habla más rápido", "acelera", "vas muy lento", "sube la velocidad", "un poco más rápido", "demasiado lento", "más rápido por favor"]],
  ["article", "where·es", ["¿dónde estoy?", "dónde estoy", "¿en qué sección estoy?", "¿dónde estamos?", "¿qué parte es esta?", "¿en qué parte estoy?", "dime dónde estoy", "¿qué sección es esta?", "¿dónde me quedé?", "¿en qué apartado estoy?"]],
  ["article", "help·es", ["ayuda", "¿qué puedo decir?", "¿qué puedo hacer?", "estoy perdido", "¿cómo funciona esto?", "¿cuáles son mis opciones?", "no sé qué hacer", "necesito ayuda", "¿qué comandos hay?", "¿qué digo?"]],
  ["article", "picture·es", ["¿hay una imagen?", "¿hay alguna imagen?", "¿hay fotos?", "¿tiene figuras?", "¿hay un gráfico?", "¿hay algún dibujo aquí?", "¿hay imágenes en esta sección?", "¿hay una figura?", "¿tiene alguna imagen?", "¿hay un diagrama?"]],
  ["tour", "leave·es", ["salir", "sal del recorrido", "basta", "ya es suficiente", "vuelve al texto", "termina el recorrido", "quiero salir", "ya está, vuelve a la lectura", "cierra el recorrido", "no más imagen"]],
  // French, German, Vietnamese
  ["article", "next·fr/de/vi", ["suivant", "le paragraphe suivant", "weiter", "nächster Absatz", "tiếp theo", "đoạn tiếp theo", "passe au suivant", "der nächste", "sang đoạn sau", "allez, suivant"]],
  ["article", "stop·fr/de/vi", ["arrête", "stop, attends", "pause s'il te plaît", "halt", "stopp", "warte", "dừng lại", "tạm dừng", "đợi một chút", "hör auf zu lesen"]],
  ["article", "repeat·fr/de/vi", ["répète", "encore une fois", "redis-le", "wiederholen", "noch einmal", "sag das nochmal", "nhắc lại", "đọc lại", "nói lại đi", "répète s'il te plaît"]],
  ["article", "where·fr/de/vi", ["où suis-je", "je suis où", "dans quelle section suis-je", "wo bin ich", "in welchem Abschnitt bin ich", "wo sind wir", "tôi đang ở đâu", "đây là phần nào", "mình đang ở phần nào", "où en suis-je"]],
  ["article", "help·fr/de/vi", ["aide", "qu'est-ce que je peux dire", "comment ça marche", "Hilfe", "was kann ich sagen", "wie funktioniert das", "giúp tôi", "tôi có thể nói gì", "làm sao dùng cái này", "aide-moi"]],
];

// ---- what Arc did, in the table's words ----
const sayIs = (r: Resolved, c: Ctx): string => {
  const s = r.say ?? "";
  if (s === help(c) || s === help(c, true) || s.startsWith(help({ ...c, how: "voice" }).slice(0, 40)) || /^Nothing is open yet/.test(s) || s.startsWith("Say what you want to study") || s.startsWith("Paste a link")) return "help";
  if (s === resolveLocal("where am i", c)?.say || /^(?:At the top|Figure \d+, in|.* tour, stop)/.test(s)) return "where";
  if (/(left (?:on|in) this|of reading|more after this|last stop|There are \d+ stops)/.test(s)) return "progress";
  if (s === "Okay.") return "no";
  if (/^There is nothing waiting for a yes/.test(s)) return "nothingForYes";
  if (/is on this page .* Say yes/.test(s)) return "findOffer";
  if (/didn't catch that/.test(s)) return "notCaught";
  if (/fit: .* Say first/.test(s)) return "ask";
  if (/Yes, you are on it|is in this section|The next picture is|The last picture was|no pictures/.test(s)) return "picture";
  return `say:"${s.slice(0, 50)}"`;
};
const LOCAL: Record<string, (r: Resolved, c: Ctx) => string> = {
  read: () => "repeat", continue: (r) => (r.args?.from === "top" ? "top" : "continue"), moreResults: () => "more", land: () => "goto", return: () => "return", none: sayIs,
  seek: (r) => (Number(r.args?.by) < 0 ? "rewind" : "seekAhead"), search: (r) => (broad(String(r.args?.query ?? "")) ? "broad" : "search"),
};
const localIntent = (r: Resolved, c: Ctx) => (LOCAL[r.name] ?? (() => r.name))(r, c);
const ACT: Record<string, string> = { read: "repeat", more: "more" };
const route = (intent as unknown as { routeDecision?: (t: string, c: Ctx, d: Decision) => { to: string; name?: string; query?: string } }).routeDecision;
const kind = (w: string) => w.replace(/·.*$/, "");

/** Today's routing of a spoken request after the decision (components/AskButton.tsx with lib/client/command.ts), for the baseline. */
function legacy(text: string, c: Ctx, d: Decision): string {
  if (c.mode === "tour" && !intent.isQuestion(text)) return "help";
  if (intent.wordSearchAllowed(text, d)) return "find?";
  if (d.action === "search" && !intent.searchQuery(text) && d.act) return "question";
  if (!d.act && (intent.mumbled(text) || (d.confidence < 0.4 && d.action !== "question"))) return "notCaught";
  if (d.act) return d.action === "search" ? (broad(intent.searchQuery(text) ?? d.query) ? "broad" : "search") : (ACT[d.action] ?? d.action);
  if (d.action === "none" && d.confidence >= 0.6) return "notUnderstood";
  return "question";
}

const NAV = new Set(["next", "prev", "nextHeading", "prevHeading", "nextFigure", "prevFigure", "goto", "find", "find?", "search", "broad", "open", "leave", "more", "results", "continue", "top", "tour", "page", "return", "play", "rewind"]);
const OPPOSITE: Record<string, Set<string>> = {
  leave: new Set(["next", "prev", "continue", "find", "find?", "search", "broad", "goto"]),
  stop: new Set(["next", "continue", "play", "prev"]),
  continue: new Set(["stop"]),
  play: new Set(["stop"]),
  yes: new Set(["no"]),
  no: new Set(["yes", "search", "find", "open", "goto"]),
  slower: new Set(["faster"]),
  faster: new Set(["slower"]),
  results: new Set(["search", "broad"]),
  help: new Set(["search", "broad", "find", "find?", "goto", "next"]),
  where: new Set(["next", "prev", "find", "find?", "goto", "search"]),
  progress: new Set(["next", "find", "find?", "search"]),
  repeat: new Set(["next", "find", "find?", "search"]),
  question: NAV,
  picture: new Set(["find", "find?", "search"]),
};
const ACCEPT: Record<string, string[]> = {
  question: ["question", "notUnderstood", "notCaught", "nothingForYes"], reply: ["question"], help: ["help"], repeat: ["repeat"], next: ["next"], stop: ["stop"],
  goto: ["goto", "ask"], nextHeading: ["nextHeading", "goto"], prevHeading: ["prevHeading", "goto"], tour: ["tour"], picture: ["picture", "goto", "nextFigure", "tour"],
  leave: ["leave"], results: ["results"], top: ["top", "goto"], yes: ["yes", "find"], no: ["no"],
  open: ["open", "goto+open"], videoNext: ["next", "nextHeading"], search: ["search"], broad: ["broad"], rewind: ["rewind"],
};

async function run() {
  const rows = ROWS.filter((r) => !ONLY || r[0] === ONLY);
  const skipped: string[] = [];
  const out: { mode: string; intent: string; text: string; got: string; conf: string; ok: boolean; opp: boolean }[] = [];
  const jobs: (() => Promise<void>)[] = [];
  for (const [mode, want, says, extra] of rows)
    for (const text of says)
      jobs.push(async () => {
        if (mode === "narrow") return;
        const { c: base, items } = CTX[mode]();
        const c = { ...base, ...extra };
        let got: string, conf = "local";
        const r = resolveLocal(text, c);
        if (r) got = localIntent(r, c);
        else {
          const state = (intent as unknown as { decisionState?: (c: Ctx) => Record<string, string> }).decisionState?.(c) ?? legacyState(c);
          let d: Decision;
          try {
            d = await decide({ utterance: text, items, inTour: c.mode === "tour", state });
          } catch (e) {
            if (!/credit|budget|not measured/i.test((e as Error).message)) refused = refused || /429/.test((e as Error).message);
            skipped.push(`[${mode} ${want}] "${text}"`); // refused or over the cap: not a model failure
            return;
          }
          conf = `${d.action} ${d.confidence.toFixed(2)}${d.target ? ` ${d.target}` : ""}${d.act ? "" : " unsure"}`;
          if (route) {
            const x = route(text, c, d);
            got = x.to === "act" ? (x.name === "search" ? (broad(x.query ?? "") ? "broad" : "search") : (ACT[x.name!] ?? x.name!)) : x.to === "offer" ? "findOffer" : x.to;
            if (x.query) conf += ` query "${x.query}"`;
          } else got = legacy(text, c, d);
        }
        // A search's words: never her small talk; a whole subject alone is the narrowing path.
        if ((got === "search" || got === "broad") && r?.name === "search") conf = `query "${r.args?.query}"`;
        const ok = (ACCEPT[kind(want)] ?? [kind(want)]).includes(got);
        out.push({ mode, intent: want, text, got, conf, ok, opp: !ok && !!(OPPOSITE[kind(want)] ?? (kind(want) === "reply" ? NAV : undefined))?.has(got) });
      });
  // A narrowing question open: lib/client/narrow.ts classify and pick, no model.
  const options = ["cells", "genetics", "evolution", "ecology"];
  const N: [string, string[]][] = [
    ["answer", ["genetics", "the second one", "genetics please", "number 2", "I'd like evolution", "cells I think", "ecology", "the first", "two", "the last one", "plants and how they grow", "how cells divide"]],
    ["skip", ["I don't know", "just search", "whatever", "doesn't matter", "you choose", "no idea", "not sure", "anything", "I don't mind", "any of them", "I really don't know", "I'm not sure, you pick"]],
    ["cancel", ["cancel", "never mind", "forget it", "stop", "no thanks", "leave it", "cancel that", "nope", "not now", "no"]],
    ["again", ["say that again", "what were the options", "repeat", "pardon", "what", "repeat the question", "what are the options", "sorry what", "once more", "come again"]],
  ];
  if (!ONLY || ONLY === "narrow")
    for (const [want, says] of N)
      for (const text of says) {
        const k = classify(text);
        const got = k === "answer" ? (pick(text, options) !== undefined || text.split(" ").length > 2 ? "answer" : "answer?") : k;
        out.push({ mode: "narrow", intent: want, text, got, conf: "local", ok: got === want || (want === "answer" && got === "answer?"), opp: want !== "cancel" && got === "cancel" });
      }
  for (let i = 0; i < jobs.length; i += 2) await Promise.all(jobs.slice(i, i + 2).map((j) => j())); // two at a time, never a burst
  writeFileSync(CACHE, JSON.stringify(cache));
  const groups = new Map<string, typeof out>();
  for (const o of out) groups.set(`${o.mode} ${o.intent}`, [...(groups.get(`${o.mode} ${o.intent}`) ?? []), o]);
  console.log("\nPER INTENT (passes / phrasings)");
  for (const [k, g] of groups) console.log(`${g.filter((x) => x.ok).length >= Math.ceil(g.length * 0.9) ? " " : "!"} ${k.padEnd(26)} ${String(g.filter((x) => x.ok).length).padStart(2)}/${g.length}${g.some((x) => x.opp) ? `  OPPOSITE x${g.filter((x) => x.opp).length}` : ""}`);
  const fails = out.filter((o) => !o.ok);
  console.log(`\nTOTAL ${out.length - fails.length}/${out.length} measured; opposite or destructive: ${fails.filter((f) => f.opp).length}; not measured (refused or over the cap): ${skipped.length}; new decision calls: ${fresh}`);
  if (process.argv.includes("--fails")) for (const x of skipped) console.log(`NOT MEASURED ${x}`);
  if (process.argv.includes("--fails")) for (const f of fails) console.log(`${f.opp ? "OPPOSITE " : ""}[${f.mode} ${f.intent}] "${f.text}" -> ${f.got} (${f.conf})`);
}

/** lib/client/command.ts snapState, for code that has no decisionState yet. */
function legacyState(c: Ctx): Record<string, string> {
  return {
    mode: c.mode,
    current_item: c.label ? `${c.label} (${c.onKind})` : "none yet",
    position: c.index >= 0 ? `${c.index + 1} of ${c.total}` : `before the first of ${c.total}`,
    last_commands: "none",
    offer_pending: c.pendingOffer ? `${c.pendingOffer.name} ${JSON.stringify(c.pendingOffer.args ?? {})}` : "none",
    ...(c.stop ? { tour_stop: c.stop } : {}),
  };
}

void run();
