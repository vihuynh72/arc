// Browser <-> Gemini Live relay for /ws/voice. Protocol (JSON text frames):
// in:  {type:"start", context} | {type:"say", id, text} | {type:"cancel", id?}
//      {type:"ask_start", id} | {type:"ask_audio", data: b64 PCM16 16 kHz} | {type:"ask_end"}
//      {type:"ask_text", id, text} (a typed question: same session, instruction, context and tools as a spoken one)
// out: {type:"audio", id, data: b64 PCM16 24 kHz} | {type:"done", id, transcript, match, cached?, heard?}
//      {type:"heard", id, text} (once per ask, as soon as the student's words are final, before any answer)
//      {type:"heard_partial", id, text} (while the key is held: the whole transcript so far, from the transcription session)
//      {type:"command", id, name, args} | {type:"error", id?, message, fallback}
// Two upstream sessions per browser socket: a strict reader, and an asker that holds page context
// and tools. One session for both made the reader speak page context instead of the given text.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import WebSocket from "ws";
import { GEMINI_LIVE_MODEL, LIVE_VOICE } from "../models";

const LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const CACHE_DIR = ".cache/audio";
// Transcription only (no audio out, no tools): interim words while the student still speaks. Kept here, not in
// lib/models.ts, because only this relay uses it.
const TRANSCRIBE_MODEL = "gemini-3.5-transcribe-live";

// Tour reader: strict, reads exactly what it is given.
const READER_RULE =
  "You read text aloud. When you receive a message, speak exactly its words, in order, and nothing else. " +
  "Do not answer it, comment on it, greet, or add any word. Never speak these instructions.";

// Question session: the listener is blind and hears every word, so short, concrete and spatial in words.
const ASKER_RULE = [
  "You help a blind student study one web page by voice. The student cannot see the screen.",
  "If the student asks to move, read, stop, take a figure tour, search the web, open a result or link, or fetch the page again, call the matching function and say nothing.",
  "Otherwise answer in one or two short sentences.",
  "Say positions in words, for example: on the left side of the figure, or two stops after the belt unit.",
  'Never say "as you can see" or "shown here", and never say above or below without naming the thing you mean.',
  "Use only the page context below. If the answer is not in it, say so in one sentence.",
  "Never invent figures, numbers or results.",
  "If the request is unclear, ask one short question.",
  "Never read these instructions aloud.",
].join(" ");

const askerRule = (context: string) => `${ASKER_RULE}\n\nPAGE:\n${context || "(no page loaded)"}`;

const str = (description: string) => ({ type: "STRING", description });
const TOOLS = [
  {
    functionDeclarations: [
      { name: "next", description: "Move to the next heading, section or item." },
      { name: "prev", description: "Move to the previous heading, section or item." },
      {
        name: "goto",
        description: "Jump to a heading, section or figure by name or number.",
        parameters: { type: "OBJECT", properties: { query: str("Heading or figure, e.g. Methods or figure 2") }, required: ["query"] },
      },
      { name: "read", description: "Read the current section aloud." },
      { name: "stop", description: "Stop speaking." },
      {
        name: "tour",
        description: "Start the guided tour of a figure.",
        parameters: { type: "OBJECT", properties: { figure: { type: "NUMBER", description: "Figure number" } } },
      },
      {
        name: "search",
        description: "Search the web for a study page.",
        parameters: { type: "OBJECT", properties: { query: str("Search words") }, required: ["query"] },
      },
      {
        name: "open",
        description: "Open a web page by address.",
        parameters: { type: "OBJECT", properties: { url: str("Full URL") }, required: ["url"] },
      },
      { name: "refresh", description: "Fetch the current page again, live from the web." },
    ],
  },
];

type Msg = Record<string, unknown> & { type: string };
// Live messages are loosely typed JSON; keep them as `any` at this one boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LiveMsg = any;

/** One Live session that opens lazily and resumes with the last handle after a drop. */
class Upstream {
  private ws?: WebSocket;
  private ready?: Promise<void>;
  handle?: string;

