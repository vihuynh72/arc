// Ring accuracy evaluation: how well each tour stop's box_2d covers the part it names.
//   npx tsx --env-file=.env.local scripts/ring-eval.ts [--shots]
// Inputs live outside the repo (RING_EVAL_DIR, default .work/): the figure files, geom.json (every SVG element's box,
// measured by Chrome), and model-*.json (model tours made once and kept, so reruns are free). Tours for the arXiv figures
// come from .cache/tours (what the app already made). Truth sources:
//   svg   = the file's own geometry: the union of the SVG elements inside a selection drawn by hand (which elements make
//           up the part is a human choice, their coordinates are exact);
//   fixed = the hand-fixed demo tour (fixtures/lower/tour-final.json);
//   own   = boxes labelled by eye on a grid overlay by the evaluator (Claude), not by the figure's authors.
// Reports per stop: IoU, centre error (share of the image diagonal), true centre inside the box, ring shown.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Tour, TourStop } from "../lib/types";
import { FIT, fitTour } from "../lib/server/ringFit";
import { modelTour, rasterise, refineStops } from "../lib/server/tour";
import { geminiUsd } from "../lib/server/budget";

type Box = [number, number, number, number];
type Truth = { svg: Box } | { own: Box } | { fixed: number[] } | null; // null: the stop names no single visible part (left out)
type Fig = { name: string; file: string; tour: string; truth: "svg" | "own" | "fixed"; stops: Record<number, Truth>; kind?: string };

const DIR = process.env.RING_EVAL_DIR ?? ".work";
const DL = process.env.RING_EVAL_FIGS ?? "../ring-dl";
const svg = (b: Box): Truth => ({ svg: b });
const own = (b: Box): Truth => ({ own: b });

