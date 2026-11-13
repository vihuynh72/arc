// Relay check against the running server. `npx tsx scripts/try-voice.ts` says tour stop 1.
// `npx tsx scripts/try-voice.ts say <n>` says stop n.
// `npx tsx scripts/try-voice.ts ask <file.pcm>` sends 16 kHz PCM16 as push-to-talk.
// `npx tsx scripts/try-voice.ts asktext "<question>"` sends a typed question (ask_text) and prints audio timing, transcript and any command.
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { stopLine } from "../lib/cues";
import type { Tour } from "../lib/types";

const URL = process.env.VOICE_URL ?? "ws://localhost:3000/ws/voice";
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const [mode, file] = process.argv.slice(2);
const tour: Tour = JSON.parse(readFileSync("fixtures/lower/tour-final.json", "utf8"));
const text = stopLine(tour.stops, mode === "say" ? Number(file) - 1 : 0); // `say <n>` picks stop n
const context = `${tour.title}. ${tour.overview} ${tour.stops.map((s) => `${s.label}: ${s.says}`).join(" ")} Sections: Introduction, Methods, Results, Discussion.`;

const ws = new WebSocket(URL);
const t0 = Date.now();
let first = 0;
let bytes = 0;
let last = 0;
const timeout = setTimeout(() => {
  console.error("FAIL: timeout");
  process.exit(1);
}, 40000);

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "start", context }));
  if (mode === "asktext") ws.send(JSON.stringify({ type: "ask_text", id: "t1", text: file }));
  else if (mode === "ask") {
    const pcm = readFileSync(file);
    ws.send(JSON.stringify({ type: "ask_start", id: "q1" }));
    for (let i = 0; i < pcm.length; i += 3200) ws.send(JSON.stringify({ type: "ask_audio", data: pcm.subarray(i, i + 3200).toString("base64") }));
    ws.send(JSON.stringify({ type: "ask_end" }));
  } else ws.send(JSON.stringify({ type: "say", id: "s1", text }));
});

ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === "audio") {
    first ||= Date.now() - t0;
    last = Date.now() - t0;
    bytes += Buffer.from(m.data, "base64").length;
    return;
  }
  console.log(JSON.stringify(m));
  if (m.type === "error") process.exit(1);
  if (m.type === "command" || m.type === "done") {
    const secs = bytes / 48000; // 24 kHz * 2 bytes
    console.log(`first audio ${first} ms, last audio ${last} ms, audio ${secs.toFixed(2)} s, total ${Date.now() - t0} ms`);
    if (mode !== "ask" && mode !== "asktext") {
      const ok = secs > 1 && norm(m.transcript) === norm(text);
      console.log(ok ? `PASS (cached: ${m.cached})` : "FAIL");
      process.exit(ok ? 0 : 1);
    }
    if (m.type === "done" || (mode === "asktext" && m.type === "command")) {
      clearTimeout(timeout);
      ws.close();
    }
  }
});
