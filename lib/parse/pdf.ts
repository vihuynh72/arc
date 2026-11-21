// Deterministic PDF page -> nodes (no model). Input is one page's text items from pdfjs (lib/server/pdf.ts extracts them);
// ids, counts and order come from here. Checked by scripts/checks/pdf.ts.
import type { Box, TwinNode } from "@/lib/types";

/** One text run. x, y: baseline start in PDF points (y grows upward); w: advance width; size: font size in points; math: a math font. */
export type Item = { str: string; x: number; y: number; w: number; size: number; bold: boolean; math: boolean };
/** A drawn thing (image placement or path extent): x0, y0, x1, y1 in PDF points, y up, page origin at the bottom left. */
export type Rect = [number, number, number, number];
export type PageText = { n: number; width: number; height: number; items: Item[]; images: number; paths?: number; graphics?: Rect[]; repeated?: Set<string> };
export type BlockKind = "heading" | "paragraph" | "figure" | "table" | "equation";
/** box: a figure's drawing (not its caption) on the page, [ymin, xmin, ymax, xmax] 0 to 1000; label: its printed label.
 * An equation: box is the model's (as given) until fitEquations has run, then only a checked one; was: what the model gave. */
export type Block = { kind: BlockKind; text: string; level?: number; box?: Box; label?: string; was?: Box };
/** What code cannot voice: these pages get the model when the student is near them. */
export type Flags = { scan: boolean; math: boolean; figure: boolean; table: boolean; vector: boolean };

type Line = { text: string; x0: number; x1: number; y: number; size: number; bold: boolean; mathChars: number; chars: number; col: string; cells: number };

export const isPdf = (b: Uint8Array) => Buffer.from(b.subarray(0, 1024)).includes("%PDF-");

const BAND = 0.075; // top and bottom share of the page that may hold running headers, footers and page numbers
// "Figure 2:", "Fig. 3.", "Table 3.9 Wind speeds" (OpenStax puts no colon); a sentence such as "Table 3 shows" is not one.
const CAPTION = /^(?:[Ff]ig(?:ure)?\.?|FIGURE|[Tt]able|TABLE)\s*(\d+(?:\.\d+)*[a-z]?)(?:\s*[.:|]|\s+[A-Z(])/;
const MATH_CH = /[∑∏∫∮√∂∇≤≥≠≈≡∈∉⊂⊆⊃∪∩∞±∓×÷→←↔⇒⇔∀∃∧∨¬αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ]/g;
const EQ_NO = /\((\d{1,3})\)[^()]{0,12}$/; // "(1)", possibly followed by a stray subscript line such as "dk"
const LABEL = /^(\(?[a-z]\)|[a-z][.)]|\d{1,3}\s?[.)]|[ivx]{1,4}[.)]|[•–-])\s/;
const PAGE_NO = /^(page\s*)?(\d{1,4}|[ivxlcdm]{1,6})(\s*(of|\/)\s*\d{1,4})?$/i;
/** Margin text normalised so "Chapter 2 | Limits 143" on one page matches the same header on another. */
export const marginKey = (s: string) => s.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

