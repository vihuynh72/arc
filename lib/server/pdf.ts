// PDF twins, one page at a time. Called by app/api/load (links), app/api/pdf/upload and app/api/pdf/page.
// Quick stage: code over the page's text layer (lib/parse/pdf.ts), on demand, tens of ms. Full stage: one page cut out with
// pdf-lib and sent to Gemini, only for pages code cannot voice (scan, math, figure, table) and only when the student is on
// or next to them (touch). Files and per-page results live in .cache/pdf/<id>/; job state on globalThis (one process).
import { createHash, randomBytes } from "node:crypto";
import { claim, drop, mkdir, put, readFile, writeFile } from "./vault"; // private documents' files stay in memory (lib/server/vault.ts)
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { GEMINI_PDF_MODEL, GEMINI_VISION_MODEL } from "../models";
import { withLang } from "../parse/lang";
import { cleanBlocks, equationsOf, figuresOf, fitEquations, isPdf, marginKeys, mergeNodes, parsePage, tidyPage, toNodes, type Block, type Flags, type Item, type PageText, type Rect } from "../parse/pdf";
import type { Twin, TwinNode } from "../types";
import { numOf } from "../outline";
import { allowBackground, allowExtras, isBudgetError } from "./budget";
import { generateJson } from "./gemini";
import { safeFetch } from "./safeFetch";
import { seePictures } from "./tourQueue";

export const MAX_BYTES = 60 * 1024 * 1024;
/** The message is the plain line the student hears. */
export class PdfError extends Error {}
const ERR = {
  big: "This PDF is larger than 60 megabytes, which is more than Arc can read.",
  notPdf: "This file is not a PDF.",
  locked: "This PDF is locked with a password, so Arc cannot read it.",
  download: "Arc could not download this PDF.",
  broken: "This PDF is damaged, so Arc cannot open it.",
  missing: "Arc no longer has this PDF. Please load it again.",
};

const QUICK_V = 20; // bump when lib/parse/pdf.ts changes output, so stored quick pages are rebuilt
const dir = (id: string) => `.cache/pdf/${id}`;
const pageFile = (id: string, n: number, stage: string) => `${dir(id)}/p${String(n).padStart(3, "0")}.${stage}.json`;
const readJson = <T>(p: string) => readFile(p, "utf8").then((s) => JSON.parse(s) as T).catch(() => null);
const sha = (b: Uint8Array | string) => createHash("sha1").update(b).digest("hex");

type Doc = { id: string; url: string; title: string; pages: number; bytes: Uint8Array; proxy: PDFDocumentProxy };
type Figures = ReturnType<typeof figuresOf>;
type Quick = { nodes: TwinNode[]; flags: Flags; figures: Figures };
type Stored = { blocks: Block[]; model: string; ms: number; v?: number }; // v 2: figure blocks carry box_2d; v 3: equation blocks carry a checked box_2d
const FULL_V = 3;
type Job = { id: string; n: number; stage: "lite" | "full" };
type State = { docs: Map<string, Promise<Doc>>; quick: Map<string, Promise<Quick>>; running: Set<string>; failed: Set<string>; queue: Job[]; busy: number; calls: string[] };
const g = globalThis as unknown as { __arcPdf?: State; pdfjsWorker?: unknown };
const S: State = (g.__arcPdf ??= { docs: new Map(), quick: new Map(), running: new Set(), failed: new Set(), queue: [], busy: 0, calls: [] });
const MODEL_LANES = 2;
const QUEUE_MAX = 6; // a student skimming ahead leaves stale jobs: keep only the newest
// Open documents (bytes and the parsed pdf.js document) held in memory, least recently used dropped first; a dropped one reopens
// from its file (.cache/pdf, or the vault for a private one or an upload) when asked again. A 60 MB book parsed is a few
// hundred MB, so the byte cap counts the files and leaves room for their parsed form.
const MAX_DOCS = Number(process.env.ARC_PDF_DOCS) || 8;
const MAX_DOC_MB = Number(process.env.ARC_PDF_DOC_MB) || 200;
const sizes = new Map<string, number>(); // bytes of each opened document, by id

