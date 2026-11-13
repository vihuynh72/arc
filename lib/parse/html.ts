// Called by lib/server/fetch.ts (any non-MDPI page) and app/api/ingest/route.ts (HTML from the student's own tab).
// Deterministic HTML -> Twin; no model. Checked by scripts/checks/html.ts.
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { Twin, TwinNode } from "@/lib/types";

const MAX_TEXT = 6000;
const JUNK =
  "script,style,noscript,template,nav,header,footer,aside,form,button,svg,iframe,link,meta,[aria-hidden='true'],[hidden],[style*='display:none'],[style*='display: none']," +
  ".mw-editsection,.mw-jump-link,sup.reference,.reference,.reflist,.references,ol.references,.navbox,.vertical-navbox,.toc,#toc,.catlinks,.hatnote,.shortdescription," +
  ".noprint,.ambox,.sistersitebox,.mw-empty-elt,.metadata,[role='navigation'],[role='banner'],[role='contentinfo'],[class*='cookie'],[id*='cookie'],[class*='consent']," +
  "[class*='share-'],[class*='social'],[class*='newsletter'],[class*='breadcrumb'],.ref-list,.citation-list,#references,.sr-only,.visually-hidden";
const ROOTS = ["[itemprop='articleBody']", "#mw-content-text", "article", "main", "[role='main']", "#content", "#main-content", ".article", ".post", ".entry-content", ".post-content", ".article-body"];
const BOILER = /^(references|external links|see also|notes|navigation menu|further reading|related articles|bibliography|citations|sources|footnotes|contents|share|comments)\b/i;
const ICON = /icon|logo|sprite|avatar|badge|pixel|spacer|emoji|flag|button/i;

const squash = (s = "") => s.replace(/\s+/g, " ").trim();
const tidy = (s: string) =>
  squash(s.replace(/\[(\d+(\s*[,–-]\s*\d+)*|[a-z]|citation needed|edit|note \d+)\]/gi, ""))
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
const sentence = (s: string) => (/[.!?:;]$/.test(s) ? s : `${s}.`);

/** The largest candidate in a srcset ("a.jpg 1x, b.jpg 2x" or "a.jpg 400w, b.jpg 800w"). */
const largest = (srcset = "") =>
  srcset
    .split(/,\s+/)
    .map((c) => c.trim().split(/\s+/))
    .filter(([u]) => u)
    .map(([u, d = "1x"]) => ({ u, n: parseFloat(d) || 1 }))
    .sort((a, b) => b.n - a.n)[0]?.u;

