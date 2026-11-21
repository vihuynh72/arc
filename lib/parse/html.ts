// Called by lib/server/fetch.ts (any non-MDPI page) and app/api/ingest/route.ts (HTML from the student's own tab).
// Deterministic HTML -> Twin; no model. Checked by scripts/checks/html.ts and scripts/checks/math.ts.
// Order: math to placeholders, page furniture out (tags, roles, class/id words, link density), the main container picked,
// then one walk in document order that emits sections, figures and each section's blocks (paragraph, item, quote, table, equation).
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { Block, Twin, TwinNode } from "@/lib/types";
import { withLang } from "@/lib/parse/lang";
import { mathmlToTex, texToSpeech, type Math } from "@/lib/parse/math";
import { cleanTitle } from "@/lib/parse/title";

const MAX_TEXT = 6000; // a longer section continues in a second node with the same heading
const JUNK =
  "script,style,noscript,template,nav,header,footer,aside,form,button,iframe,link,meta,input,select,textarea,[aria-hidden='true'],[hidden],[style*='display:none'],[style*='display: none']," +
  ".mw-editsection,.mw-jump-link,sup.reference,.reference,.reflist,.references,ol.references,.navbox,.vertical-navbox,.toc,#toc,.catlinks,.hatnote,.shortdescription," +
  ".noprint,.ambox,.sistersitebox,.mw-empty-elt,.metadata,[role='navigation'],[role='banner'],[role='contentinfo'],[role='tablist'],[role='toolbar'],[role='search'],[role='menu'],[role='menubar']," +
  "[role='dialog'],[role='alertdialog'],.ref-list,.citation-list,#references,.sr-only,.visually-hidden,.screen-reader-text,.ltx_page_footer,.ltx_page_header,.ltx_role_footnote,.ltx_note_outer," +
  "pre.bibtex-citation,xpl-footer,#xploreFooter,.stats-footer"; // Semantic Scholar's BibTeX block; IEEE Xplore's two footers (account links, help phone numbers)