/** Keeps `d` as the newest open document and drops the oldest past the caps (with its page memos). */
function remember(id: string, d: Promise<Doc>) {
  S.docs.delete(id);
  S.docs.set(id, d);
  d.then((doc) => {
    sizes.set(id, doc.bytes.length);
    let total = [...S.docs.keys()].reduce((n, k) => n + (sizes.get(k) ?? 0), 0);
    for (const k of [...S.docs.keys()]) {
      if (S.docs.size <= MAX_DOCS && total <= MAX_DOC_MB * 1024 * 1024) break;
      if (k === id) continue; // never the one just asked for
      total -= sizes.get(k) ?? 0;
      forgetDoc(k);
    }
  }, () => S.docs.get(id) === d && S.docs.delete(id));
}
/** Drops one document from memory (its file stays). */
export function forgetDoc(id: string) {
  S.docs.delete(id);
  sizes.delete(id);
  known.delete(id);
  outlines.delete(id);
  for (const k of [...S.quick.keys()]) if (k.startsWith(`${id}:`)) S.quick.delete(k);
}
/** For checks: the ids open in memory now, oldest first. */
export const openDocs = () => [...S.docs.keys()];

let lib: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | undefined;
const pdfjs = () =>
  (lib ??= (async () => {
    const m = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // @ts-expect-error the worker module ships without types
    g.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs"); // in-process worker: no worker file to locate
    return m;
  })());

async function open(id: string, bytes: Uint8Array, url: string, name?: string): Promise<Doc> {
  const { getDocument } = await pdfjs();
  let proxy: PDFDocumentProxy;
  try {
    proxy = await getDocument({ data: new Uint8Array(bytes), disableFontFace: true, fontExtraProperties: true, verbosity: 0 }).promise;
  } catch (e) {
    if ((e as Error).name === "PasswordException") throw new PdfError(ERR.locked);
    console.log(`[pdf] open failed: ${(e as Error).message.slice(0, 200)}`);
    throw new PdfError(ERR.broken);
  }
  const info = (await proxy.getMetadata().catch(() => null))?.info as { Title?: string } | undefined;
  const title = (info?.Title ?? "").trim() || name || fileName(url);
  return { id, url, title, pages: proxy.numPages, bytes, proxy };
}

