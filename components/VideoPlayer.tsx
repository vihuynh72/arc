"use client";
// The video twin's player and its two ways to follow a video, mounted by components/Twin.tsx.
//   Original audio: the real video plays (YouTube IFrame API). At the end of a part that has an on-screen description the video
//   is paused, the description is spoken in the reading voice, and the video resumes. Arc never speaks while it plays.
//   Read to me: the video stays paused and muted; Arc reads each part (heading, words, what is on screen).
// Keys and buttons come from components/Reader.tsx: it moves the cursor ("arc:cursor" with read: true means the student chose
// a part), repeats ("arc:replay") and sends P, V and Escape as "arc:video". The media keys (K, J, L, < and >, a Space tap) are
// handled here: Reader leaves them alone (lib/keys.ts). Feedback never talks over the lecturer: a tick while the video plays,
// a few words when it is paused. Nothing here writes to an aria-live region or moves focus.
import { useEffect, useRef, useState } from "react";
import { speaker, splitSentences } from "@/lib/client/reader";
import { answering, tick as beep } from "@/lib/client/voice";
import { dueAt, type Late, midSentence, PICTURE_LINE, saidBefore, saidTime, screenAt, screenLines, segmentsOf, segSpeech, watchVideo, where, worthSaying } from "@/lib/client/video";
import { heard } from "@/lib/client/heard";
import { cue, GREETING } from "@/lib/keys";
import { isPublic, updatePlace } from "@/lib/client/place";
import { inputStyle } from "@/lib/client/command";
import { loadYouTube, YT_BUFFERING, YT_ENDED, YT_PAUSED, YT_PLAYING, type YTPlayer } from "@/lib/client/youtube";
import type { Twin, TwinNode } from "@/lib/types";

type Mode = "orig" | "read";
type Props = { twin: Twin; onEnrich: (late: Late) => void; onTour: (node: TwinNode) => void; startAt?: number }; // startAt: a reload put the lecture back at this second

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const TAP_MS = 300; // a Space press shorter than this is a tap (play or pause); longer is push-to-talk. Same as components/AskButton.tsx
/** The end of the lecture, and what can be done next. */
const endLine = () =>
  `That is the end of the lecture. ${cue(inputStyle(), "Say play to hear it again from the start, say read it to me, or ask me about it.", "Press P to play it again from the start, V to have me read it, or hold Space to ask about it.")}`;
/** Down on the last part: where that leaves the student. */
// After a pause the student asked for: how to carry on, in their own way of working.
const pausedLine = () => cue(inputStyle(), "Paused. Say go on when you are ready.", "Paused. Press P to carry on.", "Paused. Say go on, or press P, to carry on.");
const lastLine = () => `That is the last part. ${cue(inputStyle(), "Say back to go to the one before, or ask me about the lecture.", "Press Up for the one before, P to play, or hold Space to ask about the lecture.")}`;
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]; // the speeds the player offers
const MINE_MS = 1500; // a pause this soon after one Arc made is Arc's; a later one is the student's own click on the player
const LEAD_S = 0.25; // a description's pause is asked for this much (in lecture seconds at 1x) before the sentence ends: the player takes about that long to stop
const AGAIN_S = 30; // the video moved back further than this (the player's own bar): the part's description is due again; a 10 s rewind is not

