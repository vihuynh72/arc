// Figure tours: hand-fixed fixtures for prepared figures, Gemini vision for any other image.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Box, Tour, TourStop } from "../types";
import { generateJson } from "./gemini";

const PREPARED = [
  { match: "sensors-24-01935-g001", file: "fixtures/lower/tour-final.json", image: "/fixtures/lower/figure-1280.jpg" },
  { match: "aerospace-09-00604-g001", file: "fixtures/mars/tour-best.json", image: "/fixtures/mars/figure-1280.jpg" },
];

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const PROMPT = `You are describing one figure from a study text for a blind student who will be guided through it stop by stop.
Return a teaching tour of 5 to 10 stops (always at least 5: if the figure is simple, split it into its parts, connections, pins, labels or legend) in the order that best teaches the figure (not necessarily top to bottom).
For each stop:
- label: 1 to 4 words naming the part, as the figure names it.
- says: ONE or two short plain sentences about that part. Do not use the words left, right, above, below, top, bottom (position is added by other code).
- box_2d: [ymin, xmin, ymax, xmax] on a 0 to 1000 scale, tightly around the drawn structure itself, not just its text label.
- confidence: "high" if you are sure of the box, "medium" or "low" otherwise.
Also give title (a short name for the figure) and overview (two short sentences). Use only what is visible; do not guess.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    overview: { type: "STRING" },
    stops: {
      type: "ARRAY",
      minItems: 5,
      maxItems: 10,
      items: {
        type: "OBJECT",
        properties: {
          label: { type: "STRING" },
          says: { type: "STRING" },
          box_2d: { type: "ARRAY", items: { type: "NUMBER" } },
          confidence: { type: "STRING", enum: ["high", "medium", "low"] },
        },
        required: ["label", "says", "box_2d", "confidence"],
      },
    },
  },
  required: ["title", "overview", "stops"],
};

type Raw = { title?: string; overview?: string; stops?: Partial<TourStop>[] };

/** Boxes sometimes arrive wrapped in one extra array. Returns null unless four sane numbers. */
function cleanBox(b: unknown): Box | null {
  const flat = Array.isArray(b) && Array.isArray(b[0]) ? b[0] : b;
  if (!Array.isArray(flat) || flat.length !== 4 || !flat.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  const [y0, x0, y1, x1] = flat.map((v: number) => Math.min(1000, Math.max(0, Math.round(v))));
  return y0 < y1 && x0 < x1 ? [y0, x0, y1, x1] : null;
}

export async function getTour(imageUrl: string): Promise<Tour | null> {
  const prepared = PREPARED.find((p) => imageUrl.includes(p.match));
  if (prepared) {
    const tour: Tour = JSON.parse(await readFile(prepared.file, "utf8"));
    return { ...tour, image: prepared.image };
  }

  const cacheFile = `.cache/tours/${createHash("sha1").update(imageUrl).digest("hex")}.json`;
  try {
    return JSON.parse(await readFile(cacheFile, "utf8"));
  } catch {}

  if (!/^https?:\/\//i.test(imageUrl)) return null;
  try {
    const res = await fetch(imageUrl, { headers: { "user-agent": CHROME_UA }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!mime.startsWith("image/")) return null;
    const data = Buffer.from(await res.arrayBuffer()).toString("base64");
    const raw = await generateJson<Raw>([{ text: PROMPT }, { inlineData: { mimeType: mime, data } }], SCHEMA);

    const stops: TourStop[] = [];
    for (const s of raw.stops ?? []) {
      const box = cleanBox(s.box_2d);
      if (!box || !s.label || !s.says) continue;
      const confidence = ["high", "medium", "low"].includes(s.confidence ?? "") ? s.confidence! : "low";
      stops.push({ n: stops.length + 1, label: s.label, says: s.says, box_2d: box, confidence });
      if (stops.length === 10) break;
    }
    if (stops.length < 3) return null;
    const tour: Tour = { title: raw.title ?? "Figure", overview: raw.overview ?? "", source: imageUrl, stops };
    await mkdir(".cache/tours", { recursive: true });
    await writeFile(cacheFile, JSON.stringify(tour));
    return tour;
  } catch (e) {
    console.error("getTour failed:", (e as Error).message);
    return null;
  }
}