// Tours: a cached tour's source URL, or model:<file> for a model tour made by this script.
const FIGS: Fig[] = [
  { name: "resnet-block", file: "resnet-block.svg", tour: "https://arxiv.org/html/1512.03385v1/block.svg?t=2", truth: "svg",
    stops: { 1: svg([50, 380, 170, 430]), 2: svg([215, 305, 395, 585]), 3: svg([390, 455, 490, 540]), 4: svg([500, 305, 680, 585]), 5: svg([745, 412, 875, 478]), 6: svg([860, 455, 965, 540]), 7: svg([100, 448, 840, 820]) } },
  { name: "resnet-block_deeper", file: "resnet-block_deeper.svg", tour: "https://arxiv.org/html/1512.03385v1/block_deeper.svg", truth: "svg",
    stops: { 1: svg([0, 150, 90, 215]), 2: svg([190, 0, 380, 258]), 3: svg([755, 98, 895, 152]), 4: svg([0, 740, 90, 820]), 5: svg([190, 596, 322, 852]), 6: svg([755, 700, 895, 752]) } },
  { name: "resnet-arch", file: "resnet-arch.svg", tour: "https://arxiv.org/html/1512.03385v1/arch.svg?t=2", truth: "svg",
    stops: { 1: svg([0, 90, 1000, 310]), 2: svg([0, 392, 980, 610]), 3: svg([0, 690, 980, 1000]), 4: svg([175, 800, 925, 1000]), 5: svg([930, 90, 1000, 910]) } },
  { name: "unet", file: "unet.svg", tour: "https://arxiv.org/html/1505.04597v1/u-net-illustration-correct-scale2.svg", truth: "svg",
    // 1 and 6 ("input image tile", "output segmentation map") could mean the words or the first/last layer: left out.
    stops: { 1: null, 2: svg([0, 60, 905, 395]), 3: svg([900, 335, 1000, 480]), 4: svg([30, 470, 1000, 860]), 5: svg([195, 180, 885, 700]), 6: null, 7: svg([745, 775, 1000, 990]) } },
  { name: "tf-attention", file: "tf-making_more_difficult5_new.svg", tour: "https://arxiv.org/html/1706.03762v7/making_more_difficult5_new.svg", truth: "svg",
    // 6 ("attention matrix grid") is the faint colour squares under the words: no clear extent, left out.
    stops: { 1: svg([0, 0, 75, 365]), 2: svg([80, 30, 160, 360]), 3: svg([200, 25, 420, 1000]), 4: svg([725, 25, 945, 1000]), 5: svg([405, 445, 748, 815]), 6: null } },
  { name: "lower (demo)", file: "lower.jpg", tour: "model:lower.jpg", truth: "fixed",
    // the model's stops matched by hand to the hand-fixed parts (union when it named a group); 1 and 2 have no hand-fixed part.
    stops: { 1: null, 2: null, 3: { fixed: [2, 3, 4, 5] }, 4: { fixed: [1] }, 5: { fixed: [6] } } },
  { name: "transformer", file: "modalnet21.png", tour: "https://arxiv.org/html/1706.03762v7/Figures/ModalNet-21.png", truth: "own",
    stops: { 1: own([810, 203, 878, 440]), 2: own([740, 0, 800, 268]), 3: own([593, 203, 662, 440]), 4: own([555, 203, 585, 440]), 5: own([430, 203, 497, 440]),
      6: own([810, 558, 878, 795]), 7: own([568, 558, 662, 795]), 8: own([155, 558, 185, 795]), 9: own([93, 558, 125, 795]) } },
  { name: "se-pipeline", file: "pipeline.png", tour: "https://arxiv.org/html/1709.01507v4/pipeline.png", truth: "own",
    stops: { 1: own([235, 48, 830, 155]), 2: own([460, 192, 560, 260]), 3: own([235, 260, 830, 377]), 4: own([110, 400, 245, 448]), 5: own([170, 640, 230, 707]), 6: own([450, 710, 570, 798]), 7: own([235, 820, 830, 945]) } },
  { name: "taxi (photo)", file: "taxi.jpg", tour: "https://arxiv.org/html/2303.08774v3/assets/taxi.jpg", truth: "own", kind: "photo",
    // 5 ("city street backdrop") is everywhere behind: left out.
    stops: { 1: own([120, 420, 700, 640]), 2: own([380, 380, 860, 680]), 3: own([310, 400, 880, 1000]), 4: own([400, 0, 740, 440]), 5: null } },
  { name: "meat (chart)", file: "meat.png", tour: "https://arxiv.org/html/2303.08774v3/assets/meat-consumption.png", truth: "own", kind: "chart",
    // full chart tour, boxes built by lib/chart.ts: 1 and 4 are the whole picture and a remark, left out.
    stops: { 1: null, 2: own([898, 105, 940, 885]), 3: own([205, 118, 847, 910]), 4: null } },
];

// The same figures with tours from the point-first prompt (candidate (d)), mapped to the same truth by label. Stops with no
// matching truth (groups the first set did not name) are left out.
const T = (f: string) => FIGS.find((x) => x.file === f)!.stops;
const V2: Fig[] = [
  { name: "resnet-block", file: "resnet-block.svg", tour: "v2:resnet-block.svg", truth: "svg", stops: { 1: T("resnet-block.svg")[1], 2: T("resnet-block.svg")[2], 3: T("resnet-block.svg")[4], 4: T("resnet-block.svg")[5], 5: T("resnet-block.svg")[7] } },
  { name: "resnet-block_deeper", file: "resnet-block_deeper.svg", tour: "v2:resnet-block_deeper.svg", truth: "svg", stops: { 1: T("resnet-block_deeper.svg")[1], 3: T("resnet-block_deeper.svg")[3], 4: T("resnet-block_deeper.svg")[4], 6: T("resnet-block_deeper.svg")[6] } },
  { name: "unet", file: "unet.svg", tour: "v2:unet.svg", truth: "svg", stops: { 3: T("unet.svg")[3], 5: T("unet.svg")[5], 7: T("unet.svg")[7] } },
  { name: "lower (demo)", file: "lower.jpg", tour: "v2:lower.jpg", truth: "fixed", stops: { 2: { fixed: [1] }, 3: { fixed: [2] }, 4: { fixed: [6] } } },
  { name: "transformer", file: "modalnet21.png", tour: "v2:modalnet21.png", truth: "own", stops: { 1: T("modalnet21.png")[1], 2: T("modalnet21.png")[3], 3: T("modalnet21.png")[4], 4: T("modalnet21.png")[5], 5: T("modalnet21.png")[6], 6: T("modalnet21.png")[7], 7: T("modalnet21.png")[8], 8: T("modalnet21.png")[9] } },
  { name: "se-pipeline", file: "pipeline.png", tour: "v2:pipeline.png", truth: "own", stops: T("pipeline.png") },
];