/** Items -> lines: same baseline (within half a font size), split where the gap is wider than a column gutter. */
function lines(items: Item[]): Line[] {
  const rows: Item[][] = [];
  for (const it of [...items].filter((i) => i.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find((r) => Math.abs(r[0].y - it.y) < Math.max(r[0].size, it.size) * 0.5);
    if (row) row.push(it);
    else rows.push([it]);
  }
  const out: Omit<Line, "col" | "cells">[][] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    const segs: Item[][] = [];
    for (const it of row) {
      const last = segs.at(-1)?.at(-1);
      if (last && it.x - (last.x + last.w) < Math.max(last.size, it.size) * 1.2) segs.at(-1)!.push(it);
      else segs.push([it]);
    }
    out.push(
      segs.map((s) => {
        let text = "";
        s.forEach((it, i) => {
          const prev = s[i - 1];
          const gap = prev ? it.x - (prev.x + prev.w) : 0;
          if (prev && gap > it.size * 0.15 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += " ";
          text += it.str;
        });
        const body = s.filter((i) => i.size >= Math.max(...s.map((x) => x.size)) * 0.8);
        const chars = s.reduce((n, i) => n + i.str.trim().length, 0);
        return {
          text: text.replace(/\s+/g, " ").trim(),
          x0: s[0].x,
          x1: Math.max(...s.map((i) => i.x + i.w)),
          y: body[0].y,
          size: Math.max(...s.map((i) => i.size)),
          bold: body.every((i) => i.bold || !i.str.trim()),
          mathChars: s.reduce((n, i) => n + (i.math ? i.str.trim().length : (i.str.match(MATH_CH) ?? []).length), 0),
          chars,
        };
      }),
    );
  }
  return out.flatMap((segs) => segs.map((s) => ({ ...s, col: "main", cells: segs.length })));
}

/** Most common font size, weighted by characters. */
function bodySize(ls: Line[]) {
  const w = new Map<number, number>();
  for (const l of ls) w.set(Math.round(l.size * 2) / 2, (w.get(Math.round(l.size * 2) / 2) ?? 0) + l.chars);
  return [...w].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
}

/** Reading order. Lines wider than about half the text block are read as they come; between them, a run of narrower lines
 * that splits into 2 or more x-spans with clear gutters (3 or more lines each) is read span by span: left column, then the
 * next. A line that crosses a gutter of the run so far ends the run. Lines on one baseline in one span are read as one. */
function order(ls: Line[], body: number): Line[] {
  if (!ls.length) return [];
  const byY = (a: Line, b: Line) => b.y - a.y || a.x0 - b.x0;
  const lo = Math.min(...ls.map((l) => l.x0)), hi = Math.max(...ls.map((l) => l.x1));
  const wide = (l: Line) => l.x1 - l.x0 > (hi - lo) * 0.55;
  const spans = (run: Line[]) => {
    const out: [number, number][] = [];
    for (const l of [...run].sort((a, b) => a.x0 - b.x0)) {
      const s = out.at(-1);
      if (s && l.x0 < s[1] + body * 0.8) s[1] = Math.max(s[1], l.x1);
      else out.push([l.x0, l.x1]);
    }
    return out;
  };
  const rows = (g: Line[], col: string) => {
    const out: Line[] = [];
    for (const l of [...g].sort(byY)) {
      const m = out.at(-1);
      if (m && Math.abs(m.y - l.y) < Math.max(m.size, l.size) * 0.5)
        out[out.length - 1] = { ...m, text: `${m.text} ${l.text}`, x1: Math.max(m.x1, l.x1), size: Math.max(m.size, l.size), bold: m.bold && l.bold, mathChars: m.mathChars + l.mathChars, chars: m.chars + l.chars, cells: Math.max(m.cells, l.cells) };
      else out.push({ ...l, col });
    }
    return out;
  };
  const out: Line[] = [];
  let run: Line[] = [], band = 0;
  const flush = () => {
    const sp = spans(run);
    const cols = sp.map(([a, b]) => run.filter((l) => l.x0 >= a && l.x1 <= b));
    if (sp.length > 1 && cols.every((c) => c.length >= 3)) {
      band++;
      cols.forEach((c, k) => out.push(...rows(c, `${band}.${k}`)));
    } else out.push(...rows(run, "main"));
    run = [];
  };
  for (const l of [...ls].sort(byY)) {
    if (wide(l)) {
      flush();
      out.push(...rows([l], "main"));
      continue;
    }
    const sp = run.length >= 4 ? spans(run) : [];
    if (sp.length > 1 && sp.filter(([a, b]) => l.x0 < b && l.x1 > a).length > 1) flush();
    run.push(l);
  }
  flush();
  return out;
}

/** Join wrapped lines; "exam-" + "ple" becomes "example", "well-" + "Known" keeps its hyphen. */
export function joinLines(parts: string[]) {
  return parts.reduce((acc, p) => (!acc ? p : /[A-Za-z]-$/.test(acc) && /^[a-z]/.test(p) ? acc.slice(0, -1) + p : `${acc} ${p}`), "");
}

/** Normalised text of the lines in the top and bottom bands: a neighbour page's keys mark running headers and footers. */
export const marginKeys = (p: PageText) => lines(p.items).filter((l) => l.y > p.height * (1 - BAND) || l.y < p.height * BAND).map((l) => marginKey(l.text));

const meets = (a: Rect, b: Rect) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const grow = (r: Rect, d: number): Rect => [r[0] - d, r[1] - d, r[2] + d, r[3] + d];
const join = (a: Rect, b: Rect): Rect => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const area = (r: Rect) => (r[2] - r[0]) * (r[3] - r[1]);
const lineRect = (l: Line): Rect => [l.x0, l.y - l.size * 0.25, l.x1, l.y + l.size * 0.8];
const centreIn = (l: Line, r: Rect) => {
  const [x, y] = [(l.x0 + l.x1) / 2, l.y + l.size * 0.3];
  return x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
};
/** PDF rect -> [ymin, xmin, ymax, xmax] on 0 to 1000 of the page, top left origin. */
const toBox = (r: Rect, w: number, h: number): Box => {
  const c = (v: number) => Math.max(0, Math.min(1000, Math.round(v)));
  return [c(((h - r[3]) / h) * 1000), c((r[0] / w) * 1000), c(((h - r[1]) / h) * 1000), c((r[2] / w) * 1000)];
};
function mergeAll(rs: Rect[], gap: number) {
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < rs.length; i++)
      for (let j = rs.length - 1; j > i; j--)
        if (meets(grow(rs[i], gap), rs[j])) {
          rs[i] = join(rs[i], rs.splice(j, 1)[0]);
          changed = true;
        }
  }
  return rs;
}