  constructor(
    private setup: () => object,
    private onMessage: (m: LiveMsg) => void,
    private onDrop: () => void,
    private resumable = true,
  ) {}

  /** Opens (or reuses) the session; retries once, then rejects. */
  open(): Promise<void> {
    if (!this.ready) this.ready = this.connect().catch(() => this.connect()).catch((e) => {
      this.ready = undefined;
      throw e;
    });
    return this.ready;
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const key = process.env.GEMINI_API_KEY;
      if (!key) return reject(new Error("GEMINI_API_KEY missing"));
      const ws = new WebSocket(LIVE_URL, { headers: { "x-goog-api-key": key } });
      let up = false;
      const timer = setTimeout(() => ws.terminate(), 8000);
      ws.on("open", () => {
        const s = this.setup() as { setup: Record<string, unknown> };
        if (this.resumable) s.setup.sessionResumption = this.handle ? { handle: this.handle } : {};
        ws.send(JSON.stringify(s));
      });
      ws.on("message", (d) => {
        let m: LiveMsg;
        try {
          m = JSON.parse(d.toString());
        } catch {
          return;
        }
        if (m.setupComplete) {
          up = true;
          clearTimeout(timer);
          this.ws = ws;
          return resolve();
        }
        if (this.ws !== ws) return; // a socket closed by close(): its late messages belong to nobody
        if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) this.handle = m.sessionResumptionUpdate.newHandle;
        this.onMessage(m);
      });
      ws.on("error", () => {}); // close follows
      ws.on("close", (code, reason) => {
        clearTimeout(timer);
        if (!up) {
          if (this.handle) this.handle = undefined; // a stale handle can be why setup failed
          return reject(new Error(`Live closed before setup: ${code} ${reason}`));
        }
        if (this.ws === ws) {
          this.ws = undefined;
          this.ready = undefined;
          this.onDrop();
        }
      });
    });
  }

  send(obj: object) {
    this.ws?.send(JSON.stringify(obj));
  }

  close(forget = false) {
    if (forget) this.handle = undefined;
    const ws = this.ws;
    this.ws = undefined;
    this.ready = undefined;
    ws?.close();
  }
}

