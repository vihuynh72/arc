// Figure tours: hand-fixed fixtures for prepared figures, Gemini vision for any other image.
import { createHash } from "node:crypto";
import { getImage, mkdir, readFile, writeFile } from "./vault"; // private documents' files stay in memory (lib/server/vault.ts)
import { brief, chartTour, cleanBox, cleanChart, hasValues, type CleanChart, type RawChart } from "../chart";
import { GEMINI_CHART_MODELS, GEMINI_VISION_MODEL } from "../models";
import type { Tour, TourStop } from "../types";
import { generateJson, generateJsonChain, type Part } from "./gemini";
import { fetchImage as guardedImage } from "./images";
import { framePath } from "./videoFrames";
import { allowExtras } from "./budget";
import { cropAround, FIT, fitTour, fromCrop, type Fitted } from "./ringFit";

const PREPARED = [
  { match: "sensors-24-01935-g001", file: "fixtures/lower/tour-final.json", image: "/fixtures/lower/figure-1280.jpg" },
  { match: "aerospace-09-00604-g001", file: "fixtures/mars/tour-best.json", image: "/fixtures/mars/figure-1280.jpg" },
];


const PROMPT = `You are describing one figure from a study text for a blind student who will be guided through it stop by stop.
Return a teaching tour of 5 to 10 stops (always at least 5: if the figure is simple, split it into its parts, connections, pins, labels or legend) in the order that best teaches the figure (not necessarily top to bottom).
For each stop:
- label: 1 to 4 words naming the part, as the figure names it.
- says: one or two sentences, 15 words or fewer each, plain words, the single most useful fact first. Do not use the words left, right, above, below, top, bottom (position is added by other code).
- box_2d: [ymin, xmin, ymax, xmax] on a 0 to 1000 scale, tightly around the drawn structure itself, not just its text label.
- confidence: "high" if you are sure of the box, "medium" or "low" otherwise.
Also give title (a short name for the figure) and overview (two sentences of 15 words or fewer). Use only what is visible; do not guess.
Also give kind: "chart" if the figure plots or encodes data: line, bar (grouped or stacked), histogram, scatter, pie or donut, box plot, heat map or colour-coded matrix (confusion matrix, correlation matrix), curves of values, with or without axes. "diagram" for parts and connections, flow charts and block diagrams. "photo", or "other" (tables of text, mixed).

If the figure is a chart or plot (line, bar, scatter, signals, matrix), the student needs the data and the message, not the look:
- overview: the takeaway in one or two sentences: the kind of chart, what is compared, and the main finding with numbers.
- stops in this order: one per axis (what it measures, units, range); the legend (how many series, their names); then ONE per series, named by its legend label or what it shows, never by colour alone (colour only as a second cue), giving its start value, its highest and lowest points and where they occur, and its trend, as numbers read from the chart with "about"; with two or more series always one comparing them (which is higher, where they cross or part), and say how many times a repeating pattern occurs; then anything unusual (outlier, gap, shaded region, a pattern that repeats, with its count). Chart stops may use up to three short sentences.
- If a value cannot be read reliably, say so in that stop and set its confidence to "low"; never invent numbers. If the chart has no axes, legend or numbers, say so once in the overview and skip those stops (never a stop for a part that is not drawn).
- boxes: a thin strip along each axis (its tick numbers and title), never across the plot area; around the legend; and around the stretch of each series or the region where it peaks.
- chart_info (charts only): chart_type (line, bar, stacked_bar, histogram, scatter, pie, box, heatmap, other); x_label and y_label: the printed axis titles only, never their numbers; series_names: the legend entries (or the pie's slice names), at most 8; plot_area and legend_area: boxes as above.`;

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
    chart_info: {
      type: "OBJECT",
      properties: {
        chart_type: { type: "STRING" },
        x_label: { type: "STRING" },
        y_label: { type: "STRING" },
        series_names: { type: "ARRAY", items: { type: "STRING" } },
        plot_area: { type: "ARRAY", items: { type: "NUMBER" } },
        legend_area: { type: "ARRAY", items: { type: "NUMBER" } },
      },
    },
  },
  required: ["title", "overview", "stops", "kind"],
};

