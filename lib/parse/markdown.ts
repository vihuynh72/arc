// Called by app/api/load/route.ts and scripts/checks/parse.ts. Deterministic MDPI markdown -> Twin; no model.
import { createHash } from "node:crypto";
import { withLang } from "@/lib/parse/lang";
import type { Twin, TwinNode } from "@/lib/types";

const clean = (s: string) =>
  s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links to their text
    .replace(/\*\*|__/g, "")
    .replace(/(^|\s)[*_](\S[^*_]*)[*_](?=\s|$|[.,;:])/g, "$1$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!<>~|$])/g, "$1")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** shortcut: written for MDPI article markdown (title as the first "# ", body from the first "## ", references last); other sites need their own rules. */
export function parseMarkdown(md: string, url: string): Twin {
  const lines = md.split(/\r?\n/);
  const titleAt = lines.findIndex((l) => /^# \S/.test(l));
  const title = clean(lines[titleAt >= 0 ? titleAt : 0].replace(/^# /, ""));

  const creditLine = lines.find((l) => /©/.test(l) && /Creative Commons/i.test(l)) ?? lines.find((l) => /Creative Commons/i.test(l));
  const credit = creditLine ? clean(creditLine) : undefined;

  const nodes: TwinNode[] = [];
  const seen = new Set<string>();
  let current: TwinNode | null = null;
  let pendingImage: string | null = null;
  const push = (n: Omit<TwinNode, "id" | "order">) => {
    const order = nodes.length + 1;
    const node = { ...n, id: `n${String(order).padStart(2, "0")}`, order } as TwinNode;
    nodes.push(node);
    return node;
  };

  for (let i = Math.max(titleAt, 0) + 1; i < lines.length; i++) {
    const raw = lines[i].replace(/^\s*[*-]\s{2,}/, "").trim(); // list bullets become plain paragraphs
    if (!raw) continue;
    const h = /^(#{2,6})\s+(.*)$/.exec(raw);
    if (h) {
      const heading = clean(h[2]);
      if (/^references\b/i.test(heading)) break; // the reference list and everything after is site chrome
      pendingImage = null;
      current = heading ? push({ kind: "section", level: h[1].length, heading, text: "" }) : null;
      continue;
    }
    if (!current) continue; // author block, affiliations, menus before the first section
    const img = /^!\[[^\]]*\]\(([^)\s]+)/.exec(raw);
    if (img) {
      pendingImage = /table\.png|\/img\//.test(img[1]) ? null : img[1];
      continue;
    }
    const cap = /^\*\*Figure\s+(\d+)\.\*\*\s*(.*)$/.exec(raw);
    if (cap && pendingImage) {
      const key = `Figure ${cap[1]}`;
      if (!seen.has(key)) {
        seen.add(key);
        const text = clean(cap[2]);
        push({ kind: "figure", level: null, heading: key, text, image: { url: pendingImage, alt: text || null } });
      }
      pendingImage = null;
      continue;
    }
    if (cap) continue; // repeated or imageless figure caption
    pendingImage = null;
    const p = clean(raw);
    if (!p || /^Keywords:?$/i.test(p) || /\/search\?q=/.test(raw)) continue;
    current.text += (current.text ? "\n\n" : "") + p;
  }

  const count = (k: TwinNode["kind"]) => nodes.filter((n) => n.kind === k).length;
  return withLang({
    id: "twin-" + createHash("sha1").update(url).digest("hex").slice(0, 8),
    source: { url, kind: "page", title, via: "cache", credit },
    nodes,
    counts: { sections: count("section"), figures: count("figure"), segments: count("segment") },
  });
}
