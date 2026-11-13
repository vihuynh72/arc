// Streams 16 kHz mono WAV clips through the running relay (/ws/voice) in real time, as push-to-talk would, and prints
// what each listener heard and when. Replays the owner's recordings too: npx tsx scripts/hearing-replay.ts .cache/asks/*.wav
// Clip names like 03-daniel-pink5.wav are scored against PHRASES[3]; other names are just printed.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import WebSocket from "ws";

const PHRASES = ["", "next", "tour", "tour figure one", "start the tour of figure one", "open the first one", "take me to the results",
  "what does the belt unit contain", "find a paper about knee rehabilitation", "bigger text", "again"];
const CONTEXT = [
  "Title: Wearable Sensors for Lower-Limb Rehabilitation",
  "Abstract: A review of wearable sensing.", "Introduction: Knee and ankle rehabilitation.", "Methods: Sensor placement.",
  "Results: Gait measures.", "Discussion: Limits.", "Conclusions: Summary.",
  "Figure 1 (figure): The belt unit contains the battery and the main board.", "Figure 2 (figure): Sensor positions on the leg.",
].join("\n");
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\b1\b/g, "one").trim();

interface Row { clip: string; want: string; live?: string; liveMs?: number; context?: string; alts?: string[]; contextMs?: number; source?: string }

function run(file: string): Promise<Row> {
  const pcm = readFileSync(file).subarray(44);
  const want = PHRASES[Number(basename(file).slice(0, 2))] ?? "";
  const row: Row = { clip: basename(file, ".wav"), want };
  const id = `chk-${basename(file, ".wav")}-${Date.now() % 100000}`;
  return new Promise((resolve) => {
    const ws = new WebSocket("ws://localhost:3000/ws/voice");
    let tEnd = 0;
    const done = () => {
      ws.send(JSON.stringify({ type: "ask_result", id, chrome: "", decided: { source: "check" } }));
      setTimeout(() => {
        ws.close();
        // the generic transcripts come from the relay's own log line for this ask
        const line = readFileSync(".cache/asks/log.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((l) => l.id === id);
        if (line) row.live = line.finals?.tr || line.finals?.asker || row.live || "";
        if (line?.finals?.context) Object.assign(row, { context: line.finals.context.text, alts: line.finals.context.alternatives, contextMs: line.finals.context.ms });
        resolve(row);
      }, 400);
    };
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.id !== id) return;
      if (m.type === "heard") {
        row.source = m.source;
        if (m.source === "context") Object.assign(row, { context: m.text, alts: m.alternatives, contextMs: Date.now() - tEnd, live: row.live });
        else Object.assign(row, { live: m.text, liveMs: Date.now() - tEnd });
      }
      if (m.type === "heard_revised") {
        Object.assign(row, { context: m.text, alts: m.alternatives, contextMs: Date.now() - tEnd });
        done();
      }
    });
    ws.on("open", async () => {
      ws.send(JSON.stringify({ type: "start", context: CONTEXT }));
      ws.send(JSON.stringify({ type: "ask_start", id }));
      const t = Date.now();
      for (let i = 0, at = 0; i < pcm.length; i += 2048, at += 64) {
        await new Promise((r) => setTimeout(r, Math.max(0, t + at - Date.now())));
        ws.send(JSON.stringify({ type: "ask_audio", data: pcm.subarray(i, i + 2048).toString("base64") }));
      }
      tEnd = Date.now();
      ws.send(JSON.stringify({ type: "ask_end" }));
      setTimeout(done, 7000); // no revision: the context reading agreed, came first, or failed
    });
  });
}

void (async () => {
const files = process.argv.slice(2);
const rows: Row[] = [];
for (let i = 0; i < files.length; i += 4) rows.push(...(await Promise.all(files.slice(i, i + 4).map(run))));
let liveOk = 0, ctxOk = 0, ctxAny = 0;
for (const r of rows) {
  const lo = !!r.want && norm(r.live ?? "") === norm(r.want);
  const co = !!r.want && norm(r.context ?? r.live ?? "") === norm(r.want); // no revision: the context reading agreed with live
  const ca = co || (r.alts ?? []).some((a) => norm(a) === norm(r.want));
  liveOk += +lo; ctxOk += +co; ctxAny += +ca;
  console.log(`| ${r.clip} | ${r.live ?? ""} (${r.liveMs ?? "-"} ms) | ${r.context ?? "(same)"} | ${(r.alts ?? []).join("; ")} | ${r.contextMs ?? "-"} ms | ${r.source} | ${lo ? "Y" : "N"} | ${co ? "Y" : ca ? "alt" : "N"} |`);
}
const n = rows.filter((r) => r.want).length;
if (n) console.log(`\nerror rate: live ${(100 - (100 * liveOk) / n).toFixed(0)}% · context ${(100 - (100 * ctxOk) / n).toFixed(0)}% (${(100 - (100 * ctxAny) / n).toFixed(0)}% counting alternatives) over ${n} clips`);
})();