const fileName = (url: string) => decodeURIComponent(url.split(/[?#]/)[0].split("/").pop() || "") || "PDF";

/** A stored file by id, kept open while used. Ids are 24 hex (a content hash for a link, random for an upload or a private
 * document): anything else is refused (path safety). */
function docFor(id: string): Promise<Doc> {
  if (!/^[a-f0-9]{24}$/.test(id)) return Promise.reject(new PdfError(ERR.missing));
  let d = S.docs.get(id);
  if (d) remember(id, d); // the newest again
  else {
    d = (async () => {
      const bytes = await readFile(`${dir(id)}/file.pdf`).catch(() => null);
      const meta = await readJson<{ url: string; title: string }>(`${dir(id)}/meta.json`);
      if (!bytes) throw new PdfError(ERR.missing);
      const doc = await open(id, new Uint8Array(bytes), meta?.url ?? "", meta?.title);
      if (meta?.title) doc.title = meta.title;
      return doc;
    })();
    remember(id, d);
  }
  return d;
}

const MATH_FONT = /CMMI|CMSY|CMEX|MSBM|MSAM|Math|Symbol|STIX|rsfs|eufm|Euclid/i;
const BOLD_FONT = /bold|black|heavy|semibold|demi|-medi|cmbx|\bbx/i;

/** One page's text items in page coordinates. `full`: also load fonts (bold, math) and count images (the operator list). */
async function pageText(doc: Doc, n: number, full: boolean): Promise<PageText> {
  const page = await doc.proxy.getPage(n);
  const tc = await page.getTextContent();
  let images = 0, paths = 0;
  const graphics: Rect[] = [];
  if (full) {
    const { OPS } = await pdfjs();
    const ops = await page.getOperatorList();
    images = ops.fnArray.filter((f) => f === OPS.paintImageXObject || f === OPS.paintInlineImageXObject || f === OPS.paintImageMaskXObject).length;
    paths = ops.fnArray.filter((f) => f === OPS.constructPath).length;
    graphics.push(...placements(ops, OPS));
  }
  const font = (f: string): string => {
    try {
      return full ? ((page.commonObjs.get(f) as { name?: string } | null)?.name ?? "") : "";
    } catch {
      return "";
    }
  };
  const [vx, vy, vx1, vy1] = page.view;
  const items: Item[] = [];
  for (const it of tc.items) {
    if (!("str" in it) || !it.str) continue;
    const [, b, c, d, x, y] = it.transform as number[];
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01) continue; // rotated text: margin stamps such as arXiv's
    const name = font(it.fontName);
    items.push({ str: it.str, x: x - vx, y: y - vy, w: it.width, size: Math.abs(d) || it.height, bold: BOLD_FONT.test(name), math: MATH_FONT.test(name) });
  }
  page.cleanup();
  return { n, width: vx1 - vx, height: vy1 - vy, items, images, paths, graphics: graphics.map((r): Rect => [r[0] - vx, r[1] - vy, r[2] - vx, r[3] - vy]) };
}

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const rectOf = (m: M, x0: number, y0: number, x1: number, y1: number): Rect => {
  const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
};
/** Where images and paths land on the page, from the operator list: the current transform is followed through save/restore,
 * cm and form XObjects; an image fills the unit square, a path its min/max box. Clipping paths are skipped. */
function placements(ops: { fnArray: number[]; argsArray: unknown[] }, OPS: Record<string, number>): Rect[] {
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  const out: Rect[] = [];
  const IMG = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat]);
  ops.fnArray.forEach((f, i) => {
    const a = ops.argsArray[i] as unknown[] | null;
    if (f === OPS.save) stack.push(ctm);
    else if (f === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (f === OPS.transform && a) ctm = mul(ctm, a as unknown as M);
    else if (f === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(a?.[0])) ctm = mul(ctm, a[0] as M);
    } else if (f === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (IMG.has(f)) out.push(rectOf(ctm, 0, 0, 1, 1));
    else if (f === OPS.constructPath && a && a[0] !== OPS.endPath && a[2]) {
      const mm = a[2] as ArrayLike<number>;
      const r = Number.isFinite(mm[0]) && Number.isFinite(mm[2]) ? rectOf(ctm, mm[0], mm[1], mm[2], mm[3]) : null;
      if (r && (r[2] - r[0] >= 12 || r[3] - r[1] >= 12)) out.push(r); // glyph-sized paths are math set as outlines (OpenStax), not drawings
    }
  });
  return out;
}

/** Code-only nodes for page n (neighbours n-2..n+2 are read only for their running headers). */
function quick(doc: Doc, n: number): Promise<Quick> {
  const key = `${doc.id}:${n}:${QUICK_V}`; // the memo outlives hot reloads: an older parser's pages must not be served
  let q = S.quick.get(key);
  if (!q) {
    q = (async () => {
      const file = pageFile(doc.id, n, `quick${QUICK_V}`);
      const have = await readJson<Quick>(file);
      if (have) return have;
      const near = [n - 2, n - 1, n + 1, n + 2].filter((k) => k >= 1 && k <= doc.pages);
      const [p, ...others] = await Promise.all([pageText(doc, n, true), ...near.map((k) => pageText(doc, k, false))]);
      p.repeated = new Set(others.flatMap(marginKeys));
      const { blocks, flags } = parsePage(p);
      const nodes = toNodes(n, blocks, flags.scan);
      const out: Quick = { nodes, flags, figures: figuresOf(nodes, blocks) };
      writeFile(file, JSON.stringify(out)).catch(() => {});
      return out;
    })();
    S.quick.set(key, q);
    q.catch(() => S.quick.delete(key));
  }
  return q;
}

const needsModel = (f: Flags) => f.scan || f.math || f.figure || f.table || f.vector;

// ---- the whole document's outline, by code: the file's own bookmarks, else the headings the quick stage finds on every page ----
export type OutlineEntry = NonNullable<NonNullable<Twin["pdf"]>["outline"]>[number];
const OUTLINE_V = 1;
const MAX_ENTRIES = 400;
const SCAN_PAGES = 120; // shortcut: a longer file without bookmarks is scanned only this far; raise it if long unbookmarked books matter
const outlines = new Map<string, Promise<OutlineEntry[] | undefined>>(); // by doc id: stored or bookmarks; undefined while a scan runs
const known = new Map<string, OutlineEntry[]>(); // by doc id: what a scan found
const UNNUMBERED = /^(?:abstract|references|bibliography|acknowledg|appendi|contents|preface|index|notes|supplementary)/i;

/** The file's own bookmarks with their pages. A paper whose bookmarks carry no numbers ("Attention", nested under "Model
 * Architecture") gets the printed numbering back from the nesting ("3.2 Attention"), so "section 3.2" and the page's heading meet. */
async function bookmarks(doc: Doc): Promise<OutlineEntry[]> {
  const out: OutlineEntry[] = [];
  type Node = { title: string; dest: unknown; items?: Node[] };
  const walk = async (list: Node[] | null, level: number) => {
    for (const x of list ?? []) {
      if (out.length >= MAX_ENTRIES) return;
      try {
        const d = typeof x.dest === "string" ? await doc.proxy.getDestination(x.dest) : (x.dest as unknown[] | null);
        const ref = d?.[0];
        const page = typeof ref === "number" ? ref + 1 : ref ? (await doc.proxy.getPageIndex(ref as never)) + 1 : 0;
        const title = x.title.replace(/\s+/g, " ").trim();
        if (title && page >= 1 && page <= doc.pages) out.push({ title, page, level });
      } catch {} // a broken destination: that bookmark is left out
      await walk(x.items ?? null, level + 1);
    }
  };
  await walk((await doc.proxy.getOutline().catch(() => null)) as Node[] | null, 1);
  if (out.some((e) => numOf(e.title))) return out;
  const stack: number[] = [];
  return out.map((e) => {
    if (UNNUMBERED.test(e.title)) return e;
    stack.length = e.level;
    stack[e.level - 1] = (stack[e.level - 1] ?? 0) + 1;
    for (let k = 0; k < e.level - 1; k++) stack[k] ??= 1;
    return { ...e, title: `${stack.join(".")} ${e.title}` };
  });
}

/** No bookmarks: the quick stage's headings, page by page (it stores each page, so later page loads are instant too). The title
 * heading (the first level 1 on page 1) is left out; lib/outline.ts evens the levels by numbering. */
async function scanned(doc: Doc): Promise<OutlineEntry[]> {
  const out: OutlineEntry[] = [];
  for (let n = 1; n <= Math.min(doc.pages, SCAN_PAGES) && out.length < MAX_ENTRIES; n++) {
    const q = await quick(doc, n).catch(() => null);
    const title = n === 1 ? q?.nodes.find((x) => x.level === 1) : undefined;
    for (const x of q?.nodes ?? []) if (x !== title && x.kind === "section" && x.level && x.heading.trim()) out.push({ title: x.heading.trim(), page: n, level: Math.max(1, x.level - 1) }); // the parser's 2 is the top
  }
  return out;
}

/** The outline if it is known now (stored, or the file's bookmarks: a few ms); else undefined, and a scan is started in the
 * background whose result later page replies carry. Stored beside the file (a private document's stays in the vault, in memory). */
function pdfOutline(doc: Doc): Promise<OutlineEntry[] | undefined> {
  let p = outlines.get(doc.id);
  if (!p) {
    p = (async () => {
      const file = `${dir(doc.id)}/outline${OUTLINE_V}.json`;
      const t = Date.now();
      const stored = await readJson<OutlineEntry[]>(file);
      if (stored) return stored;
      const marks = await bookmarks(doc);
      if (marks.length) {
        writeFile(file, JSON.stringify(marks)).catch(() => {});
        console.log(`[pdf] outline: ${marks.length} bookmarks in ${Date.now() - t} ms`);
        return marks;
      }
      void scanned(doc).then((o) => {
        known.set(doc.id, o);
        writeFile(file, JSON.stringify(o)).catch(() => {});
        console.log(`[pdf] outline by headings: ${o.length} entries over ${Math.min(doc.pages, SCAN_PAGES)} pages in ${Date.now() - t} ms`);
      }, () => {});
      return undefined;
    })();
    outlines.set(doc.id, p);
    p.catch(() => outlines.delete(doc.id));
  }
  return p.then((o) => o ?? known.get(doc.id));
}

/** `equations`: equation node id -> the box its picture is cut from. Equations are not figures: they stay out of `figures` and every count. */
export type PageResult = { page: number; pages: number; stage: "quick" | "full"; nodes: TwinNode[]; figures: Figures; equations: Figures; model?: string; ms?: number; outline?: OutlineEntry[] };

/** A figure with a box gets `image`: the stored picture's URL (absolute, so lib/server/tour.ts can fetch it). The browser cuts the
 * picture out of the page and stores it there the first time (components/PdfFigure.tsx); until then the URL answers 404. */
export const figureUrl = (origin: string, id: string, node: string, box: number[]) => `${origin}/api/pdf/figure?id=${id}&node=${node}&box=${box.join(",")}`; // a new box is a new picture
/** An equation's picture, cut and stored the same way (components/PdfFigure.tsx, app/api/pdf/figure). `as=equation` keeps its file apart
 * from a figure's; `size` is the box in PDF points, so the page can reserve the picture's room before it is drawn. The URL is relative on
 * purpose: an equation has no tour, and lib/server/tour.ts and /api/tour/prioritise only take absolute http(s) addresses. */
export const equationUrl = (id: string, node: string, box: number[], size?: [number, number]) => `${figureUrl("", id, node, box)}&as=equation${size ? `&size=${size.join("x")}` : ""}`;
const withImages = (id: string, origin: string, nodes: TwinNode[], figures: Figures, equations: Figures, size?: [number, number]) => {
  seePictures(Object.entries(figures).map(([node, f]) => figureUrl(origin, id, node, f.box_2d))); // Arc's own crops: their tours may be built
  return nodes.map((x) =>
    x.kind === "figure" && figures[x.id]
      ? { ...x, image: { url: figureUrl(origin, id, x.id, figures[x.id].box_2d), alt: x.text } }
      : equations[x.id] && x.kind === "section" && !x.level
        ? { ...x, image: { url: equationUrl(id, x.id, equations[x.id].box_2d, size && [Math.round((size[0] * (equations[x.id].box_2d[3] - equations[x.id].box_2d[1])) / 1000), Math.round((size[1] * (equations[x.id].box_2d[2] - equations[x.id].box_2d[0])) / 1000)]), alt: x.text } } // alt: the spoken form
        : x,
  );
};

/** The page as the model and the browser see it, in PDF points (a turned page swaps them). */
async function pageSize(doc: Doc, n: number): Promise<[number, number]> {
  const pg = await doc.proxy.getPage(n);
  const [x0, y0, x1, y1] = pg.view;
  return pg.rotate % 180 ? [y1 - y0, x1 - x0] : [x1 - x0, y1 - y0];
}

/** The best nodes for page n right now: Hydrogen's, else flash-lite's (scans), else code's. "quick" means a better one can come.
 * Figure boxes: code's (image placements next to a caption) win; the model's are used where code found none. */
export async function pdfPage(id: string, n: number, origin = ""): Promise<PageResult> {
  const doc = await docFor(id);
  if (!Number.isInteger(n) || n < 1 || n > doc.pages) throw new PdfError(`This PDF has ${doc.pages} pages.`);
  const [q, outline] = await Promise.all([quick(doc, n), pdfOutline(doc)]);
  const [full, lite] = await Promise.all([readJson<Stored>(pageFile(id, n, "full")), readJson<Stored>(pageFile(id, n, "lite"))]);
  const base = lite ? toNodes(n, lite.blocks) : q.nodes;
  const done = async (stage: PageResult["stage"], nodes: TwinNode[], figures: Figures, equations: Figures, from?: Stored): Promise<PageResult> => ({
    page: n,
    pages: doc.pages,
    stage,
    nodes: withImages(id, origin, tidyPage(n, nodes, doc.title), figures, equations, Object.keys(equations).length ? await pageSize(doc, n).catch(() => undefined) : undefined),
    figures,
    equations,
    ...(from ? { model: from.model, ms: from.ms } : {}),
    ...(outline ? { outline } : {}),
  });
  if (full) {
    const nodes = mergeNodes(n, base, full.blocks);
    const model = figuresOf(nodes, full.blocks);
    const figures: Figures = Object.fromEntries(nodes.flatMap((x) => (q.figures[x.id] ?? model[x.id] ? [[x.id, { ...(q.figures[x.id] ?? model[x.id]), label: x.heading }]] : [])));
    return done(boxPassDue(id, n, nodes, figures, full) ? "quick" : "full", nodes, figures, equationsOf(nodes, full.blocks), full);
  }
  const coming = needsModel(q.flags) && !S.failed.has(`${id}:${n}:full`);
  return done(coming ? "quick" : "full", base, lite ? figuresOf(base, lite.blocks) : q.figures, lite ? equationsOf(base, lite.blocks) : {}, lite ?? undefined); // a scan's fast pass places figures too
}

/** A full pass stored before boxes existed is run once more where they matter: a page with a figure that code could not place (before
 * v 2), or one with an equation (before v 3: a page with no equation, or none the model boxed, is not read again). */
const boxPassDue = (id: string, n: number, nodes: TwinNode[], figures: Figures, full: Stored) =>
  !S.failed.has(`${id}:${n}:full`) &&
  (((full.v ?? 1) < 2 && nodes.some((x) => x.kind === "figure" && !figures[x.id])) || ((full.v ?? 1) < 3 && full.blocks.some((b) => b.kind === "equation")));

/** The student is at page n: n and n+1 go to the front of the model queue when they need it. Returns at once. */
export async function touch(id: string, n: number) {
  const doc = await docFor(id);
  const jobs: Job[] = [];
  for (const k of (allowBackground() ? [n, n + 1] : [n]).filter((k) => k >= 1 && k <= doc.pages)) { // low budget: only the page the student is on
    const q = await quick(doc, k);
    if (!needsModel(q.flags) || S.failed.has(`${id}:${k}:full`)) continue;
    const full = await readJson<Stored>(pageFile(id, k, "full"));
    if (full && (await pdfPage(id, k)).stage !== "quick") continue; // stage "quick" with a stored full pass: it is due to be read again (boxPassDue)
    // A scan the student is waiting on gets a fast transcription first.
    if (q.flags.scan && k === n && !S.failed.has(`${id}:${k}:lite`) && !(await readJson(pageFile(id, k, "lite")))) jobs.push({ id, n: k, stage: "lite" });
    jobs.push({ id, n: k, stage: "full" });
  }
  const same = (a: Job, b: Job) => a.id === b.id && a.n === b.n && a.stage === b.stage;
  S.queue = [...jobs, ...S.queue.filter((j) => !jobs.some((x) => same(x, j)))].slice(0, QUEUE_MAX);
  pump();
}

function pump() {
  while (S.busy < MODEL_LANES && S.queue.length) {
    const job = S.queue.shift()!;
    const key = `${job.id}:${job.n}:${job.stage}`;
    if (S.running.has(key) || S.failed.has(key)) continue;
    S.running.add(key);
    S.busy++;
    runModel(job)
      .catch((e) => {
        if (isBudgetError(e)) return void console.log(`[pdf] page ${job.n} not read: ${e.message}`); // not a failure of the page
        S.failed.add(key); // remembered: no retry loop on a page the model cannot do
        S.calls.push(`${job.stage} fail p${job.n}`);
        console.log(`[pdf] ${job.stage} failed for page ${job.n}: ${(e as Error).message.slice(0, 160)}`);
      })
      .finally(() => {
        S.running.delete(key);
        S.busy--;
        pump();
      });
  }
}

const SCHEMA = {
  type: "OBJECT",
  properties: {
    blocks: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          kind: { type: "STRING", enum: ["heading", "paragraph", "figure", "table", "equation"] },
          level: { type: "INTEGER" },
          text: { type: "STRING" },
          label: { type: "STRING" },
          box_2d: { type: "ARRAY", items: { type: "INTEGER" } },
        },
        required: ["kind", "text"],
      },
    },
  },
  required: ["blocks"],
};
const prompt = (n: number, whole: boolean) =>
  `${whole ? `Use only page ${n} of this PDF. ` : ""}This page of study material will be read aloud to a blind student. Return every block on the page in reading order. ` +
  `Leave out running headers, footers, page numbers and margin stamps. kind is heading (with level 1, 2 or 3), paragraph, figure, table or equation. ` +
  `text is written to be heard, not seen. Copy headings and paragraphs word for word, except that any math inside them is written in spoken form. ` +
  `Spoken math is how a teacher reads it aloud: "x squared plus 2 x", "the integral from 0 to 1 of f of x, d x", "a over b", "the square root of d sub k", "Q times K transpose". ` +
  `Never write LaTeX or symbols such as ^ _ \\ { }. An equation block starts with its printed number if it has one, as in "Equation 1: ...". ` +
  `A table is one sentence on what it compares, then one sentence per row that names each column. ` +
  `A figure is one or two sentences on what it shows, then its caption as printed. For a figure also give label, its printed label such as "Figure 2" (leave it out if it has none), ` +
  `and box_2d, [ymin, xmin, ymax, xmax] on a 0 to 1000 scale of the page, drawn tightly around the picture itself with all its parts and labels but not its caption. ` +
  `For an equation also give box_2d on the same scale, drawn tightly around the whole displayed formula (every line of a multi-line one) and its printed number at the margin, not around the paragraph near it. Add nothing else.`;

