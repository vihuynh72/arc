// Plain text (a .txt book, notes) -> Twin. Deterministic: paragraphs from blank lines; headings from "Chapter 12", "BOOK II",
// short ALL-CAPS lines. Project Gutenberg's licence header and footer are cut. Caller: lib/server/fetch.ts. Checked by scripts/checks/text.ts.
import { createHash } from "node:crypto";
import { withLang } from "@/lib/parse/lang";
import type { Block, Twin, TwinNode } from "@/lib/types";

const MAX_TEXT = 6000;
const HEADING = /^(chapter|book|part|section|volume|act|scene|lesson|unit|letter)\b[\s.:]*([0-9]+|[ivxlcdm]+\b|the\s+\w+|one|two|three|four|five|six|seven|eight|nine|ten)/i;

export function parseText(raw: string, url: string): Twin {
  let txt = raw.replace(/\r\n?/g, "\n");
  const gTitle = /^Title:\s*(.+)$/m.exec(txt.slice(0, 5000))?.[1]?.trim();
  const start = /^\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG.*$/im.exec(txt);
  if (start) txt = txt.slice(start.index + start[0].length);
  const end = /^\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG/im.exec(txt);
  if (end) txt = txt.slice(0, end.index);
  // RFC-style pages: running headers and footers ("RFC 2616   HTTP/1.1   June 1999", "...   [Page 12]") are lines set in columns that
  // come back on every page; the table of contents has dot leaders. Both are cut. A line must repeat 3 times, so one real line stays.
  const cols = (l: string) => /\S {3,}\S.* {3,}\S|\[Page \d+\]\s*$/.test(l);
  const key = (l: string) => l.trim().replace(/\d+/g, "#");
  const lines = txt.replace(/\f/g, "\n").split("\n");
  const seen = new Map<string, number>();
  for (const l of lines) if (cols(l)) seen.set(key(l), (seen.get(key(l)) ?? 0) + 1);
  txt = lines.filter((l) => !(cols(l) && seen.get(key(l))! >= 3) && !/\.{4,}\s*\d+\s*$/.test(l)).join("\n");
  // "Title" over a line of ===== or ----- (rst, setext) is a heading; \u0001 marks it for the loop below.
  txt = txt.replace(/^([^\n]{1,80})\n[=\-~]{3,}[ \t]*$/gm, "\n\n\u0001$1\n\n");
  const paras = txt.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
  // Chapter words; "1.2 Purpose" (numbered titles, as in RFCs: short, no closing period); short ALL-CAPS lines that are not a list or a rule.
  const isHeading = (p: string) =>
    p.length <= 80 &&
    !/[=|[\]*]/.test(p) &&
    (HEADING.test(p) ||
      (/^\d+(\.\d+)*\.?\s+[A-Z][\w ,'/&()-]{2,70}$/.test(p) && !/[.;]$/.test(p) && p.split(" ").length <= 9) ||
      (/[A-Z]{3}/.test(p) && !/[a-z]/.test(p) && p.replace(/[^A-Za-z]/g, "").length >= 3 && !/[.,;]$/.test(p.replace(/\.$/, "")) && !/:|(^| )-( |$)/.test(p)));
  const name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "").replace(/\.[a-z0-9]+$/i, "");
  const first = paras[0]?.replace(/^\u0001/, "");
  const title = gTitle ?? (first && first.length <= 100 ? first : name || url);
  const nodes: Omit<TwinNode, "id" | "order">[] = [];
  type Sec = Omit<TwinNode, "id" | "order"> & { blocks: Omit<Block, "id">[] };
  let cur = null as Sec | null;
  const open = (heading: string): Sec => {
    const sec: Sec = { kind: "section", level: 2, heading, text: "", blocks: [] };
    nodes.push(sec);
    return sec;
  };
  for (let p of paras) {
    const marked = p.startsWith("\u0001");
    if (marked) p = p.slice(1);
    if (marked || isHeading(p)) {
      if (cur && !cur.blocks.length && nodes.length) cur.heading = `${cur.heading}: ${p}`; // "BOOK ONE" then "CHAPTER 1"
      else cur = open(p);
      continue;
    }
    if (!cur) cur = open("Beginning");
    const size = cur!.blocks.reduce((n, b) => n + b.text.length, 0);
    if (size + p.length > MAX_TEXT && cur!.blocks.length) cur = open(`${cur!.heading.replace(/ \(continued\)$/, "")} (continued)`);
    cur!.blocks.push({ kind: "paragraph", text: p.slice(0, MAX_TEXT) });
  }
  const out: TwinNode[] = nodes
    .filter((n) => (n as { blocks: unknown[] }).blocks.length)
    .map((n, i) => {
      const id = `n${String(i + 1).padStart(2, "0")}`;
      const blocks = (n as { blocks: Omit<Block, "id">[] }).blocks.map((b, k) => ({ ...b, id: `${id}.b${String(k + 1).padStart(2, "0")}` }));
      return { ...n, id, order: i + 1, text: blocks.map((b) => b.text).join("\n\n"), blocks };
    });
  return withLang({
    id: "twin-" + createHash("sha1").update(url).digest("hex").slice(0, 8),
    source: { url, kind: "page", title, via: "direct" },
    nodes: out,
    counts: { sections: out.length, figures: 0, segments: 0 },
  });
}
