// A page the student sent from their own signed-in browser (the Arc helper extension, or the no-install bookmarklet): received,
// never fetched. Validated hard, sanitised, parsed by the same parser as every other page (lib/parse/html.ts), and kept in memory
// only (lib/server/vault.ts): random id, about two hours after last use, never written under .cache/, never logged.
// Pictures arrive as data beside the HTML (the parser treats data: sources as placeholders), are held in memory, and get a
// same-origin address that lives as long as the document. Called by app/api/ingest/route.ts. Checked by scripts/checks/ingest.ts.
import { randomBytes } from "node:crypto";
import * as cheerio from "cheerio";
import { parseHtml } from "@/lib/parse/html";
import { warmBlocks } from "@/lib/server/pageQueue";
import { pdfTwin, PdfError, randomPdfId } from "@/lib/server/pdf";
import { warmPage } from "@/lib/server/tourQueue";
import * as vault from "@/lib/server/vault";
import type { Twin } from "@/lib/types";

/** What one request may carry. A sent page is HTML plus up to 40 pictures of at most 2 MB each and 10 MB together, or one PDF
 * of at most 25 MB. The whole body: 40 MB (a 25 MB PDF is about 34 MB as base64). */
export const LIMITS = { body: 40 * 1024 * 1024, html: 4 * 1024 * 1024, images: 40, image: 2 * 1024 * 1024, imagesTotal: 10 * 1024 * 1024, pdf: 25 * 1024 * 1024, links: 60, frames: 12, frameHtml: 1024 * 1024, videos: 6, cues: 4000, lines: 12 };

export class IngestError extends Error {
  constructor(message: string, public status = 400, public code = "invalid") {
    super(message);
  }
}
const BAD = () => new IngestError("Send JSON: {url, title, html}.");

type Link = NonNullable<Twin["links"]>[number];
export type Payload = {
  url: string;
  title?: string;
  lang?: string;
  html?: string;
  images?: string[];
  links?: Link[];
  frames?: { n: number; html: string }[];
  videos?: { n: number; title: string; cues: { t: number; text: string }[] }[];
  youtube?: { id: string; title: string }[];
  lines?: string[];
  pdf?: { name?: string; data: string };
};

/** http(s) only, no user name or password in it; null otherwise (javascript:, data:, file: and the rest). */
export const webUrl = (s: unknown): string | null => {
  if (typeof s !== "string" || s.length > 4000) return null;
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
};
const str = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");
const arr = (a: unknown, max: number): unknown[] => (Array.isArray(a) ? a.slice(0, max) : []);

/** The payload, checked field by field; unknown fields are dropped. Throws IngestError. */
export function validate(raw: unknown): Payload {
  if (!raw || typeof raw !== "object") throw BAD();
  const b = raw as Record<string, unknown>;
  const url = webUrl(b.url);
  if (!url) throw BAD();
  const p: Payload = { url, title: str(b.title, 300) || undefined, lang: /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(String(b.lang ?? "")) ? String(b.lang) : undefined };
  if (b.pdf && typeof b.pdf === "object") {
    const d = (b.pdf as { data?: unknown }).data;
    if (typeof d !== "string" || d.length > Math.ceil((LIMITS.pdf * 4) / 3) + 4 || !/^[A-Za-z0-9+/]+=*$/.test(d)) throw new IngestError("That PDF is larger than 25 megabytes, or it is not a PDF.", 413, "big");
    p.pdf = { name: str((b.pdf as { name?: unknown }).name, 200) || undefined, data: d };
  } else {
    if (typeof b.html !== "string" || !b.html.trim()) throw BAD();
    if (Buffer.byteLength(b.html) > LIMITS.html) throw new IngestError("That page is larger than 4 megabytes.", 413, "big");
    p.html = b.html;
  }
  const images = arr(b.images, LIMITS.images + 1);
  if (images.length > LIMITS.images) throw new IngestError(`Send at most ${LIMITS.images} pictures.`, 413, "big");
  p.images = images.map((x) => (typeof x === "string" ? x : ""));
  p.links = cleanLinks(b.links, url);
  p.frames = arr(b.frames, LIMITS.frames).flatMap((f) => {
    const x = f as { n?: unknown; html?: unknown };
    return Number.isInteger(x?.n) && typeof x.html === "string" && x.html.length <= LIMITS.frameHtml ? [{ n: x.n as number, html: x.html }] : [];
  });
  p.videos = arr(b.videos, LIMITS.videos).flatMap((v) => {
    const x = v as { n?: unknown; title?: unknown; cues?: unknown };
    if (!Number.isInteger(x?.n)) return [];
    const cues = arr(x.cues, LIMITS.cues).flatMap((c) => {
      const y = c as { t?: unknown; text?: unknown };
      return typeof y?.t === "number" && Number.isFinite(y.t) && y.t >= 0 && str(y.text, 500) ? [{ t: y.t, text: str(y.text, 500) }] : [];
    });
    return [{ n: x.n as number, title: str(x.title, 120), cues }];
  });
  p.youtube = arr(b.youtube, 10).flatMap((y) => {
    const x = y as { id?: unknown; title?: unknown };
    return typeof x?.id === "string" && /^[\w-]{11}$/.test(x.id) ? [{ id: x.id, title: str(x.title, 120) }] : [];
  });
  p.lines = arr(b.lines, LIMITS.lines).map((l) => str(l, 300)).filter(Boolean);
  return p;
}