type ChartInfo = { chart_type?: string; x_label?: string; y_label?: string; series_names?: string[]; plot_area?: unknown; legend_area?: unknown };
type Raw = { title?: string; overview?: string; stops?: Partial<TourStop>[]; kind?: string; chart_info?: ChartInfo };

export const CHART_PROMPT = `Read this chart for a blind student. Their software will compute every count and extreme from your points, so read the points as carefully as you can.
- chart_type: line; bar (one category per bar or bar group); stacked_bar; histogram; scatter; pie (also donut); box (box plot); heatmap (also a colour-coded matrix); other. title: the printed title, or a short name.
- takeaway: one or two sentences: what is compared and the main finding.
- x_axis and y_axis: label (the printed axis title), unit (the printed unit with its scale, e.g. "billion US $", "%", "°C"; null when none is printed), min and max: the axis values at the LEFT and RIGHT (or BOTTOM and TOP) edges of the plot frame, estimated past the last printed tick if the frame extends beyond it; null when no numbers are printed. scale: "log" when equal steps on the axis multiply the value (ticks 100, 1,000, 10,000 ...), else "linear". ticks: [the smallest printed tick value, the largest printed tick value], or omit.
- PRINTED VALUES WIN: when a value is printed on the chart (on a bar, a slice, a point label, a table beside it), return it exactly as printed with printed: true; estimate only what is not printed.
- plot_area: [ymin, xmin, ymax, xmax] on a 0 to 1000 scale of the whole image: the rectangle of the plot frame between the axes. legend_area: the same for the legend, or omit it.
- series: one per line, bar group or point set, named by the legend (or by what it shows), with its colour as a word. points: in AXIS units, sampled left to right, 8 to 60 per series: include every peak and every trough (the exact top and bottom of each), the first and last point, and points between them where the curve bends. Single-series bars: one point per bar, x = 0, 1, 2 ..., label = the category.
- stacked or grouped bars (several series per bar or group): categories: the labels along the axis in axis order (every bar, e.g. every year); series: one per legend entry, bottom to top for a stack, each with values: one number per category (null if absent); stacked: true for stacks; totals: for a stack, the top of the whole stack per category (printed, or read off the axis). For a stack a segment's value is its HEIGHT (its top minus its bottom), NOT the axis value at its top edge. Points may be empty then.
- scatter: one series per point set; sample up to 60 points spread over the whole cloud, including any outliers, each in axis units.
- pie: ONE series named "Slices"; one point per slice in CLOCKWISE order starting at 12 o'clock: label = the slice name, y = its percentage as printed (printed: true) or estimated, x = 0, 1, 2 ..., note = any other figure printed for that slice (e.g. "malignancy risk 20-25%"). pie_area: the box around the whole circle. Axes: label "" and min/max null.
- box: fill boxes, one per group: label, min and max (the whisker ends), q1, median, q3, in axis units. series may be empty.
- heatmap: fill cells, one per cell you can read: row label, column label, value (the printed number, or the value the colour scale gives). series may be empty.
- notable: up to three short sentences on peaks, crossings, gaps, marked regions, using words more than numbers.
- confidence: high, medium or low for the values you read.
- unreadable: ONLY if no number at all is printed on the axes, bars or slices, give the reason here and return series with names and colours but NO points. A chart with a printed scale is readable: estimate its values. Otherwise null.`;

const AXIS_SCHEMA = {
  type: "OBJECT",
  properties: {
    label: { type: "STRING" },
    unit: { type: "STRING", nullable: true },
    min: { type: "NUMBER", nullable: true },
    max: { type: "NUMBER", nullable: true },
    scale: { type: "STRING", enum: ["linear", "log"] },
    ticks: { type: "ARRAY", items: { type: "NUMBER" } },
  },
  required: ["label", "min", "max"],
};