const hash = (u: string) => createHash("sha1").update(u).digest("hex");
function cachedTour(url: string): Tour | null {
  const f = `.cache/tours/${hash(url)}.json`;
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Tour) : null;
}

const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
function iou(a: Box, b: Box) {
  const i = area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
  return i / (area(a) + area(b) - i || 1);
}

type Geom = Record<string, { w: number; h: number; els: { b: number[]; fill: string; stroke: string }[] }>;
let geom: Geom | null = null;
/** The union of the SVG elements mostly (80 %) inside the selection: the file's own coordinates. */
function svgTruth(file: string, sel: Box): Box | null {
  geom ??= JSON.parse(readFileSync(`${DIR}/geom.json`, "utf8")) as Geom;
  const g = geom[file];
  let out: Box | null = null;
  for (const e of g.els) {
    if (e.fill === "none" && e.stroke === "none") continue;
    const b = e.b as Box;
    const inside = [Math.max(b[0], sel[0]), Math.max(b[1], sel[1]), Math.min(b[2], sel[2]), Math.min(b[3], sel[3])] as Box;
    // Lines have no area: compare lengths instead.
    const size = (x: Box) => Math.max(0.5, x[2] - x[0]) * Math.max(0.5, x[3] - x[1]);
    if (inside[2] < inside[0] || inside[3] < inside[1] || size(inside) < 0.8 * size(b)) continue;
    out = out ? [Math.min(out[0], b[0]), Math.min(out[1], b[1]), Math.max(out[2], b[2]), Math.max(out[3], b[3])] : [...b];
  }
  return out && (out.map((v) => Math.round(v)) as Box);
}

async function picture(file: string): Promise<Buffer> {
  const bytes = readFileSync(`${DL}/${file}`);
  if (!file.endsWith(".svg")) return bytes;
  const p = await rasterise(bytes); // the same PNG the vision model and the fitter see in the app
  return Buffer.from(String((p?.inlineData as { data: string }).data), "base64");
}

async function tourFor(f: Fig, pic: Buffer): Promise<Tour | null> {
  if (f.tour.startsWith("v2:")) return (JSON.parse(readFileSync(`${DIR}/v2-${f.tour.slice(3)}.json`, "utf8")) as { tour: Tour }).tour;
  if (!f.tour.startsWith("model:")) return cachedTour(f.tour);
  const keep = `${DIR}/model-${f.tour.slice(6)}.json`;
  if (existsSync(keep)) return JSON.parse(readFileSync(keep, "utf8")) as Tour;
  const mime = f.file.endsWith(".jpg") ? "image/jpeg" : "image/png";
  const t = await modelTour({ inlineData: { mimeType: mime, data: pic.toString("base64") } }, `file:${f.file}`);
  if (t) writeFileSync(keep, JSON.stringify(t));
  return t;
}

type Row = { fig: string; n: number; label: string; truth: string; iou: number; centre: number; inside: boolean; ring: boolean };
const SHOW = new Set(["hand-fixed", "high"]); // components/FigureTour.tsx draws a ring only for these

