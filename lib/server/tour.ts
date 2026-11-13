// Figure tours: hand-fixed fixtures for prepared figures, Gemini vision for any other image.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chartTour, cleanBox, cleanChart, type RawChart } from "../chart";
import { GEMINI_CHART_MODELS } from "../models";
import type { Tour, TourStop } from "../types";
import { generateJson, generateJsonChain, type Part } from "./gemini";

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
Also give kind: "chart" if the figure plots or encodes data: line, bar (grouped or stacked), histogram, scatter, pie or donut, box plot, heat map or colour-coded matrix (confusion matrix, correlation matrix), curves of values, with or without axes. "diagram" for parts and connections, flow charts and block diagrams. "photo", or "other" (tables of text, mixed).

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
- chart_type: line; bar (one category per bar or bar group); stacked_bar; histogram; scatter; pie (also donut); box (box plot); heatmap (also a colour-coded matrix); other. title: the printed title, or a short name.
- takeaway: one or two sentences: what is compared and the main finding.
- x_axis and y_axis: label (the printed axis title), unit (null when none is printed), min and max: the axis values at the LEFT and RIGHT (or BOTTOM and TOP) edges of the plot frame, estimated past the last printed tick if the frame extends beyond it; null when no numbers are printed.
- plot_area: [ymin, xmin, ymax, xmax] on a 0 to 1000 scale of the whole image: the rectangle of the plot frame between the axes. legend_area: the same for the legend, or omit it.
- series: one per line, bar group or point set, named by the legend (or by what it shows), with its colour as a word. points: in AXIS units, sampled left to right, 8 to 60 per series: include every peak and every trough (the exact top and bottom of each), the first and last point, and points between them where the curve bends. Bars: one point per bar, x = 0, 1, 2 ..., label = the category.
- scatter: one series per point set; sample up to 60 points spread over the whole cloud, including any outliers, each in axis units.
- pie: ONE series named "Slices"; one point per slice: label = the slice name, y = its percentage (or its printed value), x = 0, 1, 2 ... Axes: label "" and min/max null.
- box: fill boxes, one per group: label, min and max (the whisker ends), q1, median, q3, in axis units. series may be empty.
- heatmap: fill cells, one per cell you can read: row label, column label, value (the printed number, or the value the colour scale gives). series may be empty.
- notable: up to three short sentences on peaks, crossings, gaps, marked regions, using words more than numbers.
- confidence: high, medium or low for the values you read.
- unreadable: if values cannot be read (no axis numbers), give the reason here and return series with names and colours but NO points. Otherwise null.`;

export const CHART_SCHEMA = {
  type: "OBJECT",
  properties: {
    chart_type: { type: "STRING", enum: ["line", "bar", "stacked_bar", "histogram", "scatter", "pie", "box", "heatmap", "other"] },
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
    boxes: {
      type: "ARRAY",
      items: { type: "OBJECT", properties: { label: { type: "STRING" }, min: { type: "NUMBER" }, q1: { type: "NUMBER" }, median: { type: "NUMBER" }, q3: { type: "NUMBER" }, max: { type: "NUMBER" } }, required: ["label", "min", "q1", "median", "q3", "max"] },
    },
    cells: { type: "ARRAY", items: { type: "OBJECT", properties: { row: { type: "STRING" }, col: { type: "STRING" }, value: { type: "NUMBER" } }, required: ["row", "col", "value"] } },
    notable: { type: "ARRAY", items: { type: "STRING" } },
    confidence: { type: "STRING", enum: ["high", "medium", "low"] },
    unreadable: { type: "STRING", nullable: true },
  },
  required: ["chart_type", "title", "takeaway", "x_axis", "y_axis", "plot_area", "series", "notable", "confidence"],
};

/** The chart model chain; null when every model fails or the data does not validate (the caller keeps the quick tour). */
export async function readChart(image: Part, source: string, models = GEMINI_CHART_MODELS): Promise<Tour | null> {
  try {
    const t = Date.now();
    const { data: raw, model, tried } = await generateJsonChain<RawChart>([{ text: CHART_PROMPT }, image], CHART_SCHEMA, models, 60_000);
    console.log(`[tour] chart read by ${model} in ${Date.now() - t} ms${tried.length > 1 ? ` (tried ${tried.join(", ")})` : ""}`);
    const chart = cleanChart(raw);
    if (!chart) return null;
    return {
      ...chartTour(
        chart,
        {
          title: raw.title?.trim() || "Chart",
          takeaway: raw.takeaway?.trim() ?? "",
          notable: Array.isArray(raw.notable) ? raw.notable.filter((t) => typeof t === "string") : [],
          unreadable: raw.unreadable?.trim() || null,
          confidence: raw.confidence ?? "low",
        },
        source,
      ),
      stage: "full",
    };
  } catch (e) {
    console.error("readChart failed:", (e as Error).message);
    return null;
  }
}

const hash = (u: string) => createHash("sha1").update(u).digest("hex");
const fullFile = (u: string) => `.cache/tours/${hash(u)}.json`;
const quickFile = (u: string) => `.cache/tours/${hash(u)}.quick.json`;
const readJson = (f: string) => readFile(f, "utf8").then((t) => JSON.parse(t) as Tour, () => null);
async function save(f: string, tour: Tour) {
  await mkdir(".cache/tours", { recursive: true });
  await writeFile(f, JSON.stringify(tour));
}

export async function prepared(imageUrl: string): Promise<Tour | null> {
  const p = PREPARED.find((q) => imageUrl.includes(q.match));
  return p ? { ...(JSON.parse(await readFile(p.file, "utf8")) as Tour), image: p.image } : null;
}

/** The best tour already on disk, without calling a model: prepared, then full, then quick. */
export async function cachedTour(imageUrl: string): Promise<Tour | null> {
  return (await prepared(imageUrl)) ?? (await readJson(fullFile(imageUrl))) ?? (await readJson(quickFile(imageUrl)));
}

async function fetchImage(imageUrl: string): Promise<Part | null> {
  if (!/^https?:\/\//i.test(imageUrl)) return null;
  const res = await fetch(imageUrl, { headers: { "user-agent": CHROME_UA }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return null;
  const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!mime.startsWith("image/")) return null;
  return { inlineData: { mimeType: mime, data: Buffer.from(await res.arrayBuffer()).toString("base64") } };
}

/** Stage one: the light model's tour. A chart's is saved as stage "quick" (a full one follows); any other kind is final. */
export async function quickTour(imageUrl: string): Promise<Tour | null> {
  const have = await cachedTour(imageUrl);
  if (have) return have;
  const image = await fetchImage(imageUrl);
  if (!image) return null;
  const raw = await generateJson<Raw>([{ text: PROMPT }, image], SCHEMA, { timeoutMs: 25_000 });
  const stops: TourStop[] = [];
  for (const s of raw.stops ?? []) {
    const box = cleanBox(s.box_2d);
    if (!box || !s.label || !s.says) continue;
    const confidence = ["high", "medium", "low"].includes(s.confidence ?? "") ? s.confidence! : "low";
    stops.push({ n: stops.length + 1, label: s.label, says: s.says, box_2d: box, confidence });
    if (stops.length === 10) break;
  }
  const isChart = raw.kind === "chart";
  if (stops.length < 3) {
    if (!isChart) return null;
    stops.splice(0, stops.length, { n: 1, label: "Chart", says: raw.overview ?? "A chart.", box_2d: [0, 0, 1000, 1000], confidence: "low" });
  }
  const tour: Tour = { title: raw.title ?? "Figure", overview: raw.overview ?? "", source: imageUrl, stops, ...(isChart ? { stage: "quick" as const } : {}) };
  await save(isChart ? quickFile(imageUrl) : fullFile(imageUrl), tour);
  return tour;
}

/** Stage two, charts only: the data-read, code-built tour. Returns the final tour, or null when the chart read failed. */
export async function fullTour(imageUrl: string): Promise<Tour | null> {
  const quick = await quickTour(imageUrl);
  if (!quick || quick.stage !== "quick") return quick;
  const image = await fetchImage(imageUrl);
  const chart = image ? await readChart(image, imageUrl) : null;
  if (chart) await save(fullFile(imageUrl), chart);
  return chart;
}

/** Old single-call entry point (scripts): the fullest tour, waiting for both stages. */
export async function getTour(imageUrl: string): Promise<Tour | null> {
  try {
    return (await fullTour(imageUrl)) ?? (await cachedTour(imageUrl));
  } catch (e) {
    console.error("getTour failed:", (e as Error).message);
    return null;
  }
}