/** Caption line -> drawing rect. Drawings are image placements and path extents clustered within 6 pt, then grown by short
 * text lines on or touching them (diagram labels). A figure caption takes the nearest drawing above it in its column (else
 * below), plus drawings beside that one (a figure in two panels). */
function figureRegions(p: PageText, ls: Line[], segs: Line[]): Map<Line, Rect> {
  const W = p.width, H = p.height;
  let rs = mergeAll(
    (p.graphics ?? [])
      .map((r): Rect => [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(W, r[2]), Math.min(H, r[3])])
      .filter((r) => r[2] - r[0] >= 6 && r[3] - r[1] >= 6 && area(r) < W * H * 0.85), // rules and page backgrounds are not figures
    6,
  ).filter((r) => area(r) >= 1600);
  const caps = ls.filter((l) => CAPTION.test(l.text) && /^f/i.test(l.text));
  if (!caps.length || !rs.length) return new Map();
  const labels = segs.filter((l) => !CAPTION.test(l.text)); // unmerged: two panel titles on one baseline are two short labels
  // A label touching a drawing joins it only if its whole baseline row fits the drawing's width (+25%): a body line above a
  // figure is split into short pieces by inline math, but its row spans the column.
  const row = (l: Line) => segs.filter((x) => Math.abs(x.y - l.y) < l.size * 0.5).reduce((a, x) => [Math.min(a[0], x.x0), Math.max(a[1], x.x1)], [l.x0, l.x1]);
  const sideBySide = (a: Rect, b: Rect) => Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 0.5 * Math.min(a[3] - a[1], b[3] - b[1]);
  const fits = (l: Line, one: Rect) => {
    const r = rs.filter((x) => sideBySide(x, one)).reduce(join, one); // panels side by side share their titles' row
    const [a, b] = row(l), pad = (r[2] - r[0]) * 0.25;
    const same = segs.filter((x) => Math.abs(x.y - l.y) < l.size * 0.5).sort((x, y) => x.x0 - y.x0);
    const text = same.map((x) => x.text).join(" ");
    // A sentence, not a label: 60+ characters, or the end of one ("... units (Figure 1.24).").
    return a >= r[0] - pad && b <= r[2] + pad && text.length < 60 && !/[a-z)\]]\.$|[;]$/.test(text) && !/\b(fig(ure)?\.?|table)\s*\d/i.test(text);
  };
  for (let pass = 0; pass < 2; pass++) {
    rs = rs.map((r) => labels.reduce((acc, l) => (centreIn(l, grow(acc, 2)) || (l.text.length <= 40 && meets(grow(acc, 14), lineRect(l)) && fits(l, acc)) ? join(acc, lineRect(l)) : acc), r));
    rs = mergeAll(rs, 0);
  }
  const used = new Set<Rect>();
  const out = new Map<Line, Rect>();
  for (const c of caps) {
    const top = c.y + c.size, bottom = c.y - c.size * 0.3;
    const free = rs.filter((r) => !used.has(r) && r[0] < c.x1 && r[2] > c.x0 && area(r) >= 3600);
    // Above: reaching over the caption's top (a region may have grown into the caption's own second line; it is clipped below).
    const above = free.filter((r) => r[3] > top + 4 && r[1] - top < H * 0.45).sort((a, b) => Math.max(0, a[1] - top) - Math.max(0, b[1] - top))[0];
    const below = free.filter((r) => r[3] <= top + 2 && bottom - r[3] < H * 0.25).sort((a, b) => b[3] - a[3])[0];
    // A side caption (OpenStax): in a narrow column beside the drawing, level with its foot.
    const gapX = (r: Rect) => Math.max(r[0] - c.x1, c.x0 - r[2], 0);
    const beside = rs.filter((r) => !used.has(r) && area(r) >= 3600 && gapX(r) < 40 && r[3] > top + 4 && r[1] - top < 30).sort((a, b) => gapX(a) - gapX(b))[0];
    const pick = above ?? below ?? beside;
    if (!pick) continue;
    let box = pick;
    used.add(pick);
    for (const r of rs) {
      const shared = Math.min(r[3], pick[3]) - Math.max(r[1], pick[1]);
      if (!used.has(r) && shared > 0.5 * Math.min(r[3] - r[1], pick[3] - pick[1])) {
        used.add(r);
        box = join(box, r);
      }
    }
    out.set(c, above ? [box[0], Math.max(box[1], top + c.size * 0.4), box[2], box[3]] : box); // clear of the caption's tall glyphs
  }
  return out;
}