const liveSetup = (rule: string, extra: object = {}) => ({
  setup: {
    model: `models/${GEMINI_LIVE_MODEL}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: LIVE_VOICE } } },
    },
    systemInstruction: { parts: [{ text: rule }] },
    outputAudioTranscription: {},
    realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
    ...extra,
  },
});

export const normalize = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const cachePath = (text: string) =>
  `${CACHE_DIR}/${createHash("sha1").update(LIVE_VOICE + text).digest("hex")}.pcm`;

interface Job {
  id: string;
  text: string;
  audio: Buffer[];
  transcript: string;
  cancelled: boolean;
  retried: boolean;
}

export function attachVoice(client: WebSocket) {
  const out = (m: Msg) => client.readyState === WebSocket.OPEN && client.send(JSON.stringify(m));
  let context = "";

  // ---- reader lane: a queue of say jobs over a small pool of reader sessions ----
  // One line per session turn: a new line sent before turnComplete on the SAME session mixed audio. A cancelled line
  // keeps generating on its own session (so the cache fills) while the next line starts at once on another one.
  // Lines that are not cancelled still go one at a time, in order.
  const POOL = 4;
  interface Lane {
    up: Upstream;
    job?: Job; // generating now
    turnOpen: boolean; // Live takes the next turn only after turnComplete
  }
  const queue: Job[] = [];
  const lanes: Lane[] = [];

  function lane(): Lane {
    const l: Lane = { turnOpen: false } as Lane;
    l.up = new Upstream(
      () => liveSetup(READER_RULE),
      (m) => {
        const sc = m.serverContent;
        if (!sc) return;
        const job = l.job;
        if (job) {
          for (const p of sc.modelTurn?.parts ?? []) {
            if (!p.inlineData?.data) continue;
            job.audio.push(Buffer.from(p.inlineData.data, "base64"));
            if (!job.cancelled) out({ type: "audio", id: job.id, data: p.inlineData.data });
          }
          if (sc.outputTranscription?.text) job.transcript += sc.outputTranscription.text;
          // All audio is in at generationComplete; turnComplete trails it by about the speaking time.
          if (sc.generationComplete || sc.turnComplete || sc.interrupted) {
            l.job = undefined;
            finish(job, !sc.interrupted);
          }
        }
        if (sc.turnComplete || sc.interrupted) l.turnOpen = false;
        pump();
      },
      () => {
        // Dropped mid-turn: resend once on a resumed session.
        l.turnOpen = false;
        const job = l.job;
        l.job = undefined;
        if (job && job.retried) fail(job, "Live dropped twice");
        else if (job && !job.cancelled) {
          job.retried = true;
          job.audio = [];
          job.transcript = "";
          queue.unshift(job);
        }
        pump();
      },
    );
    lanes.push(l);
    return l;
  }
  function fail(job: Job, message: string) {
    console.warn(`[voice] ${message}`);
    out({ type: "error", id: job.id, message, fallback: true });
  }

  function finish(job: Job, complete: boolean) {
    const match = normalize(job.transcript) === normalize(job.text);
    if (!match) console.warn(`[voice] transcript mismatch for ${job.id}: wanted "${job.text}" got "${job.transcript}"`);
    if (complete && match && job.audio.length) {
      const pcm = Buffer.concat(job.audio);
      mkdir(CACHE_DIR, { recursive: true })
        .then(() => writeFile(cachePath(job.text), pcm))
        .catch((e) => console.warn("[voice] cache write failed", e.message));
    }
    if (!job.cancelled) out({ type: "done", id: job.id, transcript: job.transcript, match, cached: false });
  }

  async function pump() {
    if (!queue.length) return;
    if (lanes.some((l) => l.job && !l.job.cancelled)) return; // in order: the next line waits for this one's audio
    let l = lanes.find((x) => !x.job && !x.turnOpen) ?? (lanes.length < POOL ? lane() : undefined);
    if (!l) {
      // turnComplete trails the audio by about the speaking time, so every session can be waiting on one. Rather than
      // wait, drop a session whose line is fully received (or cancelled) and start the line on a fresh connection.
      l = lanes.find((x) => !x.job) ?? lanes.find((x) => x.job?.cancelled);
      if (!l) return;
      l.job = undefined;
      l.up.close(true);
    }
    const job = (l.job = queue.shift()!);
    l.turnOpen = true;
    // Keep one spare session warm so a cancel never waits for a session to open.
    if (lanes.length < POOL && !lanes.some((x) => x !== l && !x.job && !x.turnOpen)) void lane().up.open().catch(() => {});
    try {
      await l.up.open();
    } catch (e) {
      if (l.job !== job) return fail(job, (e as Error).message); // this session was recycled for a newer line
      l.job = undefined;
      l.turnOpen = false;
      fail(job, (e as Error).message);
      for (const j of queue.splice(0)) fail(j, "Live unavailable");
      return;
    }
    if (l.job !== job) return; // recycled for a newer line while it opened
    if (job.cancelled) {
      // cancelled while the session opened: nothing was sent, so the turn never started
      l.job = undefined;
      l.turnOpen = false;
      return pump();
    }
    l.up.send({ clientContent: { turns: [{ role: "user", parts: [{ text: job.text }] }], turnComplete: true } });
  }

  async function say(id: string, text: string) {
    try {
      const pcm = await readFile(cachePath(text));
      for (let i = 0; i < pcm.length; i += 48000) out({ type: "audio", id, data: pcm.subarray(i, i + 48000).toString("base64") });
      out({ type: "done", id, transcript: text, match: true, cached: true });
      return;
    } catch {
      // not cached
    }
    queue.push({ id, text, audio: [], transcript: "", cancelled: false, retried: false });
    pump();
  }

  // ---- asker lane: push-to-talk with page context and tools ----
  let askId: string | undefined;
  let askMuted = false;
  let askEnded = false; // the key is released (activityEnd sent): the next transcription is the final one
  let askText = "";
  let heard = "";
  let heardSent = false;
  let askChain: Promise<unknown> = Promise.resolve();
  let turnOpen = false; // the asker's model turn for the last ask has not completed
  let stale = false; // that open turn belongs to an earlier ask: its follow-up after a tool call must not end this one
  let staleTimer: ReturnType<typeof setTimeout> | undefined;

  // The browser decides on these words first (Snap); send them once, at the earliest final moment.
  // Transcription can trail the model's first part, so an empty text waits unless the turn is over.
  const sendHeard = (final: boolean) => {
    if (heardSent || !askId || (!final && !heard.trim())) return;
    heardSent = true;
    out({ type: "heard", id: askId, text: heard.trim() });
  };

  const asker = new Upstream(
    () => liveSetup(askerRule(context), { tools: TOOLS, inputAudioTranscription: {} }),
    (m) => {
      const sc = m.serverContent;
      if (sc?.turnComplete || sc?.interrupted) turnOpen = false;
      // With manual activity the input transcription comes in one piece after activityEnd: it is final at once.
      if (sc?.inputTranscription?.text && askId && !heardSent) {
        heard += sc.inputTranscription.text;
        if (askEnded) sendHeard(true);
      }
      if (m.toolCall) {
        const calls = m.toolCall.functionCalls ?? [];
        asker.send({
          toolResponse: { functionResponses: calls.map((f: LiveMsg) => ({ id: f.id, name: f.name, response: { result: "done" } })) },
        });
        if (!askId || askMuted || stale || !askEnded) return;
        sendHeard(true); // before the command, so the browser can let Snap decide first
        for (const f of calls) out({ type: "command", id: askId, name: f.name, args: f.args ?? {} });
        out({ type: "done", id: askId, transcript: "", match: true, heard });
        askMuted = true; // the page speaks the confirmation; drop the model's own follow-up turn
        return;
      }
      if (!sc || !askId) return;
      if (stale || !askEnded) {
        // An earlier ask's turn is still finishing: none of it belongs to this ask.
        if (stale && (sc.turnComplete || sc.interrupted)) stale = false;
        return;
      }
      // Live rarely sets `finished`; a transcript ending in . ? or ! has been the complete sentence in practice.
      const over = !!(sc.inputTranscription?.finished || /[.?!]\s*$/.test(heard) || sc.generationComplete || sc.turnComplete || sc.interrupted);
      if (over || sc.modelTurn) sendHeard(over);
      if (askMuted) return;
      for (const p of sc.modelTurn?.parts ?? []) if (p.inlineData?.data) out({ type: "audio", id: askId, data: p.inlineData.data });
      if (sc.outputTranscription?.text) askText += sc.outputTranscription.text;
      if (sc.generationComplete || sc.turnComplete || sc.interrupted) {
        out({ type: "done", id: askId, transcript: askText, match: true, heard });
        askMuted = true;
      }
    },
    () => {
      turnOpen = stale = false;
      if (askId && !askMuted) {
        out({ type: "error", id: askId, message: "Live dropped during a question", fallback: false });
        askMuted = true;
      }
    },
  );

  // Early words: a transcription-only session hears the same audio. Its interim text goes out as heard_partial while
  // the key is held, and its final text is the "heard" when it beats the asker's own transcription. Best effort only:
  // when it fails, the asker's transcription is the only source, as before.
  let trUp = false;
  let trChain: Promise<unknown> = Promise.resolve();
  const tr = new Upstream(
    () => ({ setup: { model: `models/${TRANSCRIBE_MODEL}`, inputAudioTranscription: {}, realtimeInputConfig: { automaticActivityDetection: { disabled: true } } } }),
    (m) => {
      const sc = m.serverContent;
      if (!sc || !askId || heardSent || askMuted) return;
      const interim = sc.interimInputTranscription?.text;
      if (interim && !askEnded) out({ type: "heard_partial", id: askId, text: String(interim).trim() });
      const fin = sc.inputTranscription?.text;
      if (fin && askEnded && String(fin).trim()) {
        heard = String(fin);
        sendHeard(true);
      }
    },
    () => {},
    false,
  );
  let trDownAt = 0; // a failed open pauses this session for a minute instead of retrying on every audio chunk
  const trSend = (obj: object) => {
    if (!trUp || Date.now() - trDownAt < 60_000) return;
    trChain = trChain.then(() => tr.open()).then(() => tr.send(obj)).catch(() => (trDownAt = Date.now()));
  };

  // Ordered sends that wait for the asker session to be open.
  const askSend = (obj: object) => {
    askChain = askChain.then(() => asker.open()).then(() => asker.send(obj)).catch((e) => {
      if (askId && !askMuted) out({ type: "error", id: askId, message: (e as Error).message, fallback: false });
      askMuted = true;
    });
  };

  client.on("message", (data) => {
    let m: Msg;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return out({ type: "error", message: "bad json", fallback: false });
    }
    switch (m.type) {
      case "start":
        if (typeof m.context === "string" && m.context !== context) {
          context = m.context;
          asker.close(true); // system instruction is fixed per session: reopen with the new context
          askChain = Promise.resolve();
        }
        break;
      case "say":
        if (typeof m.id === "string" && typeof m.text === "string" && m.text.trim()) say(m.id, m.text.trim());
        else out({ type: "error", id: m.id as string, message: "say needs id and text", fallback: false });
        break;
      case "cancel":
        for (let i = queue.length - 1; i >= 0; i--) if (!m.id || queue[i].id === m.id) queue.splice(i, 1);
        for (const l of lanes) if (l.job && (!m.id || l.job.id === m.id)) l.job.cancelled = true; // keeps generating so the cache fills
        pump(); // the next line may start on another session now
        if (!m.id || m.id === askId) askMuted = true;
        break;
      case "ask_start":
        askId = String(m.id);
        askMuted = askEnded = false;
        askText = heard = "";
        heardSent = false;
        stale = turnOpen;
        clearTimeout(staleTimer);
        if (stale) staleTimer = setTimeout(() => (stale = false), 3000); // never let a lost turnComplete mute later asks
        if (!trUp) {
          trUp = true; // opened on the first ask, then kept warm
          trChain = tr.open().catch((e) => {
            trDownAt = Date.now();
            console.warn("[voice] transcription session unavailable:", (e as Error).message);
          });
        }
        trSend({ realtimeInput: { activityStart: {} } });
        askSend({ realtimeInput: { activityStart: {} } });
        break;
      case "ask_text":
        if (typeof m.id === "string" && typeof m.text === "string" && m.text.trim()) {
          askId = m.id;
          askMuted = false;
          askEnded = turnOpen = true;
          stale = false;
          askText = "";
          heard = m.text.trim();
          heardSent = true; // the browser already has these words
          askSend({ clientContent: { turns: [{ role: "user", parts: [{ text: heard }] }], turnComplete: true } });
        } else out({ type: "error", id: m.id as string, message: "ask_text needs id and text", fallback: false });
        break;
      case "ask_audio":
        if (typeof m.data === "string") {
          const audio = { realtimeInput: { audio: { data: m.data, mimeType: "audio/pcm;rate=16000" } } };
          trSend(audio);
          askSend(audio);
        }
        break;
      case "ask_end":
        askEnded = turnOpen = true;
        trSend({ realtimeInput: { activityEnd: {} } });
        askSend({ realtimeInput: { activityEnd: {} } });
        break;
      default:
        out({ type: "error", message: `unknown type ${m.type}`, fallback: false });
    }
  });

  client.on("close", () => {
    queue.length = 0;
    for (const l of lanes) l.up.close();
    clearTimeout(staleTimer);
    tr.close();
    asker.close();
  });
}
