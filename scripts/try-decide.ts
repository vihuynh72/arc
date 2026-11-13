// npx tsx scripts/try-decide.ts : runs the decision step on the real demo page and prints each result.
import { decide, type Item } from "../lib/server/decide";
import type { Twin } from "../lib/types";

process.loadEnvFile(".env.local");

async function items(): Promise<Item[]> {
  try {
    const res = await fetch("http://localhost:3000/api/load", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://www.mdpi.com/1424-8220/24/6/1935" }),
    });
    const twin = (await res.json()) as Twin;
    return twin.nodes.filter((n) => n.kind !== "segment").map((n) => ({ id: n.id, label: n.heading }));
  } catch {
    return [];
  }
}

(async () => {
  const list = await items();
  console.log(`${list.length} items from the page`);
  const label = (id: string | null) => list.find((i) => i.id === id)?.label ?? "-";
  const times: number[] = [];
  for (const u of [
    "next",
    "go back",
    "take me to the results",
    "the part about how the sensors talk to the phone",
    "start the tour of figure one",
    "find me a paper about knee rehabilitation",
    "what does the belt unit contain",
    "stop",
    "read that again",
    "what's the weather",
  ]) {
    const d = await decide({ utterance: u, items: list });
    times.push(d.ms);
    console.log(
      `${JSON.stringify(u)} -> ${d.action} ${d.confidence.toFixed(2)} | target ${d.target ?? "none"} ${d.targetConfidence.toFixed(2)} (${label(d.target)}) | act ${d.act} | query ${JSON.stringify(d.query)} | ${d.ms} ms`,
    );
  }
  times.sort((a, b) => a - b);
  console.log(`median ${(times[4] + times[5]) / 2} ms`);
})();