export function parsePage(p: PageText): { blocks: Block[]; flags: Flags } {
  const all = lines(p.items);
  const chars = all.reduce((n, l) => n + l.chars, 0);
  const inBand = (l: Line) => l.y > p.height * (1 - BAND) || l.y < p.height * BAND;
  const kept = all.filter((l) => !(inBand(l) && l.text.length < 140 && (PAGE_NO.test(l.text) || p.repeated?.has(marginKey(l.text)))));
  const body = bodySize(kept);
  const ls = order(kept, body);
  const mathChars = ls.reduce((n, l) => n + l.mathChars, 0);

  const gaps = ls.slice(1).map((l, i) => ls[i].y - l.y).filter((g) => g > 0 && g < body * 3).sort((a, b) => a - b);
  const pitch = gaps[Math.floor(gaps.length / 2)] ?? body * 1.2;

  // Figures: each "Figure N" caption gets the drawing next to it; text inside the drawing is part of the picture, not the page.
  const boxes = new Map<Line, Box>();
  const inside = new Set<Line>();
  if (chars >= 40) {
    for (const [cap, r] of figureRegions(p, ls, kept)) {
      boxes.set(cap, toBox(r, p.width, p.height));
      for (const l of ls) if (l !== cap && centreIn(l, r)) inside.add(l);
    }
  }
  const isHeading = (l: Line) => l.text.length < 160 && l.cells <= 2 && /[A-Za-z]{2}/.test(l.text) && !CAPTION.test(l.text) && (l.size >= body * 1.15 || (l.bold && l.text.length < 90 && !/[.,;]$/.test(l.text)));
  const isEquation = (l: Line) => !CAPTION.test(l.text) && l.chars > 0 && (l.mathChars / l.chars > 0.35 || (/\(\d{1,3}\)$/.test(l.text) && l.mathChars >= 2 && l.text.length < 120));
  const level = (size: number) => (size >= body * 1.5 ? 1 : size >= body * 1.2 ? 2 : 3);

  type Draft = { kind: BlockKind; parts: string[]; level?: number; last: Line; first: Line };
  const drafts: Draft[] = [];
  for (const l of ls.filter((x) => !inside.has(x))) {
    const prev = drafts.at(-1);
    const gap = prev ? prev.last.y - l.y : 0;
    const kind: BlockKind = isHeading(l) ? "heading" : isEquation(l) ? "equation" : CAPTION.test(l.text) ? (/^t/i.test(l.text) ? "table" : "figure") : "paragraph";
    const sameRun = prev && gap > 0 && gap < pitch * 1.6;
    if (prev && kind === "heading" && prev.kind === "heading" && sameRun && Math.abs(prev.last.size - l.size) < 0.5) {
      prev.parts.push(l.text);
      prev.last = l;
      continue;
    }
    if (prev && kind === "paragraph" && ["paragraph", "figure", "table"].includes(prev.kind)) {
      const hanging = prev.parts.length === 1 && LABEL.test(prev.parts[0]); // "b. Use part a. to" / "    determine how ..."
      const indent = !hanging && l.x0 - prev.last.x0 > body * 0.8 && l.col === prev.last.col && gap > 0; // first-line indent
      const flows = sameRun || l.col !== prev.last.col || gap <= 0; // text flows from the foot of one column to the head of the next
      // A short last line ending a sentence closes the paragraph.
      const sentenceEnd = /[.!?:]$/.test(prev.last.text) && prev.last.x1 < Math.max(...ls.filter((x) => x.col === prev.last.col).map((x) => x.x1)) - body * 2;
      if (!indent && flows && !sentenceEnd && !LABEL.test(l.text)) {
        prev.parts.push(l.text); // captions run on the same way until their paragraph ends
        prev.last = l;
        continue;
      }
    }
    drafts.push({ kind, parts: [l.text], last: l, first: l, ...(kind === "heading" ? { level: level(l.size) } : {}) });
  }

  // A heading of three lines or one ending a sentence is a large-print paragraph.
  for (const d of drafts) if (d.kind === "heading" && (d.parts.length > 2 || /[a-z]{2}\.$/.test(d.parts.at(-1)!))) [d.kind, d.level] = ["paragraph", undefined];
  // Fraction parts and limits sit on their own short lines: fold them into the equation next to them (or the block before).
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    if (d.kind !== "equation" || joinLines(d.parts).length >= 6) continue;
    const into = drafts[i + 1]?.kind === "equation" ? drafts[i + 1] : drafts[i - 1];
    if (!into) continue;
    if (into === drafts[i + 1]) into.parts.unshift(...d.parts);
    else into.parts.push(...d.parts);
    drafts.splice(i--, 1);
  }
  for (let i = 1; i < drafts.length; i++) {
    if (drafts[i].kind === "equation" && drafts[i - 1].kind === "equation" && !/\(\d{1,3}\)$/.test(drafts[i - 1].parts.at(-1)!)) drafts[i - 1].parts.push(...drafts.splice(i--, 1)[0].parts);
  }
  const blocks: Block[] = drafts.filter((d) => /[\p{L}\p{N}]/u.test(d.parts.join(""))).map((d) => {
    const text = joinLines(d.parts);
    if (d.kind === "equation") {
      const no = EQ_NO.exec(text)?.[1];
      return { kind: "equation", text: `Equation${no ? ` ${no}` : ""}, read as printed: ${text}` };
    }
    const box = d.kind === "figure" ? boxes.get(d.first) : undefined;
    return { kind: d.kind, text, ...(d.level ? { level: d.level } : {}), ...(box ? { box } : {}) };
  });
  const rows = ls.filter((l) => l.cells >= 3).length;
  return {
    blocks,
    flags: {
      scan: chars < 40 && (p.images > 0 || (p.paths ?? 0) > 0), // no text but something drawn (scans often sit inside a form)
      math: mathChars >= Math.max(15, chars * 0.02) || blocks.some((b) => b.kind === "equation"), // footnote marks alone are not math
      figure: p.images > 0 || blocks.some((b) => b.kind === "figure"),
      table: blocks.some((b) => b.kind === "table") || rows >= 8, // an author grid has a few multi-cell rows
      // Many drawn paths: math or a diagram drawn as vectors (OpenStax draws its formulas this way), absent from the text layer.
      vector: (p.paths ?? 0) >= 40,
    },
  };
}