export const CHART_SCHEMA = {
  type: "OBJECT",
  properties: {
    chart_type: { type: "STRING", enum: ["line", "bar", "stacked_bar", "histogram", "scatter", "pie", "box", "heatmap", "other"] },
    title: { type: "STRING" },
    takeaway: { type: "STRING" },
    x_axis: AXIS_SCHEMA,
    y_axis: AXIS_SCHEMA,
    categories: { type: "ARRAY", items: { type: "STRING" } },
    stacked: { type: "BOOLEAN" },
    totals: { type: "ARRAY", items: { type: "NUMBER", nullable: true } },
    pie_area: { type: "ARRAY", items: { type: "NUMBER" } },
    plot_area: { type: "ARRAY", items: { type: "NUMBER" } },
    legend_area: { type: "ARRAY", items: { type: "NUMBER" } },
    series: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          color: { type: "STRING" },
          values: { type: "ARRAY", items: { type: "NUMBER", nullable: true } },
          points: {
            type: "ARRAY",
            items: { type: "OBJECT", properties: { x: { type: "NUMBER" }, y: { type: "NUMBER" }, label: { type: "STRING" }, printed: { type: "BOOLEAN" }, note: { type: "STRING" } }, required: ["x", "y"] },
          },
        },
        required: ["name"],
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

const CONTEXT_RULE = "Use the caption and text only to name things correctly and to choose what matters; describe only what is visible; do not repeat the caption.";
/** The page's caption and nearby text for a figure, put before the image (optional: a bare /api/tour call has none). */
const withContext = (prompt: string, context?: string) => (context ? `${prompt}\n\n${CONTEXT_RULE}\nCaption and text from the page:\n${context.slice(0, 900)}` : prompt);

const CHECK_SCHEMA = { type: "OBJECT", properties: { answer: { type: "STRING", enum: ["yes", "no"] }, quotes: { type: "ARRAY", items: { type: "STRING" } } }, required: ["answer"] };
/** The cheap second opinion before "no numbers" may be said: one yes/no question to the light model. */
async function printedNumbers(image: Part): Promise<{ yes: boolean; quotes: string[] }> {
  try {
    const r = await generateJson<{ answer?: string; quotes?: string[] }>(
      [{ text: "Does this chart print numbers on an axis, on the bars, or on the slices? Answer yes or no and quote two of them." }, image],
      CHECK_SCHEMA,
      { model: GEMINI_VISION_MODEL, timeoutMs: 20_000, feature: "chart" },
    );
    return { yes: r.answer !== "no", quotes: (r.quotes ?? []).filter((q) => typeof q === "string").slice(0, 2) };
  } catch {
    return { yes: true, quotes: [] }; // unknown: never claim the values cannot be read
  }
}

/** The chart model chain; null when every model fails or the data does not validate (the caller keeps the quick tour).
 * A read without values is checked: "no numbers printed" is said only when the model and a second check agree. */
export async function readChart(image: Part, source: string, models = GEMINI_CHART_MODELS, quickSays = "", context?: string): Promise<Tour | null> {
  try {
    const t = Date.now();
    const prompt = withContext(CHART_PROMPT, context);
    const first = await generateJsonChain<RawChart>([{ text: prompt }, image], CHART_SCHEMA, models, 60_000, "chart");
    const { model, tried } = first;
    let raw = first.data;
    console.log(`[tour] chart read by ${model} in ${Date.now() - t} ms${tried.length > 1 ? ` (tried ${tried.join(", ")})` : ""}`);
    let chart: CleanChart | null = cleanChart(raw);
    let verifiedNone = false;
    if (!hasValues(chart)) {
      const check = await printedNumbers(image);
      if (check.yes) {
        const next = [...models.filter((m) => m !== model), model];
        const said = check.quotes.length ? ` such as ${check.quotes.map((q) => `"${q}"`).join(" and ")}` : "";
        const retry = `${prompt}\n\nAn earlier attempt said the values could not be read, but the chart shows printed numbers${said}. Read them.`;
        try {
          const r2 = await generateJsonChain<RawChart>([{ text: retry }, image], CHART_SCHEMA, next, 60_000, "chart");
          const c2 = cleanChart(r2.data);
          console.log(`[tour] chart re-read by ${r2.model}: ${hasValues(c2) ? "values" : "still none"}`);
          if (c2 && (hasValues(c2) || !chart)) [raw, chart] = [r2.data, c2];
        } catch (e) {
          console.log(`[tour] chart re-read failed: ${(e as Error).message.slice(0, 120)}`);
        }
      } else verifiedNone = !!raw.unreadable;
    }
    if (!chart) return null;
    return {
      ...chartTour(
        chart,
        {
          title: raw.title?.trim() || "Chart",
          takeaway: raw.takeaway?.trim() ?? "",
          notable: Array.isArray(raw.notable) ? raw.notable.filter((t) => typeof t === "string") : [],
          unreadable: verifiedNone ? raw.unreadable?.trim() || "no numbers" : null,
          confidence: raw.confidence ?? "low",
          quickSays,
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

/** The best tour already on disk, without calling a model: prepared, then full, then quick. `fit`: a full tour saved before
 * rings were fitted is fitted now (code only, once, saved again); only where a tour is served, not when listing a page. */
export async function cachedTour(imageUrl: string, fit = false): Promise<Tour | null> {
  const quick = async () => {
    const q = await readJson(quickFile(imageUrl));
    return q && quietChart(q); // older saved quick tours were written before numbers were stripped
  };
  const full = async () => {
    const f = await readJson(fullFile(imageUrl));
    return f && fit ? fitSaved(imageUrl, f) : f;
  };
  return (await prepared(imageUrl)) ?? (await full()) ?? (await quick());
}

// A count or a value said by the light model cannot be checked by a blind student, and was wrong ("nine cycles" for ten).
const COUNTED = /\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|hundred|thousand|dozens?|twice|thrice|single|half)\b/i;
export const STILL_READING = "I am still reading the exact values.";
// "Two series: left and right knee" keeps the names: the count word before series, lines or bars is dropped first.
const SERIES_COUNT = /\b(?:\d+|two|three|four|five|six|seven|eight|nine|ten)\s+(series|lines|curves|bars|groups)\b/gi;
const quiet = (t: string) =>
  t
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(SERIES_COUNT, "$1").replace(/^\s*(?:there are\s+)?(\w)/i, (_, c: string) => c.toUpperCase()))
    .filter((s) => s.trim() && !COUNTED.test(s))
    .join(" ");

/** A quick-stage chart tour without counts or values: chart kind, axes and series names only, until the full one comes. */
export function quietChart(t: Tour): Tour {
  if (t.stage !== "quick" || t.overview.endsWith(STILL_READING)) return t; // already quiet (saved after this rule, or built from chart_info)
  const stops = t.stops.map((s) => ({ ...s, says: quiet(s.says) })).filter((s) => s.says).map((s, i) => ({ ...s, n: i + 1 }));
  const base = quiet(t.overview.replace(STILL_READING, "").trim()) || (COUNTED.test(t.title) ? "A chart." : `${t.title}: a chart.`);
  return {
    ...t,
    title: COUNTED.test(t.title.replace(/\b(?:figure|fig\.?)\s*\d+[a-z]?\b/gi, "")) ? "Chart" : t.title,
    overview: `${base} ${STILL_READING}`,
    stops: stops.length ? stops : [{ n: 1, label: "Chart", says: base, box_2d: [0, 0, 1000, 1000], confidence: "low" }],
  };
}

const KINDS: Record<string, string> = { line: "A line chart", bar: "A bar chart", stacked_bar: "A stacked bar chart", histogram: "A histogram", scatter: "A scatter plot", pie: "A pie chart", box: "A box plot", heatmap: "A heat map" };
// Axis titles may carry a printed range in brackets ("score (0-100)"): that part is a value, not a name.
const nameOnly = (s?: string) => {
  const t = (s ?? "").replace(/&deg;/g, "°").replace(/\([^)]*\d[^)]*\)/g, "").replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
  return /^[\d\s.,–-]+$/.test(t) ? "" : t; // a row of tick numbers ("2010 2015 2020") is not an axis title
};
/** The quick chart tour built in code from the names the light model reads reliably: kind, axis titles, series names. No counts or values. */
export function chartSketch(title: string, info: ChartInfo, source: string): Tour | null {
  const kind = KINDS[info.chart_type ?? ""] ?? "A chart";
  const x = nameOnly(info.x_label);
  const y = nameOnly(info.y_label);
  const names = (info.series_names ?? []).map((n) => String(n).trim()).filter(Boolean).slice(0, 8);
  if (!x && !y && !names.length) return null;
  const plot = cleanBox(info.plot_area) ?? [100, 100, 900, 900];
  const [py0, px0, py1, px1] = plot;
  const t = COUNTED.test(title.replace(/\b(?:figure|fig\.?)\s*\d+[a-z]?\b/gi, "")) ? "Chart" : title;
  const stops: Omit<TourStop, "n">[] = [{ label: "Title", says: `${t}.`, box_2d: [0, 0, Math.max(60, py0), 1000], confidence: "medium" }];
  if (x) stops.push({ label: "Horizontal axis", says: `Horizontal axis: ${x}.`, box_2d: [py1, px0, Math.min(1000, py1 + 110), px1], confidence: "medium" });
  if (y) stops.push({ label: "Vertical axis", says: `Vertical axis: ${y}.`, box_2d: [py0, Math.max(0, px0 - 110), py1, px0], confidence: "medium" });
  if (names.length) stops.push({ label: "Legend", says: `Series: ${names.join(", ")}.`, box_2d: cleanBox(info.legend_area) ?? plot, confidence: "medium" });
  stops.push({ label: "Plot area", says: `${kind}. ${STILL_READING}`, box_2d: plot, confidence: "low" });
  const overview = y && x ? `${kind} of ${y} by ${x}.` : `${kind}${y || x ? ` of ${y || x}` : ""}.`;
  return { title: t, overview: `${overview} ${STILL_READING}`, source, stops: stops.map((s, k) => ({ n: k + 1, ...s, says: brief(s.says) })), stage: "quick" };
}

// Pictures Arc made itself (a still from a video, a figure cut from a PDF) are stored under .cache/ and are read straight from
// disk: the address guard rightly refuses to let the server fetch from its own host.
async function ownImage(imageUrl: string): Promise<Part | null | undefined> {
  let u: URL;
  try {
    u = new URL(imageUrl);
  } catch {
    return undefined;
  }
  const q = u.searchParams;
  const part = async (file: string, mimeType: string): Promise<Part | null> => {
    const data = await readFile(file).catch(() => null);
    return data ? { inlineData: { mimeType, data: data.toString("base64") } } : null;
  };
  if (u.pathname === "/api/video/frame") {
    const [id, node] = [q.get("id") ?? "", q.get("node") ?? ""];
    return /^[\w-]{11}$/.test(id) && /^n\d{2,4}$/.test(node) ? part(framePath(id, node), "image/jpeg") : null;
  }
  if (u.pathname === "/api/pdf/figure") {
    const [id, node, box] = [q.get("id") ?? "", q.get("node") ?? "", q.get("box") ?? ""];
    const ok = /^[a-f0-9]{24}$/.test(id) && /^p\d{3,4}-[nf]\d{2}$/.test(node) && /^\d{1,4}(,\d{1,4}){3}$/.test(box);
    return ok ? part(`.cache/pdf/${id}/figures/${node}-${box.replaceAll(",", "_")}.png`, "image/png") : null; // same name app/api/pdf/figure writes
  }
  if (u.pathname === "/api/ingest" && q.get("img")) {
    const pic = getImage(q.get("img") ?? ""); // a picture from a private page, held in memory with it
    return pic ? { inlineData: { mimeType: pic.type, data: pic.data.toString("base64") } } : null;
  }
  return undefined; // not one of ours
}

async function fetchImage(imageUrl: string): Promise<Part | null> {
  if (!/^https?:\/\//i.test(imageUrl)) return null;
  const own = await ownImage(imageUrl);
  if (own !== undefined) return own;
  // Arc's own image route (a figure the browser could not load directly) is unwrapped; every fetch goes through the address guard.
  const inner = /\/api\/image\?u=([^&]+)/.exec(imageUrl)?.[1];
  const img = await guardedImage(inner ? decodeURIComponent(inner) : imageUrl).catch(() => null);
  if (!img) return null;
  if (img.type === "image/svg+xml") return rasterise(img.body);
  return { inlineData: { mimeType: img.type, data: Buffer.from(img.body).toString("base64") } };
}

/** A vector figure drawn as a PNG the vision model can read (arXiv's HTML papers draw most figures as SVG). The box scale is
 * relative, so the ring still lands on the vector picture the page shows. Null when it cannot be drawn.
 * shortcut: sharp comes with Next (an optional dependency), not declared in package.json; declare it if a host lacks it. */
export async function rasterise(svg: Uint8Array): Promise<Part | null> {
  if (svg.byteLength > 3_000_000) return null;
  try {
    const sharp = (await import("sharp")).default;
    const png = await sharp(svg, { density: 144, limitInputPixels: 40_000_000 })
      .flatten({ background: "#fff" })
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    return { inlineData: { mimeType: "image/png", data: png.toString("base64") } };
  } catch {
    return null;
  }
}

/** Stage one: the light model's tour. A chart's is saved as stage "quick" (a full one follows); any other kind is final. */
export async function quickTour(imageUrl: string, context?: string): Promise<Tour | null> {
  const have = await cachedTour(imageUrl, true);
  if (have) return have;
  const image = await fetchImage(imageUrl);
  if (!image) return null;
  const tour = await modelTour(image, imageUrl, context);
  if (tour) await save(tour.stage === "quick" ? quickFile(imageUrl) : fullFile(imageUrl), tour);
  return tour;
}

/** The light model's tour of one picture (not saved). */
export async function modelTour(image: Part, imageUrl: string, context?: string): Promise<Tour | null> {
  const raw = await generateJson<Raw>([{ text: withContext(PROMPT, context) }, image], SCHEMA, { timeoutMs: 25_000, feature: "tour" });
  const stops: TourStop[] = [];
  for (const s of raw.stops ?? []) {
    const box = cleanBox(s.box_2d);
    if (!box || !s.label || !s.says) continue;
    const confidence = ["high", "medium", "low"].includes(s.confidence ?? "") ? s.confidence! : "low";
    stops.push({ n: stops.length + 1, label: s.label, says: brief(s.says), box_2d: box, confidence });
    if (stops.length === 10) break;
  }
  const isChart = raw.kind === "chart";
  if (stops.length < 3) {
    if (!isChart) return null;
    stops.splice(0, stops.length, { n: 1, label: "Chart", says: raw.overview ?? "A chart.", box_2d: [0, 0, 1000, 1000], confidence: "low" });
  }
  const made: Tour = { title: raw.title ?? "Figure", overview: brief(raw.overview ?? ""), source: imageUrl, stops, ...(isChart ? { stage: "quick" as const } : {}) };
  // A chart's quick tour is built in code from names (never just "A chart."); the light model's own sentences are the fallback.
  const sketch = isChart && raw.chart_info ? chartSketch(made.title, raw.chart_info, imageUrl) : null;
  if (isChart) return sketch ?? quietChart(made);
  // Rings: the first boxes are loose. A diagram's stops get the crop pass (not a photo's: its boxes are already good), then
  // every stop is fitted to the picture's own marks in code (lib/server/ringFit.ts). Measured by scripts/ring-eval.ts.
  const bytes = partBytes(image);
  const better = bytes && raw.kind !== "photo" && allowExtras() ? await refineStops(made, bytes) : made;
  return fitTour(better, bytes);
}

/** The bytes of an inline picture (a fetched figure, an SVG drawn to PNG, a private page's picture held in memory). */
const partBytes = (image: Part): Buffer | null => {
  const data = (image.inlineData as { data?: unknown } | undefined)?.data;
  return typeof data === "string" ? Buffer.from(data, "base64") : null;
};

/** A tour saved before rings were fitted: fitted now in code (no model call) and saved again, once. Prepared fixtures, chart
 * tours and photos keep their boxes; any failure returns the tour as it was. */
async function fitSaved(imageUrl: string, tour: Fitted): Promise<Tour> {
  if ((tour.fitted ?? 0) >= FIT || tour.chart || tour.stage === "quick") return tour;
  try {
    const image = await fetchImage(imageUrl);
    const bytes = image && partBytes(image);
    if (!bytes) return tour;
    const fitted = await fitTour(tour, bytes);
    if (fitted !== tour) await save(fullFile(imageUrl), fitted);
    return fitted;
  } catch {
    return tour;
  }
}

const REFINE_SCHEMA = { type: "OBJECT", properties: { found: { type: "BOOLEAN" }, box_2d: { type: "ARRAY", items: { type: "NUMBER" } } }, required: ["found"] };
const REFINE_MS = 9000; // the whole pass: a student may be waiting for this tour
/** The crop pass: one light call per stop on a zoomed crop around its first box, asking for the named part's tight box there;
 * a stop's box is replaced when the part is found. Runs once, when a tour is first built, and only on a normal-budget day
 * (each call also passes the budget guard). Measured on 10 figures: median IoU 0.58 -> 0.76 with the fit, about $0.0004 a stop. */
export async function refineStops(tour: Tour, image: Uint8Array): Promise<Tour> {
  const late = new Promise<null>((r) => setTimeout(() => r(null), REFINE_MS).unref?.());
  const all = Promise.all(
    tour.stops.map(async (st) => {
      const c = await cropAround(image, st.box_2d);
      if (!c) return st;
      try {
        const r = await generateJson<{ found?: boolean; box_2d?: unknown }>(
          [{ text: `This is a zoomed part of a figure. Find the part named "${st.label}" (${st.says}). found: whether it is in this picture. box_2d: [ymin, xmin, ymax, xmax] on a 0 to 1000 scale of this picture, tightly around the drawn part itself with its outline, not only its text.` }, { inlineData: { mimeType: "image/png", data: c.png.toString("base64") } }],
          REFINE_SCHEMA,
          { timeoutMs: REFINE_MS, feature: "tour" },
        );
        const b = r.found ? cleanBox(r.box_2d) : null;
        return b ? { ...st, box_2d: fromCrop(c.window, b) } : st;
      } catch {
        return st; // busy, refused by the budget, or unreadable: the first box stays
      }
    }),
  );
  const stops = await Promise.race([all, late]);
  return stops ? { ...tour, stops } : tour;
}

/** Stage two, charts only: the data-read, code-built tour. Returns the final tour, or null when the chart read failed. */
export async function fullTour(imageUrl: string, context?: string): Promise<Tour | null> {
  const quick = await quickTour(imageUrl, context);
  if (!quick || quick.stage !== "quick") return quick;
  const image = await fetchImage(imageUrl);
  const quickSays = quick.overview.replace(STILL_READING, "").trim();
  const chart = image ? await readChart(image, imageUrl, GEMINI_CHART_MODELS, quickSays, context) : null;
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