function score(f: Fig, stops: TourStop[], truths: (Box | null)[], dims: [number, number]): Row[] {
  const [w, h] = dims;
  const diag = Math.hypot(w, h);
  return stops.flatMap((s, k) => {
    const t = truths[k];
    if (!t) return [];
    const b = s.box_2d as Box;
    const c = (x: Box) => [((x[0] + x[2]) / 2 / 1000) * h, ((x[1] + x[3]) / 2 / 1000) * w];
    const [ty, tx] = c(t);
    const [by, bx] = c(b);
    return [{ fig: f.name, n: s.n, label: s.label, truth: f.truth, iou: iou(b, t), centre: Math.hypot(ty - by, tx - bx) / diag,
      inside: ty >= (b[0] / 1000) * h && ty <= (b[2] / 1000) * h && tx >= (b[1] / 1000) * w && tx <= (b[3] / 1000) * w, ring: SHOW.has(s.confidence) }];
  });
}

const med = (v: number[]) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor((v.length - 1) / 2)] : NaN);
const pct = (v: boolean[]) => `${Math.round((100 * v.filter(Boolean).length) / (v.length || 1))}%`;
function summary(name: string, r: Row[]) {
  const shown = r.filter((x) => x.ring);
  return [name.padEnd(20), String(r.length).padStart(2), med(r.map((x) => x.iou)).toFixed(2), Math.min(...r.map((x) => x.iou)).toFixed(2),
    pct(r.map((x) => x.inside)).padStart(4), pct(r.map((x) => x.ring)).padStart(4),
    (shown.length ? med(shown.map((x) => x.iou)).toFixed(2) : " -  "), (shown.length ? Math.min(...shown.map((x) => x.iou)).toFixed(2) : " -  ")].join("  ");
}