const pad = (k: number, w: number) => String(k).padStart(w, "0");
export const nodeId = (page: number, k: number, tag = "n") => `p${pad(page, 3)}-${tag}${pad(k, 2)}`;

/** Blocks -> nodes with ids "p003-n01" in block order. `tag` "n" for code or the first model pass; merged extras use "f". */
export function toNodes(page: number, blocks: Block[], scan = false): TwinNode[] {
  const say = scan ? `Page ${page} is a scanned image. Arc is reading it now.` : `Page ${page} has no text.`;
  if (!blocks.length) return [{ id: nodeId(page, 1), kind: "section", order: page * 1000 + 1, level: null, heading: `Page ${page}`, text: say, page }];
  let current = `Page ${page}`;
  return nameFigures(blocks.map((b, i) => node(page, nodeId(page, i + 1), i + 1, b, b.kind === "heading" ? (current = b.text) : current)), page);
}

function node(page: number, id: string, k: number, b: Block, under: string): TwinNode {
  const no = numberOf(b);
  const base = { id, order: page * 1000 + k, page, text: b.text };
  if (b.kind === "heading") return { ...base, kind: "section", level: b.level ?? 2, heading: b.text };
  if (b.kind === "figure") {
    const own = (b.label && numberOf({ kind: "figure", text: b.label })) || no;
    return { ...base, text: own ? dropLabel(b.text, own) : b.text, kind: "figure", level: null, heading: own ? `Figure ${own}` : "Figure" };
  }
  if (b.kind === "table") return { ...base, kind: "section", level: null, heading: no ? `Table ${no}` : "Table" };
  if (b.kind === "equation") return { ...base, kind: "section", level: null, heading: "Equation" };
  return { ...base, kind: "section", level: null, heading: under };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The caption without its printed label: the card heading already says "Figure 2". */
const dropLabel = (text: string, no: string) => text.replace(new RegExp(`\\b(?:fig(?:ure)?\\.?)\\s*${esc(no)}(?![\\d.]\\d)\\s*[.:|]?\\s*`, "i"), "").trim() || text;

/** Figures the paper does not label are named by place: "Figure on page 4", or "Figure 2 on page 4" when the page has several. */
function nameFigures(nodes: TwinNode[], page: number) {
  const bare = nodes.filter((n) => n.kind === "figure" && n.heading === "Figure");
  bare.forEach((n, k) => (n.heading = bare.length > 1 ? `Figure ${k + 1} on page ${page}` : `Figure on page ${page}`));
  return nodes;
}

/** Figure node id -> its drawing's box and printed label, for the browser to cut the picture out of the page. nodes[i] is blocks[i]. */
export function figuresOf(nodes: TwinNode[], blocks: Block[]): Record<string, { box_2d: Box; page: number; label: string }> {
  const out: Record<string, { box_2d: Box; page: number; label: string }> = {};
  blocks.forEach((b, i) => {
    const n = nodes[i];
    if (b.kind === "figure" && b.box && n?.kind === "figure") out[n.id] = { box_2d: b.box, page: n.page!, label: n.heading };
  });
  return out;
}

/** Equation node id -> the box fitEquations passed, for the browser to cut the formula's picture out of the page. nodes[i] is blocks[i].
 * A node here is still an equation (kind section, heading "Equation"), never a figure: nothing counts, tours or offers it as one. */
export function equationsOf(nodes: TwinNode[], blocks: Block[]): Record<string, { box_2d: Box; page: number; label: string }> {
  const out: Record<string, { box_2d: Box; page: number; label: string }> = {};
  blocks.forEach((b, i) => {
    const n = nodes[i];
    if (b.kind === "equation" && b.box && b.was && n?.kind === "section" && !n.level && n.heading === "Equation") out[n.id] = { box_2d: b.box, page: n.page!, label: n.heading };
  });
  return out;
}

/** A model box, if sane: four numbers (one extra array level tolerated), clamped to the page, at least 2% a side, under 98% of it. */
export function cleanBox(raw: unknown): Box | undefined {
  const v = Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0] : raw;
  if (!Array.isArray(v) || v.length !== 4 || !v.every((x) => Number.isFinite(Number(x)))) return undefined;
  const [y0, x0, y1, x1] = v.map((x) => Math.max(0, Math.min(1000, Math.round(Number(x)))));
  if (y1 - y0 < 20 || x1 - x0 < 20 || (y1 - y0) * (x1 - x0) > 980_000) return undefined;
  return [y0, x0, y1, x1];
}
const overlap = (a: Box, b: Box) => {
  const h = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), w = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return h > 0 && w > 0 ? (h * w) / Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])) : 0;
};

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []);
function similar(a: string, b: string) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return (2 * both) / (A.size + B.size);
}

