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
  "[role='dialog'],[class*='share-'],[class*='social'],[class*='newsletter'],[class*='breadcrumb'],.ref-list,.citation-list,#references,.sr-only,.visually-hidden";
const ROOTS = ["[itemprop='articleBody']", "#mw-content-text", "article", "main", "[role='main']", "#content", "#main-content", ".article", ".post", ".entry-content", ".post-content", ".article-body"];
const BOILER = /^(references|external links|see also|notes|navigation menu|further reading|related articles|bibliography|citations|sources|footnotes|contents|share|comments)\b/i;
// Headings of "more stories" strips: chrome on an article page (only applied when the page has real article text).
const STRIP = /^(most (viewed|read|popular|shared|emailed)|more (from|stories|news)\b|you (may|might) (also )?like|recommended( for you| reading| articles)?$|read next|up next|trending( now)?$|related$|related (articles|stories|posts|content|links|topics|coverage|reading|videos|products|news)\b)/i;
const MAX_CARDS = 60;
const MONEY = /(?:[$€£¥₹]|\b(?:USD|EUR|GBP|CAD|AUD)\s?)\s?\d[\d,]*(?:\.\d{1,2})?/g;
const BADGE = "[class*='badge']";
const BYLINE = "[class*='vendor'],[class*='author'],[class*='byline'],[class*='brand'],[class*='date'],time";
const WAS = "del,s,strike,[class*='compare'],[class*='old-price'],[class*='price--old']";
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
  $(`${BADGE}[aria-hidden]`).removeAttr("aria-hidden"); // Shopify hides its "Sale" / "Sold out" badges from screen readers
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
  let $root: cheerio.Cheerio<Element> = root ? $(root as Element) : $("body");
  const P = pText($root[0]); // article text; a page with plenty of it is an article, whatever cards sit around it

  // Card collections: 3+ sibling blocks of one tag and class, each with a link and a title, small enough to be a card.
  const parseCard = (el: Element) => {
    const $c = $(el);
    const total = squash($c.text());
    if (total.length > 600 || $c.find("h1,h2,h3,h4,h5,h6").length > 1 || $c.find("[data-arc]").length) return null;
    const links = ($c.is("a[href]") ? $c : $c.find("a[href]")).toArray().map((a) => squash($(a).text()));
    if (!$c.is("a[href]") && !$c.find("a[href]").length) return null;
    let $t = $c.find("h2,h3,h4,h5,h6").first();
    if (!$t.length) $t = $c.find("[class*='title'],[class*='heading'],[class*='name']").filter((_, e) => squash($(e).text()).length >= 3).first();
    const words = $t.find("*").addBack().contents().toArray().map((n) => (n.type === "text" ? n.data : "")).join(" "); // "Kicker" and headline sit in separate blocks
    const heading = tidy($t.length ? words : (links.find((l) => l.length >= 3 && l.length <= 120) ?? ""));
    if (heading.length < 3 || heading.length > 200) return null;
    if (!$t.length && !$c.find("img").length && total.length < heading.length + 15) return null; // a bare list of links is not a list of cards
    $t.attr("data-arc-title", "1");
    const badges = [...new Set($c.find(BADGE).toArray().map((b) => tidy($(b).text())))]
      .filter((b) => b && b.length <= 30 && b !== heading)
      .slice(0, 2)
      .map((b) => sentence(/best ?sell/i.test(b) ? "Best seller" : b));
    const priceText = $c.find("[class*='price']").text() || total;
    const was = squash($c.find(WAS).text()).match(MONEY)?.[0];
    const now = [...new Set(priceText.match(MONEY) ?? [])].filter((m) => m !== was);
    const num = (m = "") => parseFloat(m.replace(/[^\d.]/g, "")) || 0;
    const price = now.length ? `Price: ${now[0]}${was && num(was) > num(now[0]) ? `, was ${was}` : ""}.` : num(was) ? `Price: ${was}.` : ""; // Shopify prints a $0.00 compare-at price on items not on sale
    const $w = $c.clone();
    $w.find(`[data-arc-title],[class*='price'],${BADGE},del,s,strike,img`).remove();
    const by = $w.find(BYLINE).toArray().map((b) => tidy($(b).text())).filter((b) => b && b.length <= 80);
    $w.find(BYLINE).remove();
    const rest: string[] = [];
    $w.find("*").addBack().contents().each((_, n) => {
      const t = n.type === "text" ? tidy($(n).text()) : "";
      if (t && !heading.includes(t) && !/^(regular|sale|unit) price$|^[/|·•]$|^per$/i.test(t) && !rest.includes(t)) rest.push(t);
    });
    const text = [...badges, price, ...[...new Set(by)].slice(0, 2).map(sentence), ...rest.slice(0, 3).map(sentence)].filter(Boolean).join(" ").slice(0, 600);
    return { el, heading, text: text || "No details.", chars: total.length };
  };
  type Card = NonNullable<ReturnType<typeof parseCard>>;
  const clusters: Card[][] = [];
  $("body *").toArray().reverse().forEach((e) => { // inner containers first, so a card never swallows a smaller collection
    const kids = $(e).children().toArray();
    if (kids.length < 3) return;
    const groups = new Map<string, Element[]>();
    for (const k of kids) {
      const key = `${k.tagName}.${(k.attribs.class ?? "").split(/\s+/)[0]}`;
      groups.set(key, [...(groups.get(key) ?? []), k]);
    }
    for (const g of groups.values()) {
      if (g.length < 3) continue;
      const cards = g.map(parseCard).filter((c): c is Card => !!c);
      if (cards.length < 3 || cards.length < g.length * 0.6) continue;
      cards.forEach((c) => void $(c.el).attr("data-arc", "1"));
      clusters.push(cards);
    }
  });
  const cardChars = clusters.flat().reduce((n, c) => n + c.chars, 0);
  const cardData: { heading: string; text: string; ci: number }[] = [];
  const isCard = new Map<object, number>(); // card node -> its collection, so two collections never read as one list
  if (clusters.length && (P < 1500 || cardChars > P)) {
    const main = $("main,[role='main']").first();
    const all = clusters.flat();
    if (!all.every((c) => $.contains($root[0], c.el))) $root = main.length && all.every((c) => $.contains(main[0], c.el)) ? (main as cheerio.Cheerio<Element>) : $("body");
    for (const [ci, cards] of clusters.entries()) {
      const seen = new Set<string>();
      for (const c of cards) {
        const key = `${c.heading}|${c.text}`;
        $(c.el).replaceWith(`<arc-card data-i="${seen.has(key) ? -1 : cardData.push({ ...c, ci }) - 1}"></arc-card>`); // slider clones repeat a card
        seen.add(key);
      }
    }
  }

  const nodes: Omit<TwinNode, "id" | "order">[] = [];
  let current: Omit<TwinNode, "id" | "order"> | null = null;
  let lastSection: Omit<TwinNode, "id" | "order"> | null = null;
  let skipBelow = 0; // inside a boilerplate section at this level: skip until a heading at this level or higher
  const seenImg = new Set<string>();
  let figN = 0;
  const add = (t: string) => {
    if (skipBelow || !t) return;
    if (!current) nodes.push((current = lastSection = { kind: "section", level: lastSection?.level ?? 2, heading: lastSection ? "More on this page" : "Introduction", text: "" })); // after a run of cards, loose text gets its own section
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

  $root.find("h2,h3,h4,p,li,dd,dt,blockquote,pre,figure,img,table,arc-card").each((_, el) => {
    const $el = $(el);
    const tag = el.tagName.toLowerCase();
    if (tag === "arc-card") {
      const c = cardData[Number($el.attr("data-i"))];
      if (skipBelow || !c) return;
      const n = { kind: "section" as const, level: Math.min((lastSection?.level ?? 1) + 1, 4), heading: c.heading, text: c.text };
      isCard.set(n, c.ci);
      nodes.push(n);
      current = null;
      return;
    }
    const inside = (sel: string) => $el.parentsUntil($root).filter(sel).length > 0;
    if (/^h[234]$/.test(tag)) {
      if (inside("figure,table")) return;
      const level = Number(tag[1]);
      const heading = tidy($el.text()).replace(/^(\d+(\.\d+)*\.\s+|\d+\.\d+(\.\d+)*\s+)/, "");
      if (skipBelow && level > skipBelow) return;
      skipBelow = 0;
      if (BOILER.test(heading) || (P >= 800 && STRIP.test(heading))) return void (skipBelow = level);
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

  // A run of cards: the heading before it says how many there are; at most MAX_CARDS are kept.
  const shaped: typeof nodes = [];
  for (let i = 0; i < nodes.length; ) {
    if (!isCard.has(nodes[i])) {
      shaped.push(nodes[i++]);
      continue;
    }
    let j = i;
    while (j < nodes.length && isCard.get(nodes[j]) === isCard.get(nodes[i])) j++;
    const run = nodes.slice(i, j);
    const head = shaped[shaped.length - 1];
    if (head?.kind === "section" && !isCard.has(head)) head.text = [head.text, `${run.length} item${run.length === 1 ? "" : "s"}.`].filter(Boolean).join("\n\n");
    shaped.push(...run.slice(0, MAX_CARDS));
    if (run.length > MAX_CARDS) shaped.push({ kind: "section", level: run[0].level, heading: "More items", text: `${run.length - MAX_CARDS} more items not shown.` });
    i = j;
  }
  nodes.splice(0, nodes.length, ...shaped);

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