/** Navigation links: web addresses only, short labels, no duplicates, not the page itself; at most LIMITS.links. */
export function cleanLinks(raw: unknown, here: string): Link[] {
  const out: Link[] = [];
  const seen = new Set([here.split("#")[0]]);
  for (const l of arr(raw, 200)) {
    const x = l as { label?: unknown; url?: unknown; rel?: unknown };
    const url = webUrl(x?.url);
    const label = str(x?.label, 80);
    if (!url || !label || seen.has(url.split("#")[0])) continue;
    seen.add(url.split("#")[0]);
    const rel = x.rel === "next" || x.rel === "prev" || x.rel === "up" ? x.rel : undefined;
    out.push(rel ? { label, url, rel } : { label, url });
    if (out.length >= LIMITS.links) break;
  }
  return out;
}

// ---- assessments ----
const ASSESS_URL = [
  /\/quizzes\/\d+\/take\b/i, // Canvas classic quizzes, being taken
  /\/mod\/quiz\/(?:attempt|summary|startattempt)\.php/i, // Moodle
  /\/webapps\/assessment\/take\//i, // Blackboard Learn original
  /\/ultra\/.*\/(?:assessment|test).*\/attempt/i, // Blackboard Ultra
  /\/d2l\/lms\/quizzing\/user\/attempt/i, // D2L Brightspace
  /\/(?:exam|test|assessment)s?\/[^?#]*\/(?:take|attempt)\b/i,
];
const ASSESS_HOST = /(^|\.)quiz-lti[\w-]*\.instructure\.com$/i; // Canvas New Quizzes
const QUESTION_BOX = ".question,.que,.takeQuestionDiv,[id^='question_'],[class*='question-container'],[data-testid*='question' i],d2l-quiz-question,fieldset";
const ANSWER = "input[type=radio],input[type=checkbox],input[type=text],input:not([type]),input[type=number],textarea,select";
/** A quiz or exam being taken: by its address, or by its content (two or more questions that each hold an answer input). */
export function isAssessment(url: string, $: cheerio.CheerioAPI): boolean {
  try {
    const u = new URL(url);
    if (ASSESS_URL.some((re) => re.test(u.pathname + u.search)) || ASSESS_HOST.test(u.hostname)) return true;
  } catch {
    return false;
  }
  const boxes = $(QUESTION_BOX).filter((_, el) => $(el).find(ANSWER).length > 0).length;
  const numbered = $("h1,h2,h3,h4,h5,legend,.question_name,.qno,.question-number,[class*='question-title']").filter((_, el) => /^\s*(?:question|q\.?)\s*\d+\b/i.test($(el).text())).length;
  const inputs = $(ANSWER).length;
  return inputs >= 2 && (boxes >= 2 || numbered >= 2);
}

// ---- pictures ----
const IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+=*)$/;
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  "image/png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8,
  "image/gif": (b) => b.subarray(0, 4).toString("latin1") === "GIF8",
  "image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};
/** One picture from the payload: a raster data URL whose bytes match its type (never SVG: it can carry script). */
export function pictureOf(data: string): { type: string; bytes: Buffer } | null {
  const m = IMAGE.exec(data);
  if (!m) return null;
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length > LIMITS.image || !MAGIC[m[1]](bytes)) return null;
  return { type: m[1], bytes };
}