/** The printed number of a figure, table or equation ("Figure 1.30", "Equation 1:", a trailing "(3)"), anywhere in its text. */
const numberOf = (b: Block) =>
  b.kind === "figure" || b.kind === "table"
    ? /\b(?:fig(?:ure)?\.?|table)\s*(\d+(?:\.\d+)*)/i.exec(b.text)?.[1]
    : b.kind === "equation"
      ? (/\bequation\s+(\d+(?:\.\d+)*)/i.exec(b.text) ?? EQ_NO.exec(b.text))?.[1]
      : undefined;

/** Four numbers as the model gave them (one extra array level tolerated), not clamped: fitEquationBox judges them. */
const raw4 = (raw: unknown): Box | undefined => {
  const v = Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0] : raw;
  return Array.isArray(v) && v.length === 4 && v.every((x) => x !== null && x !== "" && Number.isFinite(Number(x))) ? (v.map(Number) as Box) : undefined;
};

// An equation's picture is cut from the page by its box, so a wrong box is a wrong picture: these limits drop what cannot be right.
// tallest 333 (a third of the page: a longer "equation" is a paragraph or a figure), shortest 10 (about 8 pt: less is a rule or a
// stray mark), narrowest 30 (3% of the width: a lone symbol is not worth a picture), tolerance 15 for a box that overshoots the page edge.
const EQ = { tallest: 333, shortest: 10, narrowest: 30, over: 15, padX: 8, padY: 6, beside: 45, number: 350 };
const EQ_NUMBER = /^\(\d{1,3}[a-z]?\)$/;
/** A line a formula can be made of: not prose, and a math font, a math sign or a printed number "(3)". A heading or a caption is not. */
const formula = (l: Line) => !prose(l) && (l.mathChars > 0 || /[=<>±×÷∑∫√]/.test(l.text) || EQ_NUMBER.test(l.text));
/** A line of running prose: five or more plain words and little math. Formulas set "softmax" or "where" alone do not count. */
const prose = (l: Line) => l.chars >= 25 && l.mathChars / l.chars < 0.25 && l.text.split(" ").filter((w) => /^[A-Za-z]{2,}[,.;:]?$/.test(w)).length >= 5;