// Class or id words that mark furniture. Matched as whole words of the class/id (split on - _ space), never on the main container.
const FURNITURE = new Set(
  ("toc tocs breadcrumb breadcrumbs skip skiplink skip-link share sharing social cookie cookies consent gdpr banner metrics altmetric altmetrics citation-tools cite-this " +
    "reference-manager export-citation subnav pagination pager sidebar sidenav navbar menu menus advert advertisement ads promo newsletter signup login " +
    "tabs tablist toolbar related-articles recommended edit-link editlink print-only feedback rating survey extra-services labstabs submission-history").split(" "),
);
const FURNITURE_PAIRS = /(?:^|[\s_-])(table-of-contents|skip-to|share-?(?:bar|buttons|links|tools)|social-?(?:links|share|buttons)|cookie-?(?:banner|notice)|article-?(?:metrics|tools|nav|tabs)|reading-?tools|related-?(?:content|articles))(?:$|[\s_-])/i;
// Known main containers, tried first: Wikipedia, arXiv LaTeXML, Nature/Springer, PLOS, SEP, LibreTexts, OpenStax, PMC, MDN, generic.
const ROOTS = [
  ".ltx_document", "#mw-content-text .mw-parser-output", "#mw-content-text", "[itemprop='articleBody']", ".c-article-body", "#artText", ".article-text", "#aueditable",
  ".mt-content-container", ".markdown-body",
  "article", "main", "[role='main']", "#content", "#main-content", ".article", ".post", ".entry-content", ".post-content", ".article-body",
];
const BOILER =
  /^(references|external links|see also|notes|navigation menu|further reading|related articles|bibliography|citations|sources|footnotes|contents|table of contents|share|comments|academic tools|other internet resources|related entries|entry navigation|entry contents|cited by|metrics|article metrics|cite this article|rights and permissions|about this article|author information|authors and affiliations|ethics declarations|competing interests|author contributions|acknowledge?ments?|funding|additional information|reprints and permissions|peer review( information)?|change history|download (pdf|citation)|access options|subscribe|log ?in|sign ?in|publisher'?s note|supplementary (information|materials?)|figures|tables|loading|want to join the conversation|supporting information|buy now|buy (this )?article|access this article|rent or buy|purchase options|questions and answers|tips (&|and) thanks|up next)\b/i;
// Headings of "more stories" strips: chrome on an article page (only applied when the page has real article text).
const STRIP = /^(most (viewed|read|popular|shared|emailed)|more (from|stories|news)\b|you (may|might) (also )?like|recommended( for you| reading| articles)?$|read next|up next|trending( now)?$|related$|related (articles|stories|posts|content|links|topics|coverage|reading|videos|products|news)\b)/i;
const MAX_CARDS = 60;
// Download and enlarge links left beside figures ("PNG larger image", "Download: PPT"), and blocks that are only an address.
const LINK_ONLY = /^(\d+\.\s*)?((png|tiff?|jpe?g|gif|pdf|pptx?|csv|xlsx?|zip)\b.{0,30}|(download|larger image|original image|full size image|view (larger|figure|table|full size)|open in (a )?new tab|enlarge|expand|zoom in|slide|powerpoint slide)\b.{0,25}|https?:\/\/\S+\.?)$/i;
// Article front and back matter lines that are not reading ("Citation: ...", "Received: ...").
const FRONT = /^((citation|editor|received|accepted|published|copyright|data availability|funding|competing interests|academic editor|cite this article|how to cite|doi|keywords?)\s*:|this page was last (modified|edited|updated)\b|price excludes vat|instant access to the full article)/i;
const MONEY = /(?:[$€£¥₹]|\b(?:USD|EUR|GBP|CAD|AUD)\s?)\s?\d[\d,]*(?:\.\d{1,2})?/g;
const BADGE = "[class*='badge']";
const BYLINE = "[class*='vendor'],[class*='author'],[class*='byline'],[class*='brand'],[class*='date'],time";
const WAS = "del,s,strike,[class*='compare'],[class*='old-price'],[class*='price--old']";
const ICON = /icon|logo|sprite|avatar|badge|pixel|spacer|emoji|flag|button|orcid|headshot|profile-?(pic|photo|image)|author-?(photo|image)|placeholder|spinner|blank\.gif|transparent\.(gif|png)|1x1|tracking|beacon|gravatar|\/ads?\//i;
const IMG_FILE = /\.(jpe?g|png|gif|webp|svg|avif)(?:$|[?#])/i;

const squash = (s = "") => s.replace(/\s+/g, " ").trim();
const tidy = (s: string) =>
  squash(s.replace(/\[(\d+(\s*[,–-]\s*\d+)*|[a-z]|citation needed|edit|note \d+)\]/gi, "").replace(/[⁠​‌‍﻿]/g, ""))
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
const sentence = (s: string) => (/[.!?:;]$/.test(s) ? s : `${s}.`);
const words = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The largest candidate in a srcset ("a.jpg 1x, b.jpg 2x" or "a.jpg 400w, b.jpg 800w"). */
const largest = (srcset = "") =>
  srcset
    .split(/,\s+/)
    .map((c) => c.trim().split(/\s+/))
    .filter(([u]) => u)
    .map(([u, d = "1x"]) => ({ u, n: parseFloat(d) || 1 }))
    .sort((a, b) => b.n - a.n)[0]?.u;

/** Code's notes on blocks it could not finish: the background model pass (lib/server/pageQueue.ts) reads them. Not serialised. */
export type Trouble = { node: string; why: "equation" | "table" | "links" | "furniture"; blocks: string[]; images?: Record<string, string> };
const troubles = new WeakMap<Twin, Trouble[]>();
export const troublesOf = (t: Twin) => troubles.get(t) ?? [];

type Draft = Omit<Block, "id"> & { ld?: number; hard?: "equation" | "table"; img?: string };
type Sec = Omit<TwinNode, "id" | "order" | "blocks"> & { blocks?: Draft[] };

/** `httpLang`: the response's content-language header, when the caller has it. */
export function parseHtml(html: string, url: string, httpLang?: string | null): Twin {
  const $ = cheerio.load(html);
  const htmlLang = $("html").attr("lang") || $("html").attr("xml:lang") || $("meta[http-equiv='content-language' i]").attr("content") || httpLang || $("meta[property='og:locale']").attr("content");
  const htmlDir = $("html").attr("dir") || $("body").attr("dir");
  const base = $("base[href]").attr("href") || url;
  const abs = (u?: string) => {
    if (!u || /^(blob|javascript):/i.test(u)) return null;
    if (/^data:/i.test(u)) return /^data:image\/svg\+xml/i.test(u) && u.length > 400 ? u : null; // a data: raster is almost always a lazy placeholder
    try {
      return new URL(u, new URL(base, url)).href; // "//host/x" becomes https://host/x on an https page
    } catch {
      return null;
    }
  };
  const meta = (n: string) => squash($(`meta[property="${n}"],meta[name="${n}"]`).first().attr("content"));

  // arXiv abstract pages: title, authors, abstract and where the full text is. Built here so the rest of the walk reads it plainly.
  arxivAbstract($, url);
  scholarPaper($);

  // Math first: some of it sits in display:none MathML or in images that the furniture pass removes.
  const maths: (Math & { display: boolean; image?: string })[] = [];
  const place = (el: AnyNode, m: Math | null, display: boolean, image?: string) => {
    if (!m) return void $(el).remove();
    $(el).replaceWith(`<arc-math data-i="${maths.push({ ...m, display, image }) - 1}"${display ? ' data-display="1"' : ""}></arc-math>`);
  };
  const tex = (s: string): Math | null => (/\\(?:newcommand|renewcommand|def|require)\b/.test(s) || !s.trim() ? null : texToSpeech(s));
  $("mjx-container").each((_, el) => {
    const m = $(el).find("math").first();
    const t = m.length ? texOfMath($, m[0]) : "";
    place(el, t ? tex(t) : null, $(el).attr("display") === "true" || $(el).attr("display") === "block");
  });
  $(".MathJax_Preview,.MathJax,.MathJax_Display,.MathJax_SVG,.MathJax_CHTML").remove();
  $("script[type^='math/tex']").each((_, el) => void place(el, tex($(el).text()), /mode=display/.test($(el).attr("type") ?? "")));
  $("math").each((_, el) => {
    if (!$.contains($.root()[0], el)) return; // already replaced with an outer one
    const display = $(el).attr("display") === "block" || /block|display/.test($(el).attr("class") ?? "") || $(el).parent().is(".mwe-math-element-block,.mwe-math-display");
    place(el, tex(texOfMath($, el)), display);
  });
  $("img.mwe-math-fallback-image-inline,img.mwe-math-fallback-image-display,img.tex,img.latex,img[class*='equation'],img[class*='formula'],.inline-formula img,.disp-formula img,img.inline-graphic").each((_, el) => {
    const alt = $(el).attr("alt") ?? "";
    const display = /display|block/.test(`${$(el).attr("class") ?? ""} ${$(el).parent().attr("class") ?? ""}`);
    if (/[\\^_{}=]/.test(alt)) return void place(el, tex(alt), display);
    // image-only equation: shown as the picture, spoken by the model later
    place(el, { text: alt || (display ? "[equation shown as a picture]" : "[formula]"), say: alt || (display ? "An equation shown as a picture." : "a formula"), ok: false }, display, abs($(el).attr("data-src") || $(el).attr("src")) ?? undefined);
  });
  texInText($, (s, display) => {
    const m = tex(s);
    return m ? `<arc-math data-i="${maths.push({ ...m, display }) - 1}"${display ? ' data-display="1"' : ""}></arc-math>` : "";
  });

  // Wikipedia's {{sfrac}} / {{frac}}: the slash sits in a .sr-only span that the furniture pass removes, so "1/2" would read "12".
  $("span.sfrac,span.frac").each((_, el) => {
    const $f = $(el);
    const tion = $f.is(".sfrac") ? $f.find(".tion").first() : $f;
    const n = squash((tion.find(".num").first().length ? tion.find(".num") : tion.children("sup")).first().text());
    const d = squash((tion.find(".den").first().length ? tion.find(".den") : tion.children("sub")).first().text());
    if (!n || !d) return;
    const whole = squash($f.clone().find(".tion,sup,sub,.num,.den,.sr-only").remove().end().text().replace(/[\u2060\u00a0\u2009\u2044]/g, " "));
    const prev = (el as Element).prev;
    const mixed = whole || (prev?.type === "text" && /\d$/.test((prev as unknown as { data: string }).data)); // 2 then 1/4: "2 1/4", not "2(1/4)"
    place(el, mixed ? { text: `${whole} ${n}/${d}`, say: `${whole} and ${n} over ${d}`, ok: true } : { text: `(${n}/${d})`, say: `${n} over ${d}`, ok: true }, false);
  });

  // Title: the scholarly tag, else the h1 inside the main content, else og:title, else any h1 that is not a banner, else <title>.
  // A sign-up banner's h1 ("Join Stack Overflow") sits outside main; site names are cut ("- Wikipedia").
  const site = meta("og:site_name");
  const h1s = $("h1").filter((_, e) => !$(e).closest("nav,[role='banner'],[role='dialog'],[class*='logo'],[class*='brand'],[class*='masthead'],[class*='banner'],[class*='signup'],[class*='modal'],body > header").length);
  const inMain = h1s.filter((_, e) => $(e).closest("main,article,[role='main'],#content,#mainbar,#question-header,.mw-body,#main-content").length > 0).first()[0];
  const h1Text = (e: AnyNode | undefined) => tidy(both($, e, maths).shown);
  const title = meta("citation_title") || h1Text(inMain) || cleanTitle(meta("og:title"), site) || h1Text(h1s.first()[0]) || cleanTitle(squash($("title").first().text()), site) || url;

  // Licence line, read before the footer is removed.
  let credit: string | undefined;
  $("p,li,span,small").each((_, e) => {
    const own = squash($(e).text());
    if (own.length < 300 && /creative commons|\bCC[ -]BY\b/i.test(own) && (!credit || own.length < credit.length)) credit = own;
  });
  if (!credit && $("link[rel='license'],a[rel='license']").first().attr("href")) credit = `Licence: ${$("link[rel='license'],a[rel='license']").first().attr("href")}`;

  // arXiv HTML (LaTeXML) embeds figure files as <object data="x.svg" type="image/svg+xml">: the same picture as an <img>.
  $("figure object[data], [class*='figure'] object[data]").each((_, el) => {
    const $o = $(el);
    const data = $o.attr("data") ?? "";
    if (!/^image\//i.test($o.attr("type") ?? "") && !/\.(svg|png|jpe?g|gif|webp)$/i.test(data)) return;
    $o.replaceWith(`<img src="${data.replace(/"/g, "&quot;")}" alt="" width="${Number($o.attr("width")) || 400}">`);
  });
  // Inline SVG figures become images before svg is removed with the furniture.
  $("figure svg, [class*='figure'] svg").each((_, el) => {
    const $s = $(el);
    const fig = $s.closest("figure,[class*='figure']");
    if (fig.find("img").length || $s.parents("svg").length) return;
    const markup = $.html(el);
    const w = Number($s.attr("width")) || Number(($s.attr("viewBox") ?? "").split(/\s+/)[2]) || 0;
    if (markup.length > 400_000 || (w && w < 100)) return void $s.remove();
    const src = `data:image/svg+xml;base64,${Buffer.from(markup.includes("xmlns=") ? markup : markup.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"')).toString("base64")}`;
    $s.replaceWith(`<img src="${src}" alt="${($s.find("title").first().text() || $s.attr("aria-label") || "").replace(/"/g, "&quot;")}" width="${w || 400}">`);
  });

  // The pages under this one (a course home's Syllabus, Lectures, ...), read before menus are removed: a thin hub page lists them.
  const here = (() => {
    try {
      return new URL(url).pathname.replace(/\/?$/, "/");
    } catch {
      return "/";
    }
  })();
  const under: string[] = [];
  $("a[href]").each((_, a) => {
    const href = abs($(a).attr("href"));
    const name = squash($(a).text());
    if (!href || !name || name.length > 80 || under.includes(name) || under.length >= 30) return;
    try {
      const u = new URL(href);
      if (u.host === new URL(url).host && u.pathname.startsWith(here) && u.pathname.replace(/\/?$/, "/") !== here && here !== "/") under.push(name);
    } catch {
      // not an address
    }
  });

  $("button:has(img)").each((_, b) => void $(b).replaceWith($(b).contents())); // "click to enlarge" wrappers hold real figures
  $(`${BADGE}[aria-hidden]`).removeAttr("aria-hidden"); // Shopify hides its "Sale" / "Sold out" badges from screen readers
  $(JUNK).not("arc-math").remove();
  $("svg").remove();

  const textLen = (el: AnyNode) => $(el).find("p,dd,blockquote,li").not("li li").text().length + $(el).find("arc-math").length * 20;
  const bodyText = textLen($("body")[0] ?? $.root()[0]) || 1;
  // Furniture by class or id words, unless the element holds much of the page's text (a layout wrapper, not a widget).
  $("body [class], body [id]").each((_, el) => {
    if (!$.contains($.root()[0], el)) return;
    const name = `${(el as Element).attribs.class ?? ""} ${(el as Element).attribs.id ?? ""}`.toLowerCase();
    // the whole word, or its last part ("c-article-sidebar", "vector-toc"); a first part is a qualifier ("toc-section" is content)
    const hit = name.split(/\s+/).some((w) => FURNITURE.has(w) || FURNITURE.has(w.split(/[_-]+/).pop() ?? "")) || FURNITURE_PAIRS.test(name);
    if (!hit || /^(html|body|main|article)$/i.test((el as Element).tagName)) return;
    if (textLen(el) > bodyText * 0.3) return;
    $(el).remove();
  });

  let root: AnyNode | undefined;
  for (const sel of ROOTS) {
    const best = $(sel)
      .toArray()
      .sort((a, b) => textLen(b) - textLen(a))[0];
    if (best && textLen(best) >= 500) {
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
  const P = $root.find("p").text().length; // article text; a page with plenty of it is an article, whatever cards sit around it

  // Link-dense blocks inside the article (tabs, link rails, "View PDF / HTML / TeX" strips) are menus, not reading.
  const linkDensity = (el: AnyNode) => {
    const all = squash($(el).text()).length;
    return all ? squash($(el).find("a").text()).length / all : 0;
  };
  $root.find("ul,ol,div,section,p,dl,table").each((_, el) => {
    if (!$.contains($.root()[0], el) || $(el).find("arc-math,img,figure").length) return;
    const all = squash($(el).text()).length;
    if (!all || all > 3000 || linkDensity(el) < 0.7) return;
    if ($(el).find("a").length <= 3 && all < 160) return; // "Instructor: Prof. Strang" is a value that happens to be a link, not a menu
    const tag = (el as Element).tagName;
    const prev = $(el).prevAll().first();
    if ((tag === "ul" || tag === "ol") && prev.is("p") && /:\s*$/.test(prev.text())) return; // a list the text introduces is content
    if ($(el).find("p").toArray().some((p) => squash($(p).text()).length - squash($(p).find("a").text()).length >= 100)) return;
    $(el).remove();
  });

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

  const nodes: Sec[] = [];
  let current: Sec | null = null;
  let lastSection: Sec | null = null;
  let skipBelow = 0; // inside a boilerplate section at this level: skip until a heading at this level or higher
  const seenImg = new Set<string>();
  let figN = 0;
  const len = (n: Sec) => (n.blocks ?? []).reduce((k, b) => k + b.text.length + 2, 0);
  const add = (b: Draft) => {
    if (skipBelow || !b.text) return;
    if (!current) nodes.push((current = lastSection = { kind: "section", level: lastSection?.level ?? 2, heading: lastSection ? "More on this page" : "Introduction", text: "", blocks: [] })); // after a run of cards, loose text gets its own section
    if (len(current) + b.text.length > MAX_TEXT && current.blocks?.length) {
      const h = current.heading.replace(/ \(continued\)$/, "");
      nodes.push((current = lastSection = { kind: "section", level: current.level, heading: `${h} (continued)`, text: "", blocks: [] }));
    }
    (current.blocks ??= []).push({ ...b, text: b.text.slice(0, MAX_TEXT) });
  };

  const imgUrl = (img: cheerio.Cheerio<Element>) => {
    const full = img.closest("a[href]").attr("href");
    const fullPath = (() => {
      try {
        return new URL(full ?? "", url).pathname;
      } catch {
        return "";
      }
    })();
    // A thumbnail that links to its full-size picture. Not a wiki file page: those are /wiki/<namespace>:<name>, and the namespace
    // is a different word in every language (File, Archivo, Datei, Fichier, Tập tin ...), so the shape is tested, not the word.
    if (full && IMG_FILE.test(fullPath) && !/^data:|\/wiki\/[^/?#]+(?::|%3A)|\/(File|Image|Datei|Fichier):/i.test(full)) return abs(full);
    const srcPath = (() => {
      try {
        return new URL(img.attr("src") ?? "", base).pathname;
      } catch {
        return "";
      }
    })();
    if (full && srcPath && fullPath === srcPath && /size=(large|medium|original)/i.test(full)) return abs(full); // PLOS: same picture, larger size
    const picture = img.parent("picture").find("source[srcset],source[data-srcset]").toArray().map((s) => largest($(s).attr("srcset") || $(s).attr("data-srcset")))[0];
    return abs(
      img.attr("data-src") || img.attr("data-lazy-src") || img.attr("data-original") || img.attr("data-full-src") || img.attr("data-hi-res-src") ||
        largest(img.attr("srcset") || img.attr("data-srcset")) || picture || img.attr("src"),
    );
  };
  const dims = (img: cheerio.Cheerio<Element>) => [parseFloat(img.attr("width") ?? "") || 0, parseFloat(img.attr("height") ?? "") || 0];
  const big = (img: cheerio.Cheerio<Element>) => {
    const [w, h] = dims(img);
    if (w || h) return Math.max(w, h) >= 200;
    const sw = /(\d+)w\b/.exec(img.attr("srcset") || img.attr("data-srcset") || "");
    return sw ? Number(sw[1]) >= 400 : !!squash(img.attr("alt"));
  };
  const figure = (img: cheerio.Cheerio<Element>, caption: string, inFigure: boolean) => {
    const src = imgUrl(img);
    const [w, h] = dims(img);
    const decorative = (w && w <= 60) || (h && h <= 40) || img.attr("role") === "presentation" || img.attr("alt") === "" && !inFigure;
    if (!src || seenImg.has(src) || ICON.test(`${img.attr("class") ?? ""} ${img.attr("alt") ?? ""} ${src}`) || decorative || (!inFigure && !big(img))) return;
    seenImg.add(src);
    figN++;
    const alt = (squash(img.attr("alt")) || null)?.replace(/^(thumbnail|image|img|figure|photo|picture|graphic|untitled|click to (enlarge|zoom))$/i, "") || null;
    const own = /^(?:fig(?:ure)?\.?)\s*(\d+(?:\.\d+)*[A-Za-z]?)/i.exec(caption);
    if (skipBelow) return;
    if (!lastSection) nodes.push((current = lastSection = { kind: "section", level: 2, heading: "Introduction", text: "", blocks: [] })); // a lead image belongs to the introduction
    nodes.push({ kind: "figure", level: null, heading: `Figure ${own ? own[1] : figN}`, text: (caption || alt || "No caption.").slice(0, MAX_TEXT), image: { url: src, alt } });
  };
  const said = (el: AnyNode) => both($, el, maths);
  const eqBlock = (els: AnyNode[], number = "") => {
    const ms = els.map((e) => maths[Number($(e).attr("data-i"))]).filter(Boolean);
    if (!ms.length) return;
    const text = ms.map((m) => m.text).join("; ") + (number ? ` ${number}` : "");
    const say = (number ? `Equation ${number.replace(/[()]/g, "")}: ` : "") + ms.map((m) => m.say).join("; then ");
    const img = ms.find((m) => m.image)?.image;
    add({ kind: "equation", text, say, ...(ms.some((m) => !m.ok) ? { hard: "equation" as const } : {}), ...(img ? { img } : {}) });
  };

  // "Abstract" set as a small heading (LaTeXML h6, many journals h3/h5) is a top-level part of the paper.
  $root.find("h5,h6").filter((_, h) => /^abstract\.?$/i.test(squash($(h).text()))).each((_, h) => void ((h as Element).tagName = "h2"));
  // Text sitting straight in a div (no <p>) is a paragraph too.
  $root.find("div").each((_, d) => {
    const own = (d as Element).children.filter((c) => c.type === "text").map((c) => (c as unknown as { data: string }).data).join("");
    if (squash(own).length >= 80) (d as Element).attribs["data-arc-text"] = "1";
  });

  $root.find("h2,h3,h4,p,li,dd,dt,blockquote,pre,figure,img,table,arc-card,arc-math[data-display],div[data-arc-text]").each((_, el) => {
    const $el = $(el);
    const tag = el.tagName.toLowerCase();
    if (tag === "arc-card") {
      const c = cardData[Number($el.attr("data-i"))];
      if (skipBelow || !c) return;
      const n: Sec = { kind: "section" as const, level: Math.min((lastSection?.level ?? 1) + 1, 4), heading: c.heading, text: c.text };
      isCard.set(n, c.ci);
      nodes.push(n);
      current = null;
      return;
    }
    const inside = (sel: string) => $el.parentsUntil($root).filter(sel).length > 0;
    if (/^h[234]$/.test(tag)) {
      if (inside("figure,table")) return;
      const level = Number(tag[1]);
      const heading = tidy(said(el).shown).replace(/^(\d+(\.\d+)*\.\s+|\d+\.\d+(\.\d+)*\s+)/, "");
      if (skipBelow && level > skipBelow) return;
      skipBelow = 0;
      if (BOILER.test(heading) || (P >= 800 && STRIP.test(heading))) return void (skipBelow = level);
      if (!heading) return;
      nodes.push((current = lastSection = { kind: "section", level, heading, text: "", blocks: [] }));
      return;
    }
    if (tag === "figure") {
      if (inside("figure")) return;
      const imgs = $el.find("img").toArray().map((i) => $(i));
      const caption = tidy(said($el.find("figcaption").first()[0] ?? $el.find("[class*='caption']").first()[0] ?? $.root()[0]).shown);
      if (!imgs.length) {
        if ($el.find("table").length) return; // a table figure: its table is read below
        const ms = $el.find("arc-math").toArray();
        if (ms.length) eqBlock(ms);
        return;
      }
      const pick = imgs.sort((a, b) => dims(b)[0] - dims(a)[0])[0];
      figure(pick, $el.find("figcaption,[class*='caption']").length ? caption : "", true);
      current = lastSection;
      return;
    }
    if (tag === "img") {
      if (inside("figure")) return;
      // The caption sits in the figure-like box around the image (PLOS div.figure > .figcaption; Wikipedia .thumb > .thumbcaption).
      const box = $el.parents("[class*='fig'],[class*='thumb'],[class*='image'],[class*='media']").filter((_, b) => $(b).find("[class*='caption'],figcaption").length > 0).first();
      const cap = tidy(said(box.find("figcaption,[class*='caption']").first()[0] ?? $.root()[0]).shown);
      figure($el, cap, false);
      current = lastSection;
      return;
    }
    if (tag === "arc-math") {
      if (inside("p,li,dd,dt,blockquote,table,figure,h2,h3,h4")) return; // read with the block it sits in
      return eqBlock([el]);
    }
    if (tag === "table") {
      if (inside("table") || skipBelow) return;
      if (/ltx_equation|ltx_eqn/.test($el.attr("class") ?? "")) {
        const no = tidy($el.find(".ltx_eqn_eqno,.ltx_tag_equation").first().text());
        return eqBlock($el.find("arc-math").toArray(), no);
      }
      if (/infobox|navbox|sidebar|metadata|ambox|wikitable-collapsed|vertical-navbox/i.test($el.attr("class") ?? "")) return;
      const t = table($, el, maths);
      if (t) add(t);
      return;
    }
    // Text: skip blocks nested in another counted block, or in a figure or table.
    if (inside("figure,table,dd,blockquote,figcaption,[class*='figcaption'],[class*='caption_'],[class*='fig-caption']") || (tag !== "li" && inside("li")) || (tag !== "li" && tag !== "dd" && inside("p")) || (tag === "div" && inside("p,li,dd,blockquote,pre"))) return;
    const own = tag === "li" ? $el.clone().children("ul,ol").remove().end() : tag === "div" ? $("<p></p>").append($el.contents().clone().filter((_, c) => c.type === "text" || !/^(div|p|ul|ol|table|figure|section|h\d)$/i.test((c as Element).tagName))) : $el;
    const { shown, spoken, only } = said(own[0]);
    if (only != null && (tag === "p" || tag === "dd" || tag === "dt" || tag === "div")) return eqBlock([only]); // a paragraph that is just a display formula
    const text = tidy(shown);
    if (!text || (tag === "p" && FRONT.test(text)) || LINK_ONLY.test(text)) return;
    const ld = linkDensity(own[0]);
    let kind: Block["kind"] = tag === "li" ? "item" : tag === "blockquote" ? "quote" : "paragraph";
    let prefix = "";
    if (tag === "li" && $el.parent().is("ol")) prefix = `${Number($el.parent().attr("start") ?? 1) + $el.prevAll("li").length}. `;
    if (tag === "dt") kind = "paragraph";
    const say = tidy(spoken);
    const finish = (s: string) => (tag === "li" || tag === "dt" ? sentence(s) : s);
    const inner = $el.find("arc-math").toArray().map((m) => maths[Number($(m).attr("data-i"))]).filter(Boolean);
    const hardEq = inner.some((m) => !m.ok);
    const img = inner.find((m) => m.image)?.image;
    add({ kind, text: prefix + finish(text), ...(say !== text ? { say: prefix + finish(say) } : {}), ...(ld >= 0.5 ? { ld } : {}), ...(hardEq ? { hard: "equation" as const } : {}), ...(img ? { img } : {}) });
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
    if (head?.kind === "section" && !isCard.has(head)) (head.blocks ??= []).push({ kind: "paragraph", text: `${run.length} item${run.length === 1 ? "" : "s"}.` });
    shaped.push(...run.slice(0, MAX_CARDS));
    if (run.length > MAX_CARDS) shaped.push({ kind: "section", level: run[0].level, heading: "More items", text: `${run.length - MAX_CARDS} more items not shown.` });
    i = j;
  }

  const textSoFar = shaped.reduce((k, n) => k + len(n) + (n.text?.length ?? 0), 0);
  if (textSoFar < 1500 && under.length >= 3 && !clusters.length) shaped.push({ kind: "section", level: 2, heading: "Pages in this part of the site", text: "", blocks: under.map((u) => ({ kind: "item" as const, text: sentence(u) })) });

  // Empty sections: a heading straight above its first subsection merges into it ("History: Early ideas"); one with nothing under it goes.
  const has = (n: Sec) => n.kind !== "section" || !!n.blocks?.length || !!n.text;
  const merged: Sec[] = [];
  const copies = new Set<string>(); // a layout copy (mobile drawer and desktop panel) repeats a section word for word
  for (let i = 0; i < shaped.length; i++) {
    const n = shaped[i];
    if (n.kind === "section" && n.blocks?.length && !isCard.has(n)) {
      const key = `${n.heading}|${n.blocks.map((b) => b.text).join("|")}`;
      if (copies.has(key)) continue;
      copies.add(key);
    }
    if (has(n) || isCard.has(n)) {
      merged.push(n);
      continue;
    }
    const nx = shaped[i + 1];
    if (nx?.kind === "figure") merged.push(n); // a heading over a figure is the figure's title
    else if (nx?.kind === "section" && (nx.level ?? 0) > (n.level ?? 0) && !isCard.has(nx)) {
      nx.heading = `${n.heading}: ${nx.heading}`;
      nx.level = n.level;
    }
  }

  const out: TwinNode[] = merged.map((n, i) => {
    const id = `n${String(i + 1).padStart(2, "0")}`;
    if (n.kind !== "section" || !n.blocks) return { ...n, id, order: i + 1 } as TwinNode;
    const blocks: Block[] = n.blocks.map((b, k) => ({ id: `${id}.b${String(k + 1).padStart(2, "0")}`, kind: b.kind, text: b.text, ...(b.say && b.say !== b.text ? { say: b.say } : {}) }));
    return { ...n, id, order: i + 1, text: blocks.map((b) => b.text).join("\n\n"), blocks };
  });
  const count = (k: TwinNode["kind"]) => out.filter((n) => n.kind === k).length;
  const twin: Twin = {
    id: "twin-" + createHash("sha1").update(url).digest("hex").slice(0, 8),
    source: { url, kind: "page", title, via: "direct", ...(credit ? { credit } : {}) },
    nodes: out,
    counts: { sections: count("section"), figures: count("figure"), segments: count("segment") },
  };

  withLang(twin, htmlLang, htmlDir);

  // What code could not finish, per node, for the one background model pass.
  const notes: Trouble[] = [];
  merged.forEach((n, i) => {
    const node = out[i];
    if (!n.blocks || !node.blocks) return;
    const pick = (f: (d: Draft) => boolean) => n.blocks!.flatMap((d, k) => (f(d) ? [node.blocks![k].id] : []));
    const eq = pick((d) => d.hard === "equation");
    const tb = pick((d) => d.hard === "table");
    const ln = pick((d) => (d.ld ?? 0) >= 0.8 && d.kind === "paragraph");
    const images = Object.fromEntries(n.blocks.flatMap((d, k) => (d.hard === "equation" && d.img ? [[node.blocks![k].id, d.img]] : [])));
    if (eq.length) notes.push({ node: node.id, why: "equation", blocks: eq, ...(Object.keys(images).length ? { images } : {}) });
    if (tb.length) notes.push({ node: node.id, why: "table", blocks: tb });
    if (ln.length >= 3) notes.push({ node: node.id, why: "links", blocks: ln });
    else if (node.blocks.length >= 4 && node.blocks.every((b) => b.text.length < 40 && (b.kind === "paragraph" || b.kind === "item")) && words(node.heading).split(" ").length <= 3 && i < 3) notes.push({ node: node.id, why: "furniture", blocks: node.blocks.map((b) => b.id) });
  });
  troubles.set(twin, notes);
  return twin;
}

/** LaTeX for one <math>: MediaWiki's source, LaTeXML's alttext, a TeX annotation, else rebuilt from the MathML. */
function texOfMath($: cheerio.CheerioAPI, el: AnyNode): string {
  const $m = $(el);
  try {
    const mw = JSON.parse($m.attr("data-mw") ?? "null");
    if (typeof mw?.body?.extsrc === "string") return mw.body.extsrc;
  } catch {
    // not MediaWiki
  }
  const alt = $m.attr("alttext");
  if (alt) return alt;
  const ann = $m.find("annotation[encoding*='tex' i],annotation[encoding*='TeX']").first().text();
  if (ann) return ann;
  return mathmlToTex(el);
}

/** \( ... \), \[ ... \] and $$ ... $$ in plain text (LibreTexts and other MathJax pages ship raw TeX). */
function texInText($: cheerio.CheerioAPI, swap: (tex: string, display: boolean) => string) {
  const RE = /\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$/g;
  const walk = (el: AnyNode) => {
    for (const c of [...((el as Element).children ?? [])]) {
      if (c.type === "text") {
        const data = (c as unknown as { data: string }).data;
        if (!RE.test(data)) continue;
        RE.lastIndex = 0;
        const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        let html = "";
        let last = 0;
        for (const m of data.matchAll(RE)) {
          html += esc(data.slice(last, m.index)) + swap(m[1] ?? m[2] ?? m[3], m[1] == null);
          last = (m.index ?? 0) + m[0].length;
        }
        $(c).replaceWith(html + esc(data.slice(last)));
      } else if (c.type === "tag" && !/^(script|style|code|pre|textarea|math)$/i.test((c as Element).tagName)) walk(c);
    }
  };
  const body = $("body")[0];
  if (body) walk(body);
}

/** Shown and spoken text of an element, with each formula in its shown and spoken form. `only`: the element is one display formula. */
function both($: cheerio.CheerioAPI, el: AnyNode | undefined, maths: (Math & { display: boolean })[]): { shown: string; spoken: string; only: AnyNode | null } {
  if (!el) return { shown: "", spoken: "", only: null };
  let shown = "";
  let spoken = "";
  const ms: AnyNode[] = [];
  const BLOCKY = /^(p|div|li|br|tr|dd|dt|h[1-6]|section|blockquote|ul|ol|table)$/i;
  const walk = (n: AnyNode) => {
    if (n.type === "text") {
      const d = (n as unknown as { data: string }).data;
      shown += d;
      spoken += d;
      return;
    }
    if (n.type !== "tag") return;
    const e = n as Element;
    if (e.tagName === "arc-math") {
      const m = maths[Number(e.attribs["data-i"])];
      if (!m) return;
      ms.push(n);
      shown += ` ${m.text} `;
      spoken += ` ${m.say} `;
      return;
    }
    if (e.tagName === "sup" && /^[−-]?\d{1,3}$/.test(((e.children[0] as unknown as { data?: string })?.data ?? "").trim()) && e.children.length === 1) {
      // c<sup>2</sup>, 10<sup>6</sup>: a printed power
      const p = ((e.children[0] as unknown as { data: string }).data ?? "").trim().replace("−", "-");
      const SUP: Record<string, string> = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
      shown += [...p].map((c) => SUP[c] ?? c).join("");
      spoken += p === "2" ? " squared" : p === "3" ? " cubed" : ` to the power of ${p.replace("-", "minus ")}`;
      return;
    }
    if (e.tagName === "img") {
      const alt = e.attribs.alt ?? "";
      if (alt && /emoji|inline/i.test(e.attribs.class ?? "")) [shown, spoken] = [shown + alt, spoken + alt];
      return;
    }
    const sep = BLOCKY.test(e.tagName) ? " " : "";
    shown += sep;
    spoken += sep;
    e.children.forEach(walk);
    shown += sep;
    spoken += sep;
  };
  walk(el);
  const rest = shown.replace(/[\s.,;:]+/g, "");
  const onlyMath = ms.length === 1 && maths[Number($(ms[0]).attr("data-i"))]?.display;
  const textWithout = (() => {
    let s = "";
    const w = (n: AnyNode) => {
      if (n.type === "text") s += (n as unknown as { data: string }).data;
      else if (n.type === "tag" && (n as Element).tagName !== "arc-math") (n as Element).children.forEach(w);
    };
    w(el);
    return s.replace(/[\s.,;:⁠]+/g, "");
  })();
  return { shown, spoken, only: onlyMath && !textWithout && rest ? ms[0] : null };
}

/** A data table: shown compactly, spoken as "Table with R rows and C columns" then "Header: value" rows, capped. Layout tables give null. */
function table($: cheerio.CheerioAPI, el: AnyNode, maths: (Math & { display: boolean })[]): Draft | null {
  const $t = $(el);
  const rows = $t.find("tr").toArray().filter((r) => $(r).closest("table")[0] === el);
  if (rows.length < 2) return null;
  const cell = (c: AnyNode) => {
    const b = both($, c, maths);
    return { shown: tidy(b.shown), spoken: tidy(b.spoken) };
  };
  const grid = rows.map((r) => $(r).children("th,td").toArray().map(cell));
  const cols = Math.max(...grid.map((r) => r.length));
  if (cols < 2 && !$(rows[0]).find("th").length) return null;
  const headed = $(rows[0]).children("th").length > 0 || $t.find("thead").length > 0;
  if (!headed && grid.some((r) => r.some((c) => c.shown.length > 300))) return null; // a layout table holding prose
  const head = headed ? grid[0] : [];
  if (headed && head.every((h) => !h.shown)) return null;
  const body = headed ? grid.slice(1) : grid;
  const caption = (tidy(both($, $t.find("caption").first()[0], maths).shown) || tidy(both($, $t.closest("figure").find("figcaption").first()[0], maths).shown)).replace(/[.:;]+$/, "");
  const spans = $t.find("[rowspan],[colspan]").toArray().some((c) => Number($(c).attr("rowspan") || 1) > 1 || Number($(c).attr("colspan") || 1) > 1);
  const CAP = 12;
  const line = (r: { shown: string; spoken: string }[], k: "shown" | "spoken") =>
    r.map((c, i) => (head[i]?.[k] && k === "spoken" ? `${head[i][k]}: ${c[k] || "blank"}` : c[k] || (k === "spoken" ? "blank" : ""))).join(k === "shown" ? " | " : ", ");
  const text = [caption, head.length ? line(head, "shown") : "", ...body.map((r) => line(r, "shown"))].filter(Boolean).join("\n");
  const n = body.length;
  const say = [
    `Table with ${n} row${n === 1 ? "" : "s"} and ${cols} column${cols === 1 ? "" : "s"}${caption ? `: ${caption}` : ""}.`,
    ...body.slice(0, CAP).map((r) => sentence(line(r, "spoken"))),
    n > CAP ? `And ${n - CAP} more rows.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return { kind: "table", text: text.slice(0, MAX_TEXT), say, ...(spans || cols > 8 || n > 40 ? { hard: "table" as const } : {}) };
}

/** Semantic Scholar paper pages are a script-built app: a citation string, author cards, then listings of references, citations and
 * related papers. What a student reads is the title, authors, venue and year, and the abstract (in the page's JSON-LD, not in
 * its markup). Rebuilt here as those four parts; without the JSON-LD the page is left to the generic rules. */
function scholarPaper($: cheerio.CheerioAPI) {
  if (!$("meta[name='s2-ui-version']").length) return;
  type Paper = { abstract: string; author?: { name?: string }[]; publisher?: { name?: string }; datePublished?: string };
  const find = (v: unknown): Paper | null => {
    if (Array.isArray(v)) return v.map(find).find(Boolean) ?? null;
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    return typeof o.abstract === "string" ? (o as Paper) : (Object.values(o).map(find).find(Boolean) ?? null);
  };
  let paper: Paper | null = null;
  $("script[type='application/ld+json']").each((_, el) => {
    try {
      paper ??= find(JSON.parse($(el).text()));
    } catch {
      // not JSON
    }
  });
  const p = paper as Paper | null;
  const abstract = squash(p?.abstract);
  const title = squash($("h1[data-test-id='paper-detail-title']").first().text());
  if (!p || !abstract || !title) return;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const names = (p.author ?? []).map((a) => squash(a.name)).filter(Boolean);
  const venue = [squash(p.publisher?.name), squash(p.datePublished)].filter(Boolean).join(", ") || squash($("[data-test-id='year-and-venue']").first().text()).replace(/^Published\s+(in\s+)?/i, "");
  $("body").html(
    `<main><h1>${esc(title)}</h1>` +
      (names.length ? `<h2>Authors</h2><p>${esc(names.length > 1 ? `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}` : names[0])}.</p>` : "") +
      (venue ? `<h2>Published</h2><p>${esc(venue)}.</p>` : "") +
      `<h2>Abstract</h2><p>${esc(abstract)}</p></main>`,
  );
}

/** arXiv /abs/ pages: replaces the body with title, authors, abstract and a pointer to the HTML and PDF full text. */
function arxivAbstract($: cheerio.CheerioAPI, url: string) {
  if (!/arxiv\.org\/abs\//i.test(url) || !$("blockquote.abstract").length) return;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const id = /arxiv\.org\/abs\/([^?#]+)/i.exec(url)?.[1] ?? "";
  const title = squash($("h1.title").first().text().replace(/^Title:/, ""));
  const authors = squash($(".authors").first().text().replace(/^Authors:/, ""));
  const $abs = $("blockquote.abstract").first().clone();
  $abs.find(".descriptor").remove();
  const comments = squash($(".tablecell.comments").first().text());
  const html = $("a[href*='/html/']").filter((_, a) => /html/i.test($(a).text())).first().attr("href");
  const where = [html ? `as HTML at ${new URL(html, url).href}` : "", `as a PDF at https://arxiv.org/pdf/${id}`].filter(Boolean).join(", and ");
  $("body").html(
    `<main><h1>${esc(title)}</h1><h2>Authors</h2><p>${esc(authors)}.</p><h2>Abstract</h2><p>${$abs.html() ?? ""}</p>` +
      (comments ? `<p>Comments: ${esc(comments)}</p>` : "") +
      `<h2>Full text</h2><p>This is the abstract page. The full paper is available ${esc(where)}.</p></main>`,
  );
}

// What a publisher shows in place of the article when the reader has no access. Strong phrases only: an open article never prints them.
const PAYWALL = /access through your institution|log ?in (via|through) (an |your )?institution|purchase (this article|pdf|article)|buy (this )?article( pdf)?|rent (or buy )?this article|get full access to this article|get access to the full (version|text)|you do not (currently )?have (full )?access|instant access to the full article|subscribe to (this )?journal|buy or subscribe|access options|check access/i;
/** A publisher page that loaded but holds only the abstract behind a paywall: short body plus a paywall phrase. `chars` is the
 * parsed twin's text length (a full article is well over 10,000). Called by lib/server/fetch.ts; checked by scripts/checks/scholar.ts. */
export const paywalled = (html: string, chars: number) => chars < 10_000 && PAYWALL.test(html);