const URL_ATTR = new Set(["href", "src", "poster", "xlink:href", "data-src", "cite", "background", "longdesc", "usemap", "data", "codebase"]);
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The HTML made safe and ready for the parser: frames and transcripts in, honest lines in, script and handlers out, addresses
 * web-only, forms readable, pictures swapped for `picture(k)` (null drops the picture). Also says whether it is an assessment
 * or a sign-in page. */
export function prepare(p: Payload, picture: (k: number) => string | null): { html: string; assessment: boolean; signIn: boolean } {
  const $ = cheerio.load(p.html ?? "");
  for (const f of p.frames ?? []) $(`[data-arc-frame="${f.n}"]`).first().html(f.html);
  for (const v of p.videos ?? []) {
    const parts: string[] = [];
    let at = -1;
    for (const c of v.cues) {
      if (at < 0 || c.t - at >= 45) parts.push(`[${clock(c.t)}] ${c.text}`), (at = c.t);
      else parts[parts.length - 1] += ` ${c.text}`;
    }
    $(`[data-arc-video="${v.n}"]`).first().replaceWith(`<h2>Transcript${v.title ? `: ${esc(v.title)}` : " of the video"}</h2>${parts.map((t) => `<p>${esc(t)}</p>`).join("")}`); // no wrapper: the parser would take it for the whole page
  }
  const assessment = isAssessment(p.url, $);
  const words = $("body").text().replace(/\s+/g, " ").trim().length;
  const signIn = $("input[type=password]").length > 0 && words < 1500;

  $("script,style,noscript,template,iframe,frame,frameset,object,embed,applet,base,meta[http-equiv],link:not([rel~='license']):not([rel~='next']):not([rel~='prev']),portal").remove();
  // Inside SVG, cheerio keeps camelCase names that its selectors miss (foreignObject): matched by name instead.
  $("svg *").filter((_, el) => /^(script|foreignobject|use|animate|animatemotion|animatetransform|set|iframe|handler|listener)$/i.test((el as { name?: string }).name ?? "")).remove();
  $("*").each((_, el) => {
    const e = el as unknown as { attribs?: Record<string, string> };
    for (const [k, v] of Object.entries(e.attribs ?? {})) {
      const key = k.toLowerCase();
      if (key.startsWith("on") || key === "style" || key === "srcdoc" || key === "formaction" || key === "action" || key === "srcset" || key === "data-srcset") delete e.attribs![k];
      else if (URL_ATTR.has(key) && !(key === "src" && /^arc-image:\d+$/.test(v)) && !webUrl(v.trim())) delete e.attribs![k];
    }
  });
  // Each question of a quiz becomes its own section under its own heading ("Question 2"), so next and previous move question by
  // question; the box itself is unwrapped (the parser would otherwise take one question's box as the whole page).
  $(QUESTION_BOX)
    .filter((_, el) => $(el).find(ANSWER).length > 0)
    .each((_, el) => {
      const $q = $(el);
      const name = $q.find(".question_name,.qno,.question-number,legend,[class*='question-title'],h2,h3,h4").first();
      if (name.length) name.replaceWith(`<h2>${name.text().trim()}</h2>`);
      $q.replaceWith($q.contents());
    });
  // Forms read as text: the parser drops forms and inputs, and a quiz's choices must still be heard.
  $("input[type=radio]").replaceWith("Choice: ");
  $("input[type=checkbox]").replaceWith("Tick box: ");
  $("textarea").replaceWith("<p>[answer box]</p>");
  $("input[type=text],input:not([type]),input[type=number]").replaceWith(" [answer box] ");
  $("select").each((_, el) => void $(el).replaceWith(` [choose one: ${$(el).find("option").toArray().map((o) => $(o).text().trim()).filter(Boolean).slice(0, 12).join(" / ")}] `));
  $("input,button[type=submit]").remove();
  // Inside a form or a question, a leaf box of text (a label, a question name, a choice) becomes a paragraph: the parser reads
  // paragraphs, list items and headings, not bare divs.
  $(`form,${QUESTION_BOX}`).find("div,span,label,legend,td").each((_, el) => {
    const $e = $(el);
    if ($e.find("p,div,ul,ol,table,h1,h2,h3,h4,h5,h6,li,section,label").length || !$e.text().trim() || $e.parents("p,li,h1,h2,h3,h4,h5,h6").length) return;
    $e.replaceWith(`<p>${$e.html()}</p>`);
  });
  $("form").each((_, el) => void $(el).replaceWith(`<div>${$(el).html() ?? ""}</div>`));
  $("img").each((_, el) => {
    const $i = $(el);
    const k = /^arc-image:(\d+)$/.exec($i.attr("src") ?? "")?.[1];
    for (const a of ["data-src", "data-lazy-src", "data-original", "data-full-src", "data-hi-res-src"]) $i.removeAttr(a);
    if (k == null) return; // an ordinary web address: the student's browser may show it; the server never fetches it for a private page
    const url = picture(Number(k));
    if (!url) return void $i.remove();
    $i.attr("src", url);
    const a = $i.closest("a[href]");
    if (a.length && /\.(png|jpe?g|gif|webp|svg)(?:$|[?#])|\/preview\b|\/download\b/i.test(a.attr("href") ?? "")) a.replaceWith(a.contents()); // the parser would take the link (unreadable here) over the picture
    // The student sent this picture: never decorative to the parser (an empty alt, or no figure around it, would drop it).
    if (!($i.attr("alt") ?? "").trim()) $i.attr("alt", NO_DESCRIPTION);
    $i.removeAttr("role");
    if (!$i.closest("figure").length) $i.wrap("<figure></figure>");
  });
  if (p.lines?.length) {
    const lines = p.lines.map((l) => `<p>${esc(l)}</p>`).join("");
    const h1 = $("h1").first();
    if (h1.length) h1.after(lines);
    else $("body").prepend(lines);
  }
  return { html: $.html(), assessment, signIn };
}

export const NO_DESCRIPTION = "Picture, no description";
export const NOTHING = "That page had nothing Arc could read.";

/** A page the student sent always becomes a twin when it has any words or pictures: the parser's "too thin to be content"
 * judgement is for pages Arc fetched itself. Pictures it dropped are added as figures; an empty result gets one section. */
export function ensureNodes(twin: Twin, html: string, pictures: { url: string; alt: string }[]): Twin {
  const $ = cheerio.load(html);
  const seen = new Set(twin.nodes.flatMap((n) => (n.image ? [n.image.url] : [])));
  const nodes = [...twin.nodes];
  if (!nodes.length) {
    $("script,style,noscript,template,nav,header,footer,aside,figure,figcaption,h1").remove();
    const text = $("body")
      .find("p,li,h2,h3,h4,h5,h6,td,dd,blockquote,pre")
      .toArray()
      .map((el) => $(el).clone().children("p,li,ul,ol,table").remove().end().text().replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n\n") || $("body").text().replace(/\s+/g, " ").trim();
    if (text) nodes.push({ id: "", kind: "section", order: 0, level: 2, heading: twin.source.title || "This page", text });
  }
  let fig = nodes.filter((n) => n.kind === "figure").length;
  for (const p of pictures) {
    if (seen.has(p.url)) continue;
    seen.add(p.url);
    fig++;
    nodes.push({ id: "", kind: "figure", order: 0, level: null, heading: `Figure ${fig}`, text: p.alt || NO_DESCRIPTION, image: { url: p.url, alt: p.alt && p.alt !== NO_DESCRIPTION ? p.alt : null } });
  }
  if (nodes.length === twin.nodes.length) return twin;
  const out = nodes.map((n, i) => ({ ...n, id: n.id && i < twin.nodes.length ? n.id : `n${String(i + 1).padStart(2, "0")}`, order: i + 1 }));
  // ids stay unique even when the parser's own ids were not in order
  const ids = new Set<string>();
  for (const [i, n] of out.entries()) {
    if (ids.has(n.id)) n.id = `n${String(i + 1).padStart(2, "0")}x`;
    ids.add(n.id);
  }
  const count = (k: Twin["nodes"][number]["kind"]) => out.filter((n) => n.kind === k).length;
  return { ...twin, nodes: out, counts: { sections: count("section"), figures: count("figure"), segments: count("segment") } };
}

const SIGN_IN = "That page asked you to sign in. Sign in to it in your browser, then try again.";
const newId = () => randomBytes(16).toString("hex");

/** Payload -> private twin in memory. Returns the id the Arc page opens with /?doc=<id>. */
export async function ingest(p: Payload, origin: string): Promise<{ id: string; twin: Twin }> {
  const id = newId();
  const cleanup: (() => void)[] = [];
  if (p.pdf) {
    const bytes = Buffer.from(p.pdf.data, "base64");
    if (bytes.length > LIMITS.pdf) throw new IngestError("That PDF is larger than 25 megabytes.", 413, "big");
    const pdfId = randomPdfId(); // random: whoever holds the same file cannot reach this student's copy (a content hash could)
    vault.claim(id, `.cache/pdf/${pdfId}`); // before pdfTwin writes anything: the file, pages and figures stay in memory
    let twin: Twin;
    try {
      const { timing: _t, figures: _f, ...t } = await pdfTwin(bytes, p.url, { name: p.pdf.name ?? p.title, via: "browser", origin, id: pdfId });
      twin = t;
    } catch (e) {
      vault.drop(id);
      throw e instanceof PdfError ? new IngestError(e.message, 422, "pdf") : e;
    }
    twin.source = { ...twin.source, private: true };
    if (p.links?.length) twin.links = p.links;
    cleanup.push(() => forget((k) => k.includes(`id=${pdfId}`)), () => forgetPdf(pdfId));
    vault.put(id, twin, cleanup);
    return { id, twin };
  }
  const keys: string[] = [];
  const pictures: { url: string; alt: string }[] = [];
  let total = 0;
  const imgKey = newId().slice(0, 16); // pictures get their own capability: one picture's address does not open the document
  const { html, assessment, signIn } = prepare(p, (k) => {
    const pic = pictureOf(p.images?.[k] ?? "");
    if (!pic || total + pic.bytes.length > LIMITS.imagesTotal) return null;
    total += pic.bytes.length;
    const key = `${imgKey}${k}`;
    vault.putImage(id, key, pic.type, pic.bytes);
    keys.push(key);
    return `${origin}/api/ingest?img=${key}`;
  });
  const parsed = parseHtml(html, p.url, p.lang);
  if (p.title && (parsed.source.title === p.url || !parsed.source.title)) parsed.source.title = p.title;
  for (const el of cheerio.load(html)("img[src*='/api/ingest?img=']").toArray()) pictures.push({ url: el.attribs.src, alt: (el.attribs.alt ?? "").trim() });
  const twin = ensureNodes(parsed, html, pictures);
  if (!twin.nodes.length) {
    vault.drop(id);
    throw new IngestError(NOTHING, 422, "empty");
  }
  const chars = twin.nodes.reduce((n, x) => n + x.text.length, 0);
  if (signIn && chars < 600) {
    vault.drop(id);
    throw new IngestError(SIGN_IN, 401, "signin");
  }
  twin.id = `doc-${id}`;
  twin.source = { ...twin.source, via: "browser", private: true, ...(assessment ? { assessment: true } : {}) };
  const links = [...(p.links ?? []), ...(p.youtube ?? []).map((y) => ({ label: `Video: ${y.title || "YouTube video"}`, url: `https://www.youtube.com/watch?v=${y.id}` }))];
  if (links.length) twin.links = links.slice(0, LIMITS.links + 10);
  vault.claim(id, `.cache/blocks/${twin.id}-`); // the background clean-up result (lib/server/pageQueue.ts)
  const images = twin.nodes.flatMap((n) => (n.kind === "figure" && n.image && /\/api\/ingest\?img=/.test(n.image.url) ? [n.image.url] : []));
  cleanup.push(() => forget((k) => keys.some((key) => k.endsWith(`img=${key}`))), () => (globalThis as unknown as { __arcBlocks?: { pages: Map<string, unknown> } }).__arcBlocks?.pages.delete(twin.id));
  vault.put(id, twin, cleanup);
  warmPage(images); // tours of the captured pictures, in memory (lib/server/vault.ts holds their files)
  warmBlocks(twin);
  return { id, twin };
}

// shortcut: reaches into the tour and PDF queues' globalThis state to forget an expired document; a forget() export on each
// queue would be cleaner if more callers need it.
function forget(match: (key: string) => boolean) {
  const q = (globalThis as unknown as { __arcTours?: { jobs: Map<string, unknown>; light: string[]; heavy: string[] } }).__arcTours;
  if (!q) return;
  for (const k of [...q.jobs.keys()]) if (match(k)) q.jobs.delete(k);
  q.light = q.light.filter((k) => !match(k));
  q.heavy = q.heavy.filter((k) => !match(k));
}
function forgetPdf(pdfId: string) {
  const s = (globalThis as unknown as { __arcPdf?: { docs: Map<string, unknown>; quick: Map<string, unknown> } }).__arcPdf;
  s?.docs.delete(pdfId);
  for (const k of [...(s?.quick.keys() ?? [])]) if (k.startsWith(`${pdfId}:`)) s!.quick.delete(k);
}