/** One page as base64 PDF. An encrypted file cannot be cut, so a small one is sent whole with "use only page n". */
async function onePage(doc: Doc, n: number): Promise<{ data: string; whole: boolean }> {
  const { PDFDocument } = await import("pdf-lib");
  const src = await PDFDocument.load(doc.bytes, { ignoreEncryption: true, updateMetadata: false });
  if (src.isEncrypted) {
    if (doc.bytes.length > 15 * 1024 * 1024) throw new Error("encrypted and too large to send whole");
    return { data: Buffer.from(doc.bytes).toString("base64"), whole: true };
  }
  const out = await PDFDocument.create();
  const [pg] = await out.copyPages(src, [n - 1]);
  out.addPage(pg);
  return { data: Buffer.from(await out.save()).toString("base64"), whole: false };
}

async function runModel(job: Job) {
  const doc = await docFor(job.id);
  const done = await readJson<Stored>(pageFile(job.id, job.n, job.stage));
  if (done && (done.v ?? 1) >= FULL_V) return; // an earlier job for this page finished while this one waited: no second paid read
  const t = Date.now();
  const model = job.stage === "lite" || !allowExtras() ? GEMINI_VISION_MODEL : GEMINI_PDF_MODEL; // a lean day: the light model
  const { data, whole } = await onePage(doc, job.n);
  // The model sometimes stops after a block or two of a full page (seen on 2 of 3 reads of one page, with or without box_2d on
  // equations): it would replace the page's text with a fragment. Compared with what code read, a short answer is asked for once more.
  const had = job.stage === "full" ? (await quick(doc, job.n)).nodes.reduce((n, x) => n + x.text.length, 0) : 0;
  let blocks: Block[] = [];
  for (let attempt = 0; ; attempt++) {
    const raw = await generateJson<unknown>([{ inlineData: { mimeType: "application/pdf", data } }, { text: prompt(job.n, whole) }], SCHEMA, { model, timeoutMs: job.stage === "lite" ? 45_000 : 150_000, feature: "pdf-page" });
    blocks = cleanBlocks(raw);
    if (!blocks.length) throw new Error("no usable blocks");
    const got = blocks.reduce((n, b) => n + b.text.length, 0);
    if (had < 600 || got >= had * 0.4) break;
    if (attempt) throw new Error(`the model left out most of the page (${got} of ${had} characters)`);
  }
  if (blocks.some((b) => b.kind === "equation" && b.box)) {
    const rotated = (await doc.proxy.getPage(job.n)).rotate !== 0; // text coordinates and the model's view part ways on a turned page: no snapping
    blocks = fitEquations(blocks, rotated ? undefined : await pageText(doc, job.n, true).catch(() => undefined));
  }
  const ms = Date.now() - t;
  await writeFile(pageFile(job.id, job.n, job.stage), JSON.stringify({ blocks, model, ms, v: FULL_V } satisfies Stored));
  S.calls.push(`${job.stage} ok ${ms}ms p${job.n} ${model}`);
  console.log(`[pdf] ${job.stage} page ${job.n}: ${blocks.length} blocks in ${ms} ms (${model})`);
}

