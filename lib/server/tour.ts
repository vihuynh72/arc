// Figure tours: hand-fixed fixtures for prepared figures, Gemini vision for any other image.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chartTour, cleanBox, cleanChart, type RawChart } from "../chart";
import { GEMINI_CHART_MODEL } from "../models";
import type { Tour, TourStop } from "../types";
import { generateJson, type Part } from "./gemini";

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
Also give title (a short name for the figure) and overview (two short sentences). Use only what is visible; do not guess.
Also give kind: "chart" if the figure plots data (line, bar, scatter, pie, curves of values, with or without axes), "diagram" for parts and connections, "photo", or "other" (tables, matrices, heatmaps, mixed).

If the figure is a chart or plot (line, bar, scatter, signals, matrix), the student needs the data and the message, not the look:
- overview: the takeaway in one or two sentences: the kind of chart, what is compared, and the main finding with numbers.
- stops in this order: one per axis (what it measures, units, range); the legend (how many series, their names); then ONE per series, named by its legend label or what it shows, never by colour alone (colour only as a second cue), giving its start value, its highest and lowest points and where they occur, and its trend, as numbers read from the chart with "about"; with two or more series always one comparing them (which is higher, where they cross or part), and say how many times a repeating pattern occurs; then anything unusual (outlier, gap, shaded region, a pattern that repeats, with its count). Chart stops may use up to three short sentences.
- If a value cannot be read reliably, say so in that stop and set its confidence to "low"; never invent numbers. If the chart has no axes, legend or numbers, say so once in the overview and skip those stops (never a stop for a part that is not drawn).
- boxes: a thin strip along each axis (its tick numbers and title), never across the plot area; around the legend; and around the stretch of each series or the region where it peaks.`;

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
    kind: { type: "STRING", enum: ["chart", "diagram", "photo", "other"] },
  },
  required: ["title", "overview", "stops", "kind"],
};

type Raw = { title?: string; overview?: string; stops?: Partial<TourStop>[]; kind?: string };

export const CHART_PROMPT = `Read this chart for a blind student. Their software will compute every count and extreme from your points, so read the points as carefully as you can.
- chart_type: line, bar, scatter, pie or other. title: the printed title, or a short name.
- takeaway: one or two sentences: what is compared and the main finding.
- x_axis and y_axis: label (the printed axis title), unit (null when none is printed), min and max: the axis values at the LEFT and RIGHT (or BOTTOM and TOP) edges of the plot frame, estimated past the last printed tick if the frame extends beyond it; null when no numbers are printed.
- plot_area: [ymin, xmin, ymax, xmax] on a 0 to 1000 scale of the whole image: the rectangle of the plot frame between the axes. legend_area: the same for the legend, or omit it.
- series: one per line, bar group or point set, named by the legend (or by what it shows), with its colour as a word. points: in AXIS units, sampled left to right, 8 to 60 per series: include every peak and every trough (the exact top and bottom of each), the first and last point, and points between them where the curve bends. Bars: one point per bar, x = 0, 1, 2 ..., label = the category.
- notable: up to three short sentences on peaks, crossings, gaps, marked regions, using words more than numbers.
- confidence: high, medium or low for the values you read.
- unreadable: if values cannot be read (no axis numbers), give the reason here and return series with names and colours but NO points. Otherwise null.`;

export const CHART_SCHEMA = {
  type: "OBJECT",
  properties: {
    chart_type: { type: "STRING", enum: ["line", "bar", "scatter", "pie", "other"] },
    title: { type: "STRING" },
    takeaway: { type: "STRING" },
    x_axis: { type: "OBJECT", properties: { label: { type: "STRING" }, unit: { type: "STRING", nullable: true }, min: { type: "NUMBER", nullable: true }, max: { type: "NUMBER", nullable: true } }, required: ["label", "min", "max"] },
    y_axis: { type: "OBJECT", properties: { label: { type: "STRING" }, unit: { type: "STRING", nullable: true }, min: { type: "NUMBER", nullable: true }, max: { type: "NUMBER", nullable: true } }, required: ["label", "min", "max"] },
    plot_area: { type: "ARRAY", items: { type: "NUMBER" } },
    legend_area: { type: "ARRAY", items: { type: "NUMBER" } },
    series: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          color: { type: "STRING" },
          points: { type: "ARRAY", items: { type: "OBJECT", properties: { x: { type: "NUMBER" }, y: { type: "NUMBER" }, label: { type: "STRING" } }, required: ["x", "y"] } },
        },
        required: ["name", "points"],
      },
    },
    notable: { type: "ARRAY", items: { type: "STRING" } },
    confidence: { type: "STRING", enum: ["high", "medium", "low"] },
    unreadable: { type: "STRING", nullable: true },
  },
  required: ["chart_type", "title", "takeaway", "x_axis", "y_axis", "plot_area", "series", "notable", "confidence"],
};

/** One call to the chart model; null when it fails or the data does not validate (the caller keeps the plain tour). */
export async function readChart(image: Part, source: string, model = GEMINI_CHART_MODEL): Promise<Tour | null> {
  try {
    const raw = await generateJson<RawChart>([{ text: CHART_PROMPT }, image], CHART_SCHEMA, { model, timeoutMs: 90_000 });
    const chart = cleanChart(raw);
    if (!chart) return null;
    return chartTour(
      chart,
      {
        title: raw.title?.trim() || "Chart",
        takeaway: raw.takeaway?.trim() ?? "",
        notable: Array.isArray(raw.notable) ? raw.notable.filter((t) => typeof t === "string") : [],
        unreadable: raw.unreadable?.trim() || null,
        confidence: raw.confidence ?? "low",
      },
      source,
    );
  } catch (e) {
    console.error("readChart failed:", (e as Error).message);
    return null;
  }
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
    const image = { inlineData: { mimeType: mime, data } };
    const raw = await generateJson<Raw>([{ text: PROMPT }, image], SCHEMA);

    const stops: TourStop[] = [];
    for (const s of raw.stops ?? []) {
      const box = cleanBox(s.box_2d);
      if (!box || !s.label || !s.says) continue;
      const confidence = ["high", "medium", "low"].includes(s.confidence ?? "") ? s.confidence! : "low";
      stops.push({ n: stops.length + 1, label: s.label, says: s.says, box_2d: box, confidence });
      if (stops.length === 10) break;
    }
    // Charts get a second, stronger reading; the tour is then built in code from its data.
    const chart = raw.kind === "chart" ? await readChart(image, imageUrl) : null;
    if (!chart && stops.length < 3) return null;
    const tour: Tour = chart ?? { title: raw.title ?? "Figure", overview: raw.overview ?? "", source: imageUrl, stops };
    await mkdir(".cache/tours", { recursive: true });
    await writeFile(cacheFile, JSON.stringify(tour));
    return tour;
  } catch (e) {
    console.error("getTour failed:", (e as Error).message);
    return null;
  }
}