export default function VideoPlayer({ twin, onEnrich, onTour, startAt }: Props) {
  const id = twin.video!.id; // Twin mounts this only for video twins
  const enriched = twin.video!.enriched;
  const [url, keep] = [twin.source.url, isPublic(twin.source)];
  const host = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>("orig");
  const [ready, setReady] = useState(enriched);
  const [problem, setProblem] = useState("");
  const enrich = useRef(onEnrich);
  const tour = useRef(onTour);
  const live = useRef({
    segs: [] as TwinNode[], nodes: [] as TwinNode[], mode: "orig" as Mode, cur: -1, want: false, p: null as YTPlayer | null,
    describing: false, desc: 0, reading: false, read: 0, held: false, heldAt: 0, resume: false, ask: 0,
    said: new Map<string, string>(), rpart: null as { j: number; lines: string[]; k: number } | null, rpaused: false, rcut: -1e9, wasReading: false, wasDescribing: false,
    last: startAt ?? 0, saved: 0, // last: the lecture's clock when last seen (the second a rebuilt player starts at), saved: when it was last written to the tab's place
    described: new Set<string>(), asked: new Set<string>(), over: enriched, at: "", wake: () => {}, framed: new Set<string>(), pictured: new Set<string>(), wanted: "", pausedAt: 0, durSent: false, // over: the server has nothing more to add
    t: -1, ending: false, // t: the lecture's clock at the last poll; ending: the end-of-lecture line is being said
  });
  useEffect(() => {
    enrich.current = onEnrich;
    tour.current = onTour;
    const L = live.current;
    const here = L.segs[L.cur]?.id;
    watchVideo(twin);
    L.nodes = twin.nodes;
    L.segs = segmentsOf(twin.nodes);
    if (here) L.cur = L.segs.findIndex((n) => n.id === here); // parts that arrived before it renumber it, it stays on the same part
  });

  useEffect(() => {
    // The start page's greeting is not for a video that has opened: if it is still being said, it stops.
    if (speaker.busy && speaker.recent.at(-1)?.text === GREETING) speaker.cancel();
    return () => watchVideo(null);
  }, []);

  // The player, the poll that follows the video, and every key and button path.
  useEffect(() => {
    const L = live.current;
    let dead = false;
    const state = () => L.p?.getPlayerState();
    // After pauseVideo the player still says "playing" for a moment; nothing is asked of the voice until it has stopped.
    const stopped = async () => {
      for (let k = 0; k < 25 && (state() === YT_PLAYING || state() === YT_BUFFERING); k++) await sleep(40);
    };
    const quiet = async () => {
      for (let k = 0; k < 40 && speaker.busy; k++) await sleep(150);
    };
    const arcPause = () => {
      L.pausedAt = Date.now();
      L.p?.pauseVideo();
    };
    // A video that never played ignores seekTo until it starts, so it is told where to start first.
    const play = () => {
      const s = state();
      const n = L.segs[Math.max(L.cur, 0)];
      if ((s === -1 || s === 5) && n) L.p?.seekTo(L.cur < 0 && L.last >= 1 ? L.last : (n.start as number), true); // a reload put it at L.last: play from there
      L.p?.playVideo();
    };
    const seekTo = (s: number) => {
      L.p?.seekTo(s, true);
      if (!L.want) arcPause(); // seeking a video that never played starts it
    };
    // The server describes this part next. Once per part; nothing to ask when the video is already complete.
    const post = (body: object) => void fetch("/api/video/shown", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ...body }) }).catch(() => {});
    // A part with a description and no picture yet: the server takes its picture next (about 3 s). Once per part.
    const wantFrame = (n: TwinNode) => {
      if (n.image || !worthSaying(n) || L.framed.has(n.id)) return;
      L.framed.add(n.id);
      post({ node: n.id, frame: true });
      L.wake();
    };
    const prioritise = (n: TwinNode) => {
      wantFrame(n);
      if (L.over || n.shown || L.asked.has(n.id)) return;
      L.asked.add(n.id);
      post({ node: n.id });
    };
    // A time with no part yet: the server does that window next. Once per 30 s window.
    const askAt = (t: number) => {
      const key = `at${Math.floor(t / 30)}`;
      if (L.over || L.asked.has(key)) return;
      L.asked.add(key);
      post({ at: Math.round(t) });
    };
    // Cursor to a part without speaking; the page scrolls only when the student has not scrolled lately (Reader).
    const show = (i: number) => {
      const n = L.segs[i];
      if (!n) return;
      L.cur = i;
      window.dispatchEvent(new CustomEvent("arc:command", { detail: { name: "goto", args: { id: n.id, silent: true, follow: true } } }));
      prioritise(n);
    };
    const after = (f: () => void) => void setTimeout(f, 0); // after Reader has cut the voice for this key
    // Feedback for a control: a tick while the video plays (words would talk over the lecturer), words when it is paused.
    // The end-of-lecture line is said again after a speed change cut it.
    const feel = (words: string[], hz = 800) =>
      after(() => (L.want && L.mode === "orig" ? beep(hz, 70, 0.06) : void speaker.say(L.ending ? [...words, endLine()] : words).then((ok) => ok && (L.ending = false))));
    const halt = () => {
      L.ending = false;
      L.rpaused = false;
      L.desc++;
      L.describing = false;
      L.read++;
      L.reading = false;
      L.ask++;
    };

    const describe = async (i: number) => {
      const n = L.segs[i];
      L.described.add(n.id);
      const all = screenLines(n.shown!, saidBefore(L.said, L.segs, n));
      const lines = midSentence(L.segs, i) ? all.slice(0, 1) : all; // stopping inside a sentence: say less
      if (!lines.length) return; // it adds nothing to what was said: the lecturer is not stopped for it
      const mine = ++L.desc;
      L.describing = true;
      for (let k = 0; k < 3; k++) {
        arcPause();
        await stopped();
        if (mine !== L.desc) return;
        if (state() !== YT_PLAYING && state() !== YT_BUFFERING) break;
      }
      if (state() === YT_PLAYING || state() === YT_BUFFERING) {
        // It will not stop: never speak over the lecturer. The part is due again on the next poll.
        L.describing = false;
        L.described.delete(n.id);
        return;
      }
      L.said.set(n.id, n.shown!);
      const ok = await speaker.say(lines);
      if (mine !== L.desc) return; // a key took over and decides what plays
      if (!ok) await quiet(); // another line cut this one: wait for it before the lecturer comes back
      if (mine !== L.desc) return;
      L.describing = false;
      if (L.want && L.mode === "orig" && !L.held) {
        play();
        // The player sometimes drops the first play (seen with two players loading at once): look again, twice.
        for (let k = 0; k < 2; k++) {
          await sleep(1500);
          if (mine !== L.desc || !L.want || L.mode !== "orig" || L.held || state() === YT_PLAYING || state() === YT_BUFFERING) break;
          play();
        }
      }
    };

    // The lecture's clock is kept in this tab (lib/client/place.ts), so a reload puts the lecture back where it was, paused.
    const flush = () => void (keep && L.last >= 1 && updatePlace(url, { t: Math.floor(L.last) }));
    const tick = () => {
      const pl = L.p;
      if (!pl) return;
      if (L.mode === "orig" && (state() === YT_PLAYING || state() === YT_PAUSED)) {
        L.last = pl.getCurrentTime();
        if (Date.now() - L.saved > 3000) {
          L.saved = Date.now();
          flush();
        }
      }
      if (!L.durSent && !L.over) {
        const d = pl.getDuration();
        if (d > 0) {
          L.durSent = true;
          post({ duration: Math.round(d) });
        }
      }
      if (L.mode !== "orig" || L.describing || L.held) return;
      const t = pl.getCurrentTime();
      const back = L.t - t > AGAIN_S;
      L.t = t;
      const lead = LEAD_S * (pl.getPlaybackRate() || 1);
      let i = -1;
      L.segs.forEach((n, k) => void ((n.start as number) <= t + 0.05 && (i = k)));
      // No part holds this time yet (the transcript is still arriving): the lecturer needs no transcript, so only the server is told.
      if (i < 0 || t > (L.segs[i].end as number) + 2) return askAt(t);
      if (state() !== YT_PLAYING) return;
      const here = L.segs[L.cur];
      const owed = !!here && worthSaying(here) && !L.described.has(here.id);
      // A description starts where the lecturer's sentence ends (dueAt): a part the model cut mid-sentence waits for the next part's first sentence.
      if (i !== L.cur) {
        if (owed && i === L.cur + 1) return t >= dueAt(L.segs, L.cur) - lead ? void describe(L.cur) : undefined; // crossed into the next part: still owed, or held
        if (back) L.described.delete(L.segs[i].id); // the student moved the video well back: this part's description is due again
        return show(i);
      }
      if (owed && t >= dueAt(L.segs, i) - lead) void describe(i);
    };

    // The student chose part i (a key, a click, a command).
    const go = (i: number) => {
      const n = L.segs[i];
      if (!n) return;
      const was = L.cur;
      halt();
      L.cur = i;
      L.described.delete(n.id);
      prioritise(n);
      if (L.mode === "read") return void readFrom(i);
      seekTo(n.start as number);
      if (L.want) {
        play();
        after(() => beep(i < was ? 520 : 820, 70, 0.06)); // moved while the lecturer plays: a tick, lower for back
      } else {
        // Paused: say where it landed, once the seek has settled.
        const mine = L.desc;
        void stopped().then(() => mine === L.desc && speaker.say([L.over ? `Part ${i + 1} of ${L.segs.length}.` : `Part ${i + 1}.`, where(n)]));
      }
    };

    // Read parts aloud one after another until something else happens. A part that has not arrived yet is waited for.
    // `chunk`: carry on at that line of part i (a paused reading). The part the student chose is read in full; the parts after it
    // say only what is new about the screen.
    const readFrom = async (i: number, lead?: string, chunk = 0) => {
      halt();
      const mine = L.read;
      L.reading = true;
      const again = chunk > 0 && L.rpart?.j === i ? L.rpart.lines : null;
      await stopped();
      let first = lead ? [lead] : [];
      for (let j = i; mine === L.read; j++) {
        if (!L.segs[j]) {
          if (L.over) {
            if (j > 0) void speaker.say([...first, endLine()]);
            break;
          }
          askAt(L.segs[j - 1]?.end ?? 0);
          const ok = await speaker.say([...first, "Getting that part."]);
          first = [];
          for (let k = 0; ok && k < 400 && mine === L.read && !L.segs[j] && !L.over; k++) await sleep(300);
          if (mine !== L.read) break;
          if (!L.segs[j]) {
            if (ok) void speaker.say(["That part is not ready yet. Try again in a moment."]);
            break;
          }
        }
        if (j !== L.cur) show(j);
        const seg = L.segs[j];
        const tell = !!seg.image && !L.pictured.has(seg.id); // said once per part, and only here: the lecturer is never talked over
        const lines = (j === i && again) || [...first, ...segSpeech(seg, j === i ? undefined : saidBefore(L.said, L.segs, seg)), ...(tell ? [PICTURE_LINE] : [])];
        const from = j === i && again ? chunk : 0;
        L.rpart = { j, lines, k: from };
        const ok = await speaker.say(lines.slice(from), (k) => void (L.rpart = { j, lines, k: from + k }));
        if (ok && tell) L.pictured.add(seg.id);
        if (ok && worthSaying(seg)) L.said.set(seg.id, seg.shown!);
        first = [];
        if (!ok || mine !== L.read) {
          // Cut by something else (a key, a question): P carries on from this line.
          if (!ok && mine === L.read) [L.rpaused, L.rcut] = [true, performance.now()];
          break;
        }
      }
      if (mine === L.read) L.reading = false;
    };

    const switchMode = () => {
      halt();
      L.want = false;
      arcPause();
      const next: Mode = L.mode === "orig" ? "read" : "orig";
      L.mode = next;
      setMode(next);
      const i = Math.max(L.cur, 0);
      if (next === "read") {
        L.p?.mute();
        void readFrom(i, "Reading to you.");
      } else {
        L.p?.unMute();
        if (L.segs[i]) seekTo(L.segs[i].start as number);
        void stopped().then(() => speaker.say(["Original audio. Press P to play."]));
      }
    };

    const pauseReading = () => {
      halt();
      speaker.cancel();
      L.rpaused = true;
      after(() => void speaker.say([pausedLine()]));
    };
    // P, K and a Space tap. Read to me: pause, and carry on at the line where it stopped. Original audio: pause or play.
    const toggle = () => {
      L.ask++;
      if (L.mode === "read") {
        if (L.reading) pauseReading();
        else if (L.rpaused && L.rpart) void readFrom(L.rpart.j, undefined, L.rpart.k);
        else void readFrom(Math.max(L.cur, 0));
      } else if (L.describing) {
        halt(); // skip the description and carry on
        L.want = true;
        play();
        feel([]);
      } else if (state() === YT_PLAYING) {
        const t = L.p!.getCurrentTime();
        L.want = false;
        arcPause();
        feel([`Paused at ${saidTime(t)}.`]);
      } else {
        L.want = true;
        play();
        feel([]);
      }
    };

    // J and L: ten seconds back or forward. In Read to me they are the previous and next part.
    const skip = (by: number) => {
      L.ask++;
      if (L.mode === "read") {
        const i = Math.min(Math.max(L.cur + Math.sign(by), 0), L.segs.length - 1);
        if (i === L.cur && by > 0 && L.over) return void after(() => void speaker.say([lastLine()]));
        if (i === L.cur && by < 0) return void after(() => void speaker.say(["That is the first one."]));
        show(i);
        return go(i);
      }
      const pl = L.p;
      if (!pl) return;
      const was = L.describing;
      if (was) {
        halt();
        L.want = true;
      }
      const to = Math.min(Math.max(pl.getCurrentTime() + by, 0), Math.max(0, (pl.getDuration() || 1e9) - 1));
      seekTo(to);
      if (L.want) play();
      feel([`${by < 0 ? "Back" : "Forward"} ${Math.abs(by)} seconds. At ${saidTime(to)}.`], by < 0 ? 520 : 820);
    };

    // < and >: the video's speed and Arc's reading speed, one step each. Said when paused; while it plays the lecturer's own pace shows it.
    const faster = (dir: 1 | -1) => {
      const was = L.p?.getPlaybackRate() ?? 1;
      const next = (dir > 0 ? RATES.find((r) => r > was + 1e-6) : [...RATES].reverse().find((r) => r < was - 1e-6)) ?? was;
      L.p?.setPlaybackRate(next);
      const before = speaker.rate;
      const voice = speaker.setRate(before + dir * 0.1);
      const limit = next === was && voice === before;
      const words = limit ? `That is the ${dir > 0 ? "fastest" : "slowest"}.` : L.mode === "read" ? `Reading speed ${voice.toFixed(1)}.` : `Video speed ${next}. Reading speed ${voice.toFixed(1)}.`;
      rated(words, dir > 0 ? 900 : 450, cutRead());
    };
    // A speed change while Arc reads the lecture cuts its line (the key, or the Space of a spoken "faster"): the new speed, then
    // the reading carries on from the line it was on. The read token at the change; -1 when nothing was being read.
    const cutRead = () => (L.mode === "read" && (L.reading || (L.wasReading && L.rpaused)) ? L.read : -1);
    const rated = (line: string, hz: number, mine: number) =>
      mine < 0 ? feel([line], hz) : after(() => void speaker.say([line]).then((ok) => ok && mine === L.read && L.rpart && void readFrom(L.rpart.j, undefined, L.rpart.k)));
    // The existing speed keys and commands change Arc's voice (Reader): the video follows by one step the same way.
    const follow = (before: number, normal = false, dir: 1 | -1 = 1, mine = cutRead()) =>
      after(() => {
        const now = speaker.rate;
        const was = L.p?.getPlaybackRate() ?? 1;
        // The rate set, not read back: the player reports the new one only a moment later.
        const v = normal ? 1 : now !== before ? ((now > before ? RATES.find((r) => r > was + 1e-6) : [...RATES].reverse().find((r) => r < was - 1e-6)) ?? was) : was;
        if (v !== was) L.p?.setPlaybackRate(v);
        // Paused: the speed in words. Playing: a tick (words would talk over the lecturer).
        const up = normal ? 1 : now !== before ? Math.sign(now - before) : dir;
        const line = !normal && now === before ? `That is the ${up > 0 ? "fastest" : "slowest"}.` : L.mode === "read" ? `Reading speed ${now.toFixed(1)}.` : `Video speed ${v}. Reading speed ${now.toFixed(1)}.`;
        rated(line, up > 0 ? 900 : 450, mine);
      });

    const stop = () => {
      halt();
      speaker.cancel();
      L.want = false;
      arcPause();
    };

    // A Space tap (AskButton opened and discarded its microphone; onDown has paused the video if it played): play or pause.
    const tapped = () => {
      const resume = L.resume;
      L.resume = false;
      if (L.mode === "read") {
        if (L.wasReading) return pauseReading(); // it was reading: AskButton cut it at the key down
        return void (L.rpaused && L.rpart ? readFrom(L.rpart.j, undefined, L.rpart.k) : readFrom(Math.max(L.cur, 0)));
      }
      if (L.wasDescribing) {
        // A tap pauses, always: the description was cut and the lecture stays where it is until P.
        L.want = false;
        return void after(() => void speaker.say([`Paused at ${saidTime(L.p?.getCurrentTime() ?? 0)}.`]));
      }
      if (resume) {
        const t = L.p?.getCurrentTime() ?? 0; // it was playing: it stays paused
        L.want = false;
        return feel([`Paused at ${saidTime(t)}.`]);
      }
      L.want = true;
      play();
      feel([]);
    };

    // Hold Space to ask: the video waits, then carries on once the answer has been heard.
    const afterAsk = async () => {
      const mine = ++L.ask;
      const tap = performance.now() - L.heldAt < TAP_MS; // a tap is play or pause, not a question
      if (tap) return tapped();
      const t0 = performance.now();
      let spoke = false;
      let still = 0;
      while (!tap) {
        await sleep(250);
        if (mine !== L.ask || L.held) return;
        if (speaker.busy || answering()) [spoke, still] = [true, 0];
        else if ((still += 1) >= 2 && (spoke || performance.now() - t0 > 6000)) break;
      }
      if (L.resume && L.want && L.mode === "orig") play();
      L.resume = false;
      L.wasReading = false; // this ask is over: a later speed key does not bring back a reading it cut
    };

    const onVideo = (e: Event) => {
      const a = (e as CustomEvent<string>).detail;
      if (a === "toggle") toggle();
      else if (a === "mode") switchMode();
      else if (a === "stop") stop();
      else if (a === "resume") {
        // "go on": carry on if paused; while it is already playing or reading, nothing (a toggle would pause it: the opposite).
        if (L.mode === "read" ? !L.reading : state() !== YT_PLAYING) toggle();
      } else if (a === "hold") {
        // Twin.startTour on a video part: the video waits, and stays paused after the tour.
        halt();
        L.want = false;
        arcPause();
      } else if (a === "more") {
        // Down on the last known part: say so only when nothing more is coming.
        if (L.over) void speaker.say([lastLine()]);
        else {
          askAt(L.segs[L.segs.length - 1]?.end ?? 0);
          void speaker.say(["Getting the next part."]);
        }
      }
    };
    const onCursor = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; read?: boolean }>).detail;
      if (d?.id) L.at = d.id;
      if (!d?.read) return;
      const at = L.nodes.find((n) => n.id === d.id);
      const i = L.segs.findIndex((n) => n.id === d.id || (!!at && n.order > at.order)); // a heading goes to its first part
      if (i >= 0) go(i);
    };
    const onReplay = (e: Event) => {
      const i = L.segs.findIndex((n) => n.id === (e as CustomEvent<{ id: string }>).detail?.id);
      const n = L.segs[i >= 0 ? i : L.cur];
      if (!n) return;
      if (L.mode === "read") return void go(i >= 0 ? i : L.cur);
      halt();
      L.cur = L.segs.indexOf(n);
      L.described.delete(n.id);
      L.want = true;
      seekTo(n.start as number);
      play();
      feel([], 700);
    };
    // "What is on the screen right now?" (command "screen"): answered at once from the descriptions, with no model.
    const screen = async () => {
      const mine = ++L.ask; // this answer decides whether the video carries on
      const was = L.resume || (L.want && L.mode === "orig" && state() === YT_PLAYING);
      L.resume = false;
      if (state() === YT_PLAYING || state() === YT_BUFFERING) {
        arcPause();
        await stopped();
      }
      if (mine !== L.ask) return;
      // The time now (after the pause, or the student's question would be about a moment later): the screen as it is then.
      const t = L.p?.getCurrentTime() ?? 0;
      let i = L.mode === "orig" ? L.segs.reduce((a, n, k) => ((n.start as number) <= t + 0.05 ? k : a), -1) : L.cur;
      if (i < 0) i = Math.max(L.cur, 0);
      const n = L.segs[i];
      const s = L.mode === "orig" ? screenAt(L.segs, t) : -1;
      const src = s >= 0 ? L.segs[s] : [n, L.segs[i - 1]].find((x) => !!x && worthSaying(x));
      let lines: string[];
      if (src) {
        lines = [...splitSentences(src.shown!), ...(src.image ? ["There is a picture of it. Press Enter to explore it."] : [])];
        if (src.image) show(L.segs.indexOf(src)); // Enter explores this picture
      } else {
        lines = ["Nothing has been described for this part yet. I am getting a picture."];
        if (n) {
          L.wanted = n.id;
          L.framed.add(n.id);
          post({ node: n.id, frame: true });
          L.wake();
        }
      }
      if (!(await speaker.say(lines)) || mine !== L.ask) return;
      if (src?.image) L.want = false; // stays paused: P carries on, Enter explores
      else if (was && L.want && L.mode === "orig" && !L.held) play();
    };
    const onCommand = (e: Event) => {
      const d = (e as CustomEvent<{ name: string; args?: { normal?: boolean } }>).detail;
      if (d?.name === "stop") {
        // Asked in words, so answered in words, as on a page: silence alone does not say it was heard, or how to carry on.
        if (L.mode === "read" && (L.reading || L.wasReading)) return pauseReading();
        const playing = state() === YT_PLAYING || L.resume;
        stop();
        if (playing) after(() => void speaker.say([pausedLine()]));
      } else if (d?.name === "screen") void screen();
    };
    // Before Reader changes Arc's voice for "faster" and "slower" (capture): the video follows by one step the same way.
    const onSpeed = (e: Event) => {
      const d = (e as CustomEvent<{ name: string; args?: { normal?: boolean } }>).detail;
      // A figure tour (a lecture's still frame) owns the moment: it answers the speed itself, and the video stays as it is.
      if ((d?.name === "faster" || d?.name === "slower") && !document.querySelector("[data-tour]")) follow(speaker.rate, !!d.args?.normal, d.name === "faster" ? 1 : -1);
    };
    // The media keys, before Reader's own handler (capture): K pause, J and L ten seconds, < and > speed. + and - are Reader's; the video follows them.
    const onMedia = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || t?.closest?.("input, textarea, select, [contenteditable='true'], dialog") || document.querySelector("[data-tour]")) return;
      const k = e.key.toLowerCase();
      if (k === "k") toggle();
      else if (k === "j") skip(-10);
      else if (k === "l") skip(10);
      else if (e.key === "<" || e.key === ">") faster(e.key === ">" ? 1 : -1);
      else if (["+", "=", "-", "_"].includes(e.key)) return follow(speaker.rate, false, e.key === "+" || e.key === "=" ? 1 : -1);
      else return;
      e.preventDefault();
    };
    // "tour" and "picture" on a part: Reader's tour only knows figures (it would say "no figures"), so these are answered first.
    const onPicture = (e: Event) => {
      const d = (e as CustomEvent<{ name: string; args?: { figure?: unknown } }>).detail;
      if ((d?.name !== "tour" && d?.name !== "picture") || d.args?.figure != null || document.querySelector("[data-tour]")) return;
      const n = L.segs.find((x) => x.id === L.at);
      if (!n) return;
      if (d.name === "tour" && !n.image) return;
      e.stopImmediatePropagation();
      if (n.image) return void tour.current(n); // "show me the picture" on a part that has one: the tour is how Arc shows it
      if (!worthSaying(n)) return void speaker.say(["There is no picture for this part."]);
      L.wanted = n.id; // announced once it arrives (the effect below)
      if (!L.framed.has(n.id)) wantFrame(n);
      else {
        post({ node: n.id, frame: true });
        L.wake();
      }
      void speaker.say(["Getting the picture."]);
    };
    const onSeek = (e: Event) => {
      const s = (e as CustomEvent<number>).detail;
      if (Number.isFinite(s)) seekTo(s);
    };
    const onDown = (e: KeyboardEvent) => {
      // AskButton has already handled this Space and called preventDefault: a question has started.
      if (e.key !== " " || !e.defaultPrevented || e.repeat || L.held) return;
      L.held = true;
      L.heldAt = performance.now();
      L.resume = L.want && L.mode === "orig";
      L.wasDescribing = L.describing;
      L.wasReading = L.reading || performance.now() - L.rcut < 150; // AskButton has cut the voice already
      L.desc++;
      L.describing = false;
      if (L.resume) arcPause();
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key !== " " || !L.held) return;
      L.held = false;
      void afterAsk();
    };
    window.addEventListener("arc:video", onVideo);
    window.addEventListener("arc:cursor", onCursor);
    window.addEventListener("arc:replay", onReplay);
    window.addEventListener("arc:command", onCommand);
    window.addEventListener("arc:command", onPicture, true);
    window.addEventListener("arc:command", onSpeed, true);
    window.addEventListener("arc:seek", onSeek);
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("keydown", onMedia, true);
    window.addEventListener("pagehide", flush);
    const timer = setInterval(tick, 100);

    void loadYouTube()
      .then((YT) => {
        if (dead || !host.current) return;
        const el = document.createElement("div"); // the player replaces this element; React never owns it
        host.current.append(el);
        const pl = new YT.Player(el, {
          videoId: id,
          width: "100%",
          height: "100%",
          playerVars: { playsinline: 1, rel: 0, origin: location.origin, ...(L.last >= 1 && { start: Math.floor(L.last) }) },
          events: {
            // The player's methods exist only from here on; a P pressed before this plays the moment it is ready.
            onReady: () => {
              L.p = pl;
              if (L.mode === "read") pl.mute();
              else if (L.want) play();
            },
            onStateChange: (e) => {
              if (e.data >= 0 && e.data <= 3) heard({ kind: "lecture", state: e.data === YT_PLAYING ? "playing" : "paused", at: pl.getCurrentTime() }); // buffering is silent too
              if (e.data === YT_PLAYING) {
                L.want = true;
                // The student started the video with the player's own button: they want the lecturer, not Arc reading.
                if (L.mode === "read") {
                  halt();
                  speaker.cancel();
                  L.mode = "orig";
                  setMode("orig");
                  L.p?.unMute();
                }
              } else if (e.data === YT_PAUSED && Date.now() - L.pausedAt > MINE_MS && !L.describing && !L.held) L.want = false;
              else if (e.data === YT_ENDED) {
                L.want = false;
                if (L.mode === "orig" && !L.held) {
                  L.ending = true;
                  void speaker.say([endLine()]).then((ok) => ok && (L.ending = false));
                }
              }
            },
            onError: () => setProblem("This video cannot be played here."),
          },
        });
      })
      .catch(() => {
        if (dead) return;
        setProblem("The video player did not load, so Arc reads the video to you.");
        L.mode = "read";
        setMode("read");
      });

    return () => {
      dead = true;
      clearInterval(timer);
      window.removeEventListener("arc:video", onVideo);
      window.removeEventListener("arc:cursor", onCursor);
      window.removeEventListener("arc:replay", onReplay);
      window.removeEventListener("arc:command", onCommand);
      window.removeEventListener("arc:command", onPicture, true);
      window.removeEventListener("arc:command", onSpeed, true);
      window.removeEventListener("arc:seek", onSeek);
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("keydown", onMedia, true);
      window.removeEventListener("pagehide", flush);
      halt();
      try {
        L.p?.destroy();
      } catch {}
      L.p = null;
    };
  }, [id, enriched, url, keep]);

  // A picture the student asked for has arrived: said once, and only into silence (never over the lecturer or another line).
  useEffect(() => {
    const L = live.current;
    const t = setInterval(() => {
      if (!L.wanted || !L.nodes.find((n) => n.id === L.wanted)?.image || speaker.busy || L.describing || L.p?.getPlayerState() === YT_PLAYING) return;
      L.wanted = "";
      void speaker.say(["The picture is ready. Press Enter to explore it."]);
    }, 700);
    return () => clearInterval(t);
  }, []);

  // Pictures arrive for a few minutes after a video opens, and for 30 s after each one the student asks for. Merged quietly.
  useEffect(() => {
    const L = live.current;
    let on = true;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let until = Date.now() + 180_000;
    const poll = async () => {
      timer = undefined;
      busy = true;
      let stop = false;
      try {
        const r = await fetch(`/api/video/shown?id=${encodeURIComponent(id)}`);
        if (r.ok) {
          const d = (await r.json()) as Late & { noFrames?: string };
          if (!on) return;
          if (d.frames) enrich.current({ frames: d.frames });
          stop = !!d.noFrames; // this video gives no pictures: nothing more to wait for
        }
      } catch {
        // offline for a moment: the next poll tries again
      }
      busy = false;
      if (on && !stop && Date.now() < until) timer = setTimeout(poll, 3000);
    };
    L.wake = () => {
      until = Math.max(until, Date.now() + 30_000);
      if (on && !busy && !timer) void poll();
    };
    void poll();
    return () => {
      on = false;
      clearTimeout(timer);
      L.wake = () => {};
    };
  }, [id]);

  // Headings and descriptions arriving late: merged into the page quietly. One short line when all are ready, and only into silence.
  useEffect(() => {
    if (enriched) return;
    const L = live.current;
    let on = true;
    let timer: ReturnType<typeof setTimeout>;
    let polls = 0;
    const announce = async () => {
      for (let k = 0; k < 120 && on; k++) {
        const s = L.p?.getPlayerState();
        if (!speaker.busy && !answering() && !L.describing && !L.want && s !== YT_PLAYING && s !== YT_BUFFERING) return void speaker.say(["Descriptions are ready."]);
        await sleep(500);
      }
    };
    const poll = async () => {
      try {
        const r = await fetch(`/api/video/shown?id=${encodeURIComponent(id)}`);
        if (r.status === 404) return void (L.over = true); // the server has nothing to add
        if (r.ok) {
          const d = (await r.json()) as Late & { done?: boolean };
          if (!on) return;
          enrich.current(d);
          if (d.done) {
            L.over = true;
            setReady(true);
            return void announce();
          }
        }
      } catch {
        // offline for a moment: the next poll tries again
      }
      if (on && ++polls < 900) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      on = false;
      clearTimeout(timer);
    };
  }, [id, enriched]);

  return (
    <div className="video">
      <div className="video-frame" ref={host} />
      <p className="video-state">
        {mode === "orig" ? "Original audio" : "Read to me"}. {ready ? "On-screen descriptions are ready." : "Writing on-screen descriptions."} {problem}
      </p>
    </div>
  );
}