async function overlay(pic: Buffer, out: string, boxes: [string, Box, string][]) {
  const sharp = (await import("sharp")).default;
  const img = await sharp(pic).flatten({ background: "#fff" }).resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  const { width: W = 1, height: H = 1 } = await sharp(img).metadata();
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`;
  for (const [label, [y0, x0, y1, x1], color] of boxes) {
    const [X, Y, BW, BH] = [(x0 / 1000) * W, (y0 / 1000) * H, ((x1 - x0) / 1000) * W, ((y1 - y0) / 1000) * H];
    s += `<rect x="${X}" y="${Y}" width="${BW}" height="${BH}" fill="none" stroke="${color}" stroke-width="3" ${color === "#0a0" ? 'stroke-dasharray="6 4"' : ""}/>`;
    s += `<text x="${X + 3}" y="${Y + 15}" font-size="14" font-family="sans-serif" font-weight="bold" fill="${color}">${label}</text>`;
  }
  await sharp(img).composite([{ input: Buffer.from(s + "</svg>") }]).png().toFile(out);
}

async function main() {
  const shots = process.argv.includes("--shots");
  const fixed = JSON.parse(readFileSync("fixtures/lower/tour-final.json", "utf8")) as Tour;
  const before: Row[] = [];
  const after: Row[] = [];
  const lost: string[] = [];
  let ms = 0;
  mkdirSync(`${DIR}/shots`, { recursive: true });
  const set = process.argv.includes("--v2") ? V2 : FIGS;
  let pts = 0, ptsIn = 0;
  for (const f of set) {
    const pic = await picture(f.file);
    const sharp = (await import("sharp")).default;
    const { width = 1, height = 1 } = await sharp(pic).metadata();
    const tour = await tourFor(f, pic);
    if (!tour) {
      console.log(`${f.name}: no tour`);
      continue;
    }
    const truths: (Box | null)[] = tour.stops.map((s) => {
      const t = f.stops[s.n];
      if (!t) return null;
      if ("fixed" in t) {
        const bs = fixed.stops.filter((x) => t.fixed.includes(x.n)).map((x) => x.box_2d);
        return [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))] as Box;
      }
      return "svg" in t ? svgTruth(f.file, t.svg) : t.own;
    });
    for (const [k, s] of tour.stops.entries()) {
      const p = (s as { point?: number[] }).point, t = truths[k];
      if (!p || !t) continue;
      pts++;
      if (p[0] >= t[0] && p[0] <= t[2] && p[1] >= t[1] && p[1] <= t[3]) ptsIn++;
    }
    let base = tour;
    if (process.argv.includes("--refine") && !f.kind) {
      // candidate (c): the crop pass, cached per figure so reruns are free
      const keep = `${DIR}/refine-${f.name.replace(/\W+/g, "-")}.json`;
      base = existsSync(keep) ? (JSON.parse(readFileSync(keep, "utf8")) as Tour) : await refineStops(tour, pic);
      writeFileSync(keep, JSON.stringify(base));
      if (process.argv.includes("--refine-only")) base = { ...base, fitted: FIT } as Tour; // measure the crop pass alone
    }
    const t0 = performance.now();
    const fitted = await fitTour(base, pic);
    ms += performance.now() - t0;
    before.push(...score(f, tour.stops, truths, [width, height]));
    after.push(...score(f, fitted.stops, truths, [width, height]));
    for (const [k, s] of fitted.stops.entries()) if (SHOW.has(tour.stops[k].confidence) && !SHOW.has(s.confidence) && truths[k]) lost.push(`${f.name} #${s.n} ${s.label}`);
    if (shots) {
      const slug = f.name.replace(/\W+/g, "-");
      const tb = (k: number): [string, Box, string][] => (truths[k] ? [[`${tour.stops[k].n}`, truths[k]!, "#0a0"]] : []);
      await overlay(pic, `${DIR}/shots/${slug}-before.png`, tour.stops.flatMap((s, k) => [...tb(k), [`${s.n}${SHOW.has(s.confidence) ? "" : "?"}`, s.box_2d as Box, "#e00"] as [string, Box, string]]));
      await overlay(pic, `${DIR}/shots/${slug}-after.png`, fitted.stops.flatMap((s, k) => [...tb(k), [`${s.n}${SHOW.has(s.confidence) ? "" : "?"}`, s.box_2d as Box, SHOW.has(s.confidence) ? "#e00" : "#f90"] as [string, Box, string]]));
    }
  }
  const detail = process.argv.includes("--detail");
  if (detail)
    for (const [k, b] of before.entries()) {
      const a = after[k];
      console.log(`${b.fig.padEnd(20)} ${String(b.n).padStart(2)} ${b.label.slice(0, 26).padEnd(26)} ${b.truth.padEnd(5)} iou ${b.iou.toFixed(2)} -> ${a.iou.toFixed(2)}  centre ${b.centre.toFixed(3)} -> ${a.centre.toFixed(3)}  in ${b.inside ? "y" : "n"} -> ${a.inside ? "y" : "n"}  ring ${b.ring ? "y" : "n"} -> ${a.ring ? "y" : "n"}`);
    }
  const head = "figure                stops IoU-med IoU-min  in  ring  shownIoU-med shownIoU-min";
  for (const [name, rows] of [["BEFORE", before], ["AFTER", after]] as const) {
    console.log(`\n${name}\n${head}`);
    for (const f of set) {
      const r = rows.filter((x) => x.fig === f.name);
      if (r.length) console.log(summary(f.name, r) + `   (${f.truth})`);
    }
    console.log(summary("ALL", rows));
    const shown = rows.filter((x) => x.ring);
    console.log(`  rings shown: ${shown.length}/${rows.length}; shown rings with IoU < 0.5: ${shown.filter((x) => x.iou < 0.5).length}; centre error median ${med(rows.map((x) => x.centre)).toFixed(3)}`);
  }
  console.log(`\nrings hidden by the fit: ${lost.length}${lost.length ? ": " + lost.join("; ") : ""}`);
  console.log(`fit time: ${Math.round(ms)} ms for ${set.length} figures`);
  console.log(`model spend in this run: $${geminiUsd().toFixed(4)} (today's total in this copy's budget file)`);
  if (pts) console.log(`model points inside the true box: ${ptsIn}/${pts}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