/** For checks: every model stage run in this process, one line each. */
export const pdfCalls = () => [...S.calls];

export type PdfTwin = Twin & { timing: { downloadMs: number; parseMs: number }; figures: Figures };

/** Bytes in hand -> stored file + a twin holding pages 1 and 2. Also starts page 1's model stage if it needs one. */
/** `id`: given for an upload or a private document (random, so holding the same file never reaches another visitor's copy);
 * a link's PDF is public and is named by its content hash, so one stored copy serves everyone. */
export async function pdfTwin(bytes: Uint8Array, url: string, opts: { name?: string; downloadMs?: number; via?: Twin["source"]["via"]; origin?: string; id?: string } = {}): Promise<PdfTwin> {
  if (bytes.length > MAX_BYTES) throw new PdfError(ERR.big);
  if (!isPdf(bytes)) throw new PdfError(ERR.notPdf);
  const t = Date.now();
  const id = opts.id ?? sha(bytes).slice(0, 24);
  let d = S.docs.get(id);
  if (!d) remember(id, (d = open(id, bytes, url, opts.name)));
  const doc = await d;
  await mkdir(dir(id), { recursive: true });
  await Promise.all([1, 2].filter((k) => k <= doc.pages).map((k) => quick(doc, k)));
  const pages = await Promise.all([1, 2].filter((k) => k <= doc.pages).map((k) => pdfPage(id, k, opts.origin)));
  const nodes = pages.flatMap((p) => p.nodes);
  const figures = Object.assign({}, ...pages.map((p) => p.figures)) as Figures;
  if (doc.title === fileName(url) && !opts.name) doc.title = nodes.find((x) => x.level === 1)?.heading ?? doc.title; // no metadata title
  await Promise.all([writeFile(`${dir(id)}/file.pdf`, bytes, { flag: "wx" }).catch(() => {}), writeFile(`${dir(id)}/meta.json`, JSON.stringify({ url, title: doc.title, pages: doc.pages }))]);
  const parseMs = Date.now() - t;
  const outline = pages[0]?.outline;
  touch(id, 1).catch((e) => console.log(`[pdf] touch failed: ${(e as Error).message}`));
  const count = (k: TwinNode["kind"]) => nodes.filter((x) => x.kind === k).length;
  return withLang({
    id: `pdf-${id}`,
    source: { url, kind: "pdf", title: doc.title, via: opts.via ?? "direct", ms: (opts.downloadMs ?? 0) + parseMs },
    pdf: { id, pages: doc.pages, ...(outline ? { outline } : {}) },
    nodes,
    counts: { sections: count("section"), figures: count("figure"), segments: count("segment") },
    timing: { downloadMs: opts.downloadMs ?? 0, parseMs },
    figures,
  });
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PARTS = 8;
const RANGED_FROM = 8 * 1024 * 1024;

/** The whole file, capped. A large file whose server takes byte ranges comes down in 8 parallel ranges (about 1.7 times faster
 * on OpenStax). shortcut: page 1 waits for the whole file; pdfjs range loading of the 52 MB OpenStax book fetched 44 MB in
 * 170 serial requests (72 s), slower than downloading, so it is not used. Upgrade for linearized files if they matter. */
async function download(url: string): Promise<Uint8Array> {
  const signal = AbortSignal.timeout(120_000);
  const res = await safeFetch(url, { headers: { "user-agent": UA, accept: "application/pdf,*/*" }, signal }).catch(() => null); // address guard on every hop
  if (!res?.ok || !res.body) throw new PdfError(ERR.download);
  const len = Number(res.headers.get("content-length")) || 0;
  if (len > MAX_BYTES) {
    await res.body.cancel();
    throw new PdfError(ERR.big);
  }
  if (len > RANGED_FROM && /bytes/i.test(res.headers.get("accept-ranges") ?? "")) {
    await res.body.cancel();
    const size = Math.ceil(len / PARTS), out = new Uint8Array(len);
    await Promise.all(
      Array.from({ length: PARTS }, async (_, i) => {
        const from = i * size, to = Math.min(len, from + size) - 1;
        const r = await safeFetch(res.url, { headers: { "user-agent": UA, range: `bytes=${from}-${to}` }, signal }).catch(() => null);
        if (r?.status !== 206) throw new PdfError(ERR.download);
        out.set(new Uint8Array(await r.arrayBuffer()), from);
      }),
    );
    return out;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += c.length;
      if (total > MAX_BYTES) throw new PdfError(ERR.big);
      chunks.push(c);
    }
  } catch (e) {
    throw e instanceof PdfError ? e : new PdfError(ERR.download);
  }
  return Buffer.concat(chunks);
}