/**
 * A model's box for an equation, or undefined (the equation then shows as words, never a wrong crop). In the model's own units:
 * four numbers, inside the page, a sane size. With the page's text lines: lines of the formula that the box clips (a numerator,
 * a subscript, the printed number at the margin) are taken in, a little padding is added, and lines of running prose the box reaches
 * into are cut off (a box that swallowed the paragraph above keeps the formula under it). A box that holds no formula (a heading, a
 * caption, the wrong place), or the printed number of another equation than `no`, is dropped; so is one over bare paper, unless the
 * page is a scan (an image under it) or drawn as vectors (OpenStax), where there is no text to check against. With no page text at
 * all (a rotated page) the model's box is padded and kept.
 */
export function fitEquationBox(raw: unknown, p?: PageText, no?: string): Box | undefined {
  const v = raw4(raw);
  if (!v || v.some((x) => x < -EQ.over || x > 1000 + EQ.over)) return undefined;
  let [y0, x0, y1, x1] = v.map((x) => Math.max(0, Math.min(1000, Math.round(x))));
  const sane = () => y1 - y0 >= EQ.shortest && y1 - y0 <= EQ.tallest && x1 - x0 >= EQ.narrowest;
  if (!sane()) return undefined;
  if (p) {
    const ls = lines(p.items).map((l) => ({ l, r: toBox(lineRect(l), p.width, p.height) }));
    const touches = (r: Box) => r[2] > y0 && r[0] < y1 && r[3] > x0 && r[1] < x1;
    const touched = ls.filter(({ r }) => touches(r));
    for (const { l, r } of ls) {
      const cover = Math.min(r[2], y1) - Math.max(r[0], y0);
      const gap = Math.max(r[1] - x1, x0 - r[3], 0);
      if (prose(l) || cover < (r[2] - r[0]) * 0.5 || gap > (EQ_NUMBER.test(l.text) ? EQ.number : EQ.beside)) continue;
      [y0, x0, y1, x1] = [Math.min(y0, r[0]), Math.min(x0, r[1]), Math.max(y1, r[2]), Math.max(x1, r[3])];
    }
    [y0, x0, y1, x1] = [Math.max(0, y0 - EQ.padY), Math.max(0, x0 - EQ.padX), Math.min(1000, y1 + EQ.padY), Math.min(1000, x1 + EQ.padX)];
    for (const { l, r } of ls.filter(({ l }) => prose(l))) {
      if (!touches(r)) continue;
      const c = (r[0] + r[2]) / 2, atEdge = Math.min(c - y0, y1 - c) < Math.max(r[2] - r[0], (y1 - y0) * 0.3);
      if (atEdge || r[1] <= x0 || r[3] >= x1) [y0, y1] = c < (y0 + y1) / 2 ? [Math.max(y0, r[2]), y1] : [y0, Math.min(y1, r[0])]; // prose above or below: cut it off
      else [x0, x1] = (r[1] + r[3]) / 2 < (x0 + x1) / 2 ? [Math.max(x0, r[3]), x1] : [x0, Math.min(x1, r[1])]; // prose beside (another column)
      if (!sane()) return undefined;
    }
    const inside = ls.filter(({ r }) => (r[0] + r[2]) / 2 > y0 && (r[0] + r[2]) / 2 < y1 && (r[1] + r[3]) / 2 > x0 && (r[1] + r[3]) / 2 < x1);
    if (touched.length ? !inside.some(({ l }) => formula(l)) : !(p.paths && p.paths >= 40) && !(p.graphics ?? []).some((g) => touches(toBox(g, p.width, p.height)))) return undefined; // no formula in it
    const printed = inside.flatMap(({ l }) => (EQ_NUMBER.test(l.text) ? [l.text.replace(/\D/g, "")] : []));
    if (no && printed.length && !printed.includes(no)) return undefined; // the number of a different equation
  } else [y0, x0, y1, x1] = [Math.max(0, y0 - EQ.padY), Math.max(0, x0 - EQ.padX), Math.min(1000, y1 + EQ.padY), Math.min(1000, x1 + EQ.padX)];
  return sane() ? [y0, x0, y1, x1] : undefined;
}

/** Equation blocks keep the box fitEquationBox allows (and the model's own, as `was`, for whoever has to see why one was dropped). */
export const fitEquations = (blocks: Block[], p?: PageText): Block[] =>
  blocks.map((b) => (b.kind === "equation" && b.box ? { ...b, was: b.box, box: fitEquationBox(b.box, p, /^equation\s+(\d{1,3})\b/i.exec(b.text)?.[1]) } : b));