export function parseHtml(html: string, url: string): Twin {
  const $ = cheerio.load(html);
  const base = $("base[href]").attr("href") || url;
  const abs = (u?: string) => {
    if (!u || /^(data|blob|javascript):/i.test(u)) return null;
    try {
      return new URL(u, new URL(base, url)).href; // "//host/x" becomes https://host/x on an https page
    } catch {
      return null;
    }
  };
  const meta = (n: string) => squash($(`meta[property="${n}"],meta[name="${n}"]`).first().attr("content"));
  const title = tidy($("h1").first().text()) || meta("og:title") || squash($("title").first().text()) || url;

  // Licence line, read before the footer is removed.
  let credit: string | undefined;
  $("p,li,span,small").each((_, e) => {
    const own = squash($(e).text());
    if (own.length < 300 && /creative commons|\bCC[ -]BY\b/i.test(own) && (!credit || own.length < credit.length)) credit = own;
  });
  if (!credit && $("link[rel='license'],a[rel='license']").first().attr("href")) credit = `Licence: ${$("link[rel='license'],a[rel='license']").first().attr("href")}`;

  $("button:has(img)").each((_, b) => void $(b).replaceWith($(b).contents())); // "click to enlarge" wrappers hold real figures
  $(JUNK).remove();

  const pText = (el: AnyNode) => $(el).find("p").text().length;
  let root: AnyNode | undefined;
  for (const sel of ROOTS) {
    const best = $(sel)
      .toArray()
      .sort((a, b) => pText(b) - pText(a))[0];
    if (best && pText(best) >= 500) {
      root = best;
      break;
    }
  }
  if (!root) {
    // The container whose own paragraphs hold the most text.
    let most = -1;
    $("body, body div, body section").each((_, e) => {
      const n = $(e).children("p").text().length;
      if (n > most) [most, root] = [n, e];
    });
  }
  const $root: cheerio.Cheerio<Element> = root ? $(root as Element) : $("body");

  const nodes: Omit<TwinNode, "id" | "order">[] = [];
  let current: Omit<TwinNode, "id" | "order"> | null = null;
  let lastSection: Omit<TwinNode, "id" | "order"> | null = null;
  let skipBelow = 0; // inside a boilerplate section at this level: skip until a heading at this level or higher
  const seenImg = new Set<string>();
  let figN = 0;
  const add = (t: string) => {
    if (skipBelow || !t) return;
    if (!current) nodes.push((current = lastSection = { kind: "section", level: 2, heading: "Introduction", text: "" }));
    if (current.text.length < MAX_TEXT) current.text = (current.text ? `${current.text}\n\n${t}` : t).slice(0, MAX_TEXT);
  };

  const imgUrl = (img: cheerio.Cheerio<Element>) =>
    abs(img.attr("data-src") || img.attr("data-lazy-src") || img.attr("data-original") || largest(img.attr("srcset") || img.attr("data-srcset")) || img.attr("src"));
  const big = (img: cheerio.Cheerio<Element>) => {
    const w = Number(img.attr("width")) || 0;
    const h = Number(img.attr("height")) || 0;
    if (w || h) return Math.max(w, h) >= 200;
    const sw = /(\d+)w\b/.exec(img.attr("srcset") || img.attr("data-srcset") || "");
    return sw ? Number(sw[1]) >= 400 : !!squash(img.attr("alt"));
  };
  const figure = (img: cheerio.Cheerio<Element>, caption: string, inFigure: boolean) => {
    const src = imgUrl(img);
    if (!src || seenImg.has(src) || ICON.test(`${img.attr("class") ?? ""} ${src}`) || (!inFigure && !big(img))) return;
    seenImg.add(src);
    figN++;
    const alt = squash(img.attr("alt")) || null;
    const own = /^(?:fig(?:ure)?\.?)\s*(\d+(?:\.\d+)*[A-Za-z]?)/i.exec(caption);
    if (skipBelow) return;
    if (!lastSection) nodes.push((current = lastSection = { kind: "section", level: 2, heading: "Introduction", text: "" })); // a lead image belongs to the introduction
    nodes.push({ kind: "figure", level: null, heading: `Figure ${own ? own[1] : figN}`, text: (caption || alt || "No caption.").slice(0, MAX_TEXT), image: { url: src, alt } });
  };

  $root.find("h2,h3,h4,p,li,dd,dt,blockquote,pre,figure,img,table").each((_, el) => {
    const $el = $(el);
    const tag = el.tagName.toLowerCase();
    const inside = (sel: string) => $el.parentsUntil($root).filter(sel).length > 0;
    if (/^h[234]$/.test(tag)) {
      if (inside("figure,table")) return;
      const level = Number(tag[1]);
      const heading = tidy($el.text()).replace(/^(\d+(\.\d+)*\.\s+|\d+\.\d+(\.\d+)*\s+)/, "");
      if (skipBelow && level > skipBelow) return;
      skipBelow = 0;
      if (BOILER.test(heading)) return void (skipBelow = level);
      if (!heading) return;
      nodes.push((current = lastSection = { kind: "section", level, heading, text: "" }));
      return;
    }
    if (tag === "figure") {
      const imgs = $el.find("img").toArray().map((i) => $(i));
      if (!imgs.length) return;
      const pick = imgs.sort((a, b) => (Number(b.attr("width")) || 0) - (Number(a.attr("width")) || 0))[0];
      figure(pick, tidy($el.find("figcaption").first().text() || $el.find("[class*='caption']").first().text()), true);
      current = lastSection;
      return;
    }
    if (tag === "img") {
      if (inside("figure")) return;
      const cap = tidy($el.closest("[class*='thumb'],[class*='image'],[class*='media']").find("[class*='caption']").first().text());
      figure($el, cap, false);
      current = lastSection;
      return;
    }
    if (tag === "table") {
      if (inside("table") || /infobox|navbox|sidebar|metadata|ambox|wikitable-collapsed/i.test($el.attr("class") ?? "") || skipBelow) return;
      const rows = $el.find("tr").toArray();
      const head = $(rows[0]).find("th,td").toArray().map((c) => tidy($(c).text()));
      if (rows.length < 2 || !$(rows[0]).find("th").length || head.every((h) => !h)) return;
      const body = rows.slice(1, 13).map((r) =>
        sentence(
          $(r)
            .find("th,td")
            .toArray()
            .map((c, i) => `${head[i] || `Column ${i + 1}`}: ${tidy($(c).text())}`)
            .join(", "),
        ),
      );
      const caption = tidy($el.find("caption").first().text());
      const n = rows.length - 1;
      nodes.push({ kind: "section", level: Math.min((lastSection?.level ?? 1) + 1, 4), heading: caption || "Table", text: [`A table with ${n} row${n === 1 ? "" : "s"}${n > 12 ? "; the first 12 follow" : ""}.`, ...body].join("\n\n").slice(0, MAX_TEXT) });
      current = lastSection;
      return;
    }
    // Text: skip blocks nested in another counted block, or in a figure or table.
    if (inside("figure,table,li,dd,blockquote") || (tag !== "li" && tag !== "dd" && inside("p"))) return;
    const t = tidy($el.text());
    if (!t) return;
    add(tag === "li" || tag === "dt" || tag === "dd" ? sentence(t) : t);
  });

  // Drop empty sections unless a deeper section follows (they carry the outline).
  const kept = nodes.filter((n, i) => n.kind !== "section" || n.text || (nodes[i + 1]?.kind === "section" && (nodes[i + 1].level ?? 0) > (n.level ?? 0)));
  const out: TwinNode[] = kept.map((n, i) => ({ ...n, id: `n${String(i + 1).padStart(2, "0")}`, order: i + 1 }) as TwinNode);
  const count = (k: TwinNode["kind"]) => out.filter((n) => n.kind === k).length;
  return {
    id: "twin-" + createHash("sha1").update(url).digest("hex").slice(0, 8),
    source: { url, kind: "page", title, via: "direct", ...(credit ? { credit } : {}) },
    nodes: out,
    counts: { sections: count("section"), figures: count("figure"), segments: count("segment") },
  };
}