/** A new random PDF id (24 hex, the shape every PDF route takes). */
export const randomPdfId = () => randomBytes(12).toString("hex");

/**
 * An uploaded file: held in memory only (lib/server/vault.ts), never under .cache/, under a random id, and gone about two hours
 * after its last use or sooner when the vault is full. The README says an upload is sent nowhere but Gemini: nothing of it is
 * written to this machine's disk either. Memory rather than a timed file: the vault already holds, expires and caps private
 * documents, and a file would outlive a crash.
 */
export async function uploadTwin(bytes: Uint8Array, name: string | undefined, origin: string): Promise<PdfTwin> {
  const id = randomPdfId();
  const holder = randomBytes(16).toString("hex");
  claim(holder, `.cache/pdf/${id}`); // before pdfTwin writes: its file, pages and figures stay in memory
  try {
    const twin = await pdfTwin(bytes, `upload:${name ?? "file"}`, { name, origin, id });
    put(holder, twin, [() => forgetDoc(id)]);
    return twin;
  } catch (e) {
    drop(holder);
    throw e;
  }
}

/** A PDF link: stored copy by url if we have one, else download. */
export async function pdfFromLink(url: string, origin = ""): Promise<PdfTwin> {
  const index = `.cache/pdf/url-${sha(url)}.txt`;
  const known = (await readFile(index, "utf8").catch(() => "")).trim();
  if (known) {
    const bytes = await readFile(`${dir(known)}/file.pdf`).catch(() => null);
    if (bytes) return pdfTwin(new Uint8Array(bytes), url, { via: "cache", origin });
  }
  const t = Date.now();
  const bytes = await download(url);
  const downloadMs = Date.now() - t;
  const twin = await pdfTwin(bytes, url, { downloadMs, origin });
  await writeFile(index, twin.pdf!.id).catch(() => {});
  console.log(`[pdf] ${url}: ${bytes.length} bytes, download ${downloadMs} ms, pages 1-2 ${twin.timing.parseMs} ms`);
  return twin;
}