const KINDS: BlockKind[] = ["heading", "paragraph", "figure", "table", "equation"];
/** Drop malformed model blocks (unknown kind, empty or huge text). */
export function cleanBlocks(raw: unknown): Block[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { blocks?: unknown })?.blocks) ? (raw as { blocks: unknown[] }).blocks : [];
  return list.flatMap((b) => {
    const kind = (b as Block)?.kind, text = typeof (b as Block)?.text === "string" ? (b as Block).text.replace(/\s+/g, " ").trim() : "";
    if (!KINDS.includes(kind) || !text || text.length > 4000) return [];
    const level = Number((b as Block).level);
    const raw = b as { box_2d?: unknown; label?: unknown };
    const box = kind === "figure" ? cleanBox(raw.box_2d) : kind === "equation" ? raw4(raw.box_2d) : undefined;
    const label = kind === "figure" && typeof raw.label === "string" && /^(fig(ure)?\.?|plate|chart|diagram|scheme)\s*\S/i.test(raw.label.trim()) ? raw.label.trim().slice(0, 30) : undefined;
    return [{ kind, text, ...(kind === "heading" ? { level: level >= 1 && level <= 3 ? level : 2 } : {}), ...(box ? { box } : {}), ...(label ? { label } : {}) }];
  }).map((b, i, all) => {
    if (!b.box || !all.slice(0, i).some((a) => a.box && overlap(a.box, b.box!) > 0.5)) return b;
    return { ...b, box: undefined }; // a box mostly inside an earlier figure's is not trusted
  });
}

// A licence or permission line printed above a paper's title ("Provided proper attribution is provided, Google hereby grants
// permission ..."), or a copyright line: kept, but read after the title, authors and abstract.
const NOTICE = /\b(?:hereby grants? permission|permission to (?:reproduce|make digital)|all rights reserved|copyright\b|©|licensed under|creative commons|preprint\b.*\bnot (?:been )?peer[- ]reviewed)/i;

/**
 * The page as a student should meet it. Page 1: a notice that comes before the first heading is moved to just before the first
 * numbered section (else to the end of the page). Every page: a heading that repeats the paper's title, or a heading already
 * given on this page, is dropped with its repeat (its paragraphs stay, under the first). Ids are kept: the reader's place holds.
 */
export function tidyPage(page: number, nodes: TwinNode[], title = ""): TwinNode[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const t = norm(title);
  const seen = new Set<string>();
  let titled = false;
  let out = nodes.filter((n) => {
    if (n.kind !== "section" || !n.level) return true;
    const h = norm(n.heading);
    const isTitle = !!t && h === t;
    if (isTitle && page === 1 && !titled) return (titled = true), seen.add(h), true; // the title once, on page 1
    if (isTitle || seen.has(h)) return false;
    seen.add(h);
    return true;
  });
  if (page === 1) {
    const firstHead = out.findIndex((n) => n.kind === "section" && !!n.level);
    const notes = out.filter((n, i) => (firstHead < 0 || i < firstHead) && n.kind === "section" && !n.level && NOTICE.test(n.text));
    if (notes.length) {
      out = out.filter((n) => !notes.includes(n));
      const at = out.findIndex((n) => n.kind === "section" && !!n.level && /^\d/.test(n.heading));
      out.splice(at < 0 ? out.length : at, 0, ...notes);
      out = out.map((n, k) => ({ ...n, order: page * 1000 + k + 1 })); // the client sorts a page by order
    }
  }
  return out;
}

/** Model blocks over earlier nodes: a block whose words match an earlier node of the same kind (Dice >= 0.6) keeps that node's
 * id, so the reader's place does not jump; new blocks get "p003-f01"... in model order. */
export function mergeNodes(page: number, prev: TwinNode[], blocks: Block[]): TwinNode[] {
  const used = new Set<string>();
  const kindOf = (n: TwinNode): BlockKind => (n.kind === "figure" ? "figure" : n.level ? "heading" : n.heading === "Equation" ? "equation" : /^Table\b/.test(n.heading) ? "table" : "paragraph");
  let extra = 0, current = `Page ${page}`;
  return nameFigures(blocks.map((b, i) => {
    let best: TwinNode | undefined, score = 0.6;
    const no = numberOf(b);
    for (const n of prev) {
      if (used.has(n.id) || kindOf(n) !== b.kind) continue;
      const s = no && numberOf({ kind: kindOf(n), text: `${n.heading} ${n.text}` }) === no ? 1 : similar(n.text, b.text); // "Figure 2" is Figure 2
      if (s >= score) [best, score] = [n, s];
    }
    if (best) used.add(best.id);
    if (b.kind === "heading") current = b.text;
    return node(page, best?.id ?? nodeId(page, ++extra, "f"), i + 1, b, current);
  }), page);
}
