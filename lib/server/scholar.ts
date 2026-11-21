// Get the paper, not the page. A scholarly link names a work; the same work is often legally open elsewhere (arXiv, PubMed
// Central, the publisher's own open-access copy) and its details and abstract are in open indexes. Called by app/api/load.
// 1. identify(): the work from the pasted URL, offline (DOI, ScienceDirect PII, ResearchGate title, PubMed, PMC, arXiv,
//    Semantic Scholar, IEEE). 2. resolve(): OpenAlex (Crossref for a PII, Semantic Scholar and NCBI E-utilities to fill gaps)
//    gives title, authors, venue, year, abstract and the open copies. 3. scholarLoad(): the page itself when it loads with the
//    full text; else the best open copy through Arc's normal pipeline; else a twin of the open metadata with one plain line.
// Legal open copies only, as the indexes list them; never a shadow library, never past a paywall or a sign-in. Every call goes
// through lib/server/safeFetch.ts; nothing personal is sent (no mailto). Checked offline by scripts/checks/scholar.ts.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as cheerio from "cheerio";
import type { Twin, TwinNode } from "@/lib/types";
import { rebuildAbstract } from "@/lib/server/openalex";
import { safeFetch } from "@/lib/server/safeFetch";

export type Ident = { kind: "doi" | "pii" | "title" | "pmid" | "pmcid" | "arxiv" | "s2" | "ieee"; value: string };
export type Copy = { url: string; kind: "html" | "pdf"; repo: string; version: "published" | "accepted" | "preprint" | null };
export type Work = { checked?: boolean; title: string; authors: string[]; venue: string; year: number | null; doi: string | null; abstract: string; copies: Copy[]; pmid: string | null; from: string[] };

const cleanDoi = (d: string) =>
  decodeURIComponent(d)
    .replace(/[?#].*$/, "")
    .replace(/(\/(full|abstract|abs|pdf|epdf|epub|fulltext|html|summary|meta|references|figures|citedby))+\/?$/i, "")
    .replace(/\.pdf$/i, "")
    .replace(/[/.,;]+$/, "");

/** The work a URL names, from the address alone. Null when it names none. */
export function identify(raw: string): Ident | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const h = u.hostname.replace(/^(www|m)\./, "");
  const p = u.pathname;
  let m: RegExpExecArray | null;
  // Elsevier's article id (PII), with or without its punctuation: Cell Press, The Lancet, Elsevier's link hub (S0092-8674(14)00604-7).
  if (/(^|\.)(cell\.com|thelancet\.com|linkinghub\.elsevier\.com)$/.test(h) && (m = /\/(?:fulltext|abstract|pdf|pdfExtended|retrieve\/pii|article)\/(?:PII)?([SB][\dX()-]{10,}?)(?:\.pdf)?(?:\/|$)/i.exec(p))) return { kind: "pii", value: m[1].replace(/[()-]/g, "").toUpperCase() };
  if (/(^|\.)sciencedirect\.com$/.test(h) && (m = /\/science\/article\/(?:abs\/)?pii\/([SB][\dX()-]{10,})/i.exec(p))) return { kind: "pii", value: m[1].replace(/[()-]/g, "").toUpperCase() };
  if (/(^|\.)researchgate\.net$/.test(h) && (m = /^\/publication\/\d+_([^/]+)/.exec(p))) return { kind: "title", value: decodeURIComponent(m[1]).replace(/_/g, " ").trim() };
  if (/(^|\.)semanticscholar\.org$/.test(h) && (m = /^\/paper\/(?:[^/]+\/)?([0-9a-f]{40})\b/i.exec(p))) return { kind: "s2", value: m[1].toLowerCase() };
  if (/^pubmed\.ncbi\.nlm\.nih\.gov$/.test(h) && (m = /^\/(\d{1,9})\/?$/.exec(p))) return { kind: "pmid", value: m[1] };
  if (/^ncbi\.nlm\.nih\.gov$/.test(h) && (m = /^\/pubmed\/(\d{1,9})/.exec(p))) return { kind: "pmid", value: m[1] };
  if (/(^|\.)ncbi\.nlm\.nih\.gov$|(^|\.)europepmc\.org$/.test(h) && (m = /\b(PMC\d{3,9})\b/i.exec(p))) return { kind: "pmcid", value: m[1].toUpperCase() };
  if (/(^|\.)europepmc\.org$/.test(h) && (m = /\/(?:article|abstract)\/MED\/(\d{1,9})/i.exec(p))) return { kind: "pmid", value: m[1] };
  if (/(^|\.)arxiv\.org$/.test(h) && (m = /^\/(?:abs|html|pdf)\/((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(?:v\d+)?/i.exec(p))) return { kind: "arxiv", value: m[1] };
  if (/^ieeexplore\.ieee\.org$/.test(h) && (m = /\/document\/(\d+)/.exec(p))) return { kind: "ieee", value: m[1] };
  if (/(^|\.)nature\.com$/.test(h) && (m = /^\/articles\/([a-z0-9][\w.-]+)\/?$/i.exec(p))) return { kind: "doi", value: `10.1038/${m[1]}` };
  if (/(^|\.)jstor\.org$/.test(h) && (m = /^\/stable\/(?:pdf\/)?(\d+)(?:\.pdf)?\/?$/.exec(p))) return { kind: "doi", value: `10.2307/${m[1]}` };
  // A DOI anywhere in the path or query: doi.org, /doi/(abs|full|pdf)/10.x (Wiley, Taylor & Francis, ACM, Sage), Springer, PLOS ?id=.
  m = /\b(10\.\d{4,9}\/[^\s?#&]+)/.exec(decodeURIComponent(p + (u.search ? `?${u.search.slice(1)}` : "")));
  if (m) {
    const doi = cleanDoi(m[1]);
    const ax = /^10\.48550\/arxiv\.(.+)$/i.exec(doi); // arXiv's own DOI: the paper, opened as arXiv full text
    return ax ? { kind: "arxiv", value: ax[1] } : { kind: "doi", value: doi };
  }
  return null;
}

/** A DOI the page itself states: citation_doi / dc.identifier / prism.doi meta, JSON-LD, or an embedded "doi" field (IEEE Xplore). */
export function doiIn(html: string): string | null {
  const meta = /<meta[^>]+(?:name|property)=["'](?:citation_doi|dc\.identifier|dc\.Identifier|prism\.doi|bepress_citation_doi)["'][^>]*>/i.exec(html)?.[0];
  const content = meta && /content=["'](?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/[^"'\s]+)["']/i.exec(meta)?.[1];
  const ld = /"(?:doi|DOI)"\s*:\s*"(?:https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/[^"\s]+)"/.exec(html)?.[1];
  const d = content || ld;
  return d ? cleanDoi(d) : null;
}

// ---- Title matching (ResearchGate links carry only the title) ----
const words = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
/** Dice similarity of two titles' word multisets, 0 to 1. */
export function titleSimilarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.length || !y.length) return 0;
  const left = new Map<string, number>();
  for (const w of x) left.set(w, (left.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of y) if ((left.get(w) ?? 0) > 0) (left.set(w, left.get(w)! - 1), common++);
  return (2 * common) / (x.length + y.length);
}
// Chosen from the checks in scripts/checks/scholar.ts and live tries: a true ResearchGate match scores 1.0 (the slug drops only
// punctuation); a truncated slug or a near title scores 0.75 to 0.9; 0.95 leaves room for a dropped "the" or "a" in a long title.
export const MATCH = 0.95;
const MIN_WORDS = 4; // "Deep learning" or "Introduction" names hundreds of works: never guessed

type Candidate = { title: string; doi: string | null; year: number | null; firstAuthor: string };
/** The one candidate the title names, or why there is none. Two strong candidates that are not the same paper (same first author,
 * years within one: a preprint and its journal version) is "ambiguous": the resolver must not guess. */
export function pickByTitle(title: string, found: Candidate[]): { pick: Candidate } | { none: "short" | "nomatch" | "ambiguous" } {
  if (words(title).length < MIN_WORDS) return { none: "short" };
  const strong = found.filter((c) => titleSimilarity(title, c.title) >= MATCH);
  if (!strong.length) return { none: "nomatch" };
  const [a, ...rest] = strong;
  const same = (b: Candidate) => b.firstAuthor && a.firstAuthor && words(b.firstAuthor).at(-1) === words(a.firstAuthor).at(-1) && Math.abs((a.year ?? 0) - (b.year ?? 0)) <= 1;
  if (rest.some((b) => !same(b))) return { none: "ambiguous" };
  // A preprint and its published version: the one with a publisher DOI (not arXiv's 10.48550) is the work.
  return { pick: strong.find((c) => c.doi && !/10\.48550\//i.test(c.doi)) ?? a };
}

/** An author name as an index gives it, made safe to speak: placeholders ("not provided", "anonymous", "n/a", "unknown") and
 * logins or email addresses dropped; null when no real name is left (then no author is said, rather than a wrong one). */
export function cleanName(raw?: string | null): string | null {
  const s = (raw ?? "").replace(/\b(not provided|anonymous|unknown|n\/a|none)\b/gi, " ");
  const kept = s.split(/\s+/).filter((t) => t && !/@|[._]\w|\d|^[\W_]+$/.test(t)); // a handle: gurvir.virdi, j_smith, user123
  let name = kept.join(" ").replace(/^[,;.\s]+|[,;\s]+$/g, "");
  const flipped = /^([^,]+),\s*([^,]+)$/.exec(name); // "Achiam, Josh" -> "Josh Achiam"
  if (flipped) name = `${flipped[2]} ${flipped[1]}`;
  if (/^\p{Ll}+$/u.test(name)) return null; // one lowercase word: a login ("mineechoi"), not a name
  return /\p{L}{2}/u.test(name) ? name : null;
}

// ---- Outside calls ----
// Every index call is paced per service (Arc must not cause the 429s), retried once after a short wait that honours Retry-After,
// and ends in one of three states: answered with data, answered "not here" (null), or did not answer (undefined: 429, 5xx,
// timeout, network). "Did not answer" is never read as "no open copy". Paces, from each API's published keyless limits:
// OpenAlex 10 requests/s (searches also spend a small daily budget), Crossref public pool 1 query/s with concurrency 1,
// Semantic Scholar's shared keyless pool (about 1/s), Europe PMC (no published figure; 4/s), arXiv (one call per 3 s), NCBI 3/s.
const UA = "Arc/0.1 (accessible study reader)";
const PACE_MS: Record<string, number> = { openalex: 150, crossref: 1000, semanticscholar: 1100, europepmc: 250, arxiv: 3000, ncbi: 340 };
const RETRY_MAX_MS = 1500; // the student is waiting: a longer Retry-After means "did not answer"
type Transport = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;
const G = globalThis as unknown as { __arcScholarCalls?: Map<string, number>; __arcScholarNext?: Map<string, number>; __arcScholarTransport?: Transport };
const calls = (G.__arcScholarCalls ??= new Map());
const nextAt = (G.__arcScholarNext ??= new Map());
/** Calls made per service since the process started (for the report and the log). */
export const scholarCalls = () => Object.fromEntries(calls);
/** For scripts/checks/scholar.ts: answer index calls from a function instead of the network. */
export const setTransport = (t: Transport | null) => void (G.__arcScholarTransport = t ?? undefined);
// ARC_SCHOLAR_FAULT=openalex:429,europepmc:timeout makes a service fail on purpose (for testing the fallbacks on a live server).
const fault = (service: string) => new RegExp(`(^|,)${service}:(\\w+)`).exec(process.env.ARC_SCHOLAR_FAULT ?? "")?.[2];
const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((r) => { const t = setTimeout(r, Math.max(0, ms)); signal?.addEventListener("abort", () => (clearTimeout(t), r()), { once: true }); });
async function pace(service: string, signal: AbortSignal) {
  const now = Date.now();
  const at = Math.max(now, nextAt.get(service) ?? 0);
  nextAt.set(service, at + (PACE_MS[service] ?? 200));
  await pause(at - now, signal);
}

async function get(service: string, url: string, signal: AbortSignal, accept = "application/json"): Promise<string | null | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted) return undefined;
    await pace(service, signal);
    const t = Date.now();
    calls.set(service, (calls.get(service) ?? 0) + 1);
    const f = fault(service);
    const res = f
      ? f === "429" ? new Response(null, { status: 429, headers: { "retry-after": "1" } }) : null
      : await (G.__arcScholarTransport ?? safeFetch)(url, { headers: { accept, "user-agent": UA }, signal }).catch(() => null);
    const status = res?.status ?? 0;
    console.log(`[scholar] ${service} ${status || (f ?? "error")} ${Date.now() - t}ms`);
    if (res?.ok) return (await res.text().catch(() => undefined)) ?? undefined;
    await res?.body?.cancel().catch(() => {});
    if (status === 404 || status === 400 || status === 410) return null; // answered: not here
    const wait = Math.min(RETRY_MAX_MS, (Number(res?.headers.get("retry-after")) || 0.7) * 1000);
    if (attempt === 0 && wait <= RETRY_MAX_MS) await pause(wait, signal);
  }
  return undefined; // throttled, failing or too slow: did not answer
}
const json = async <T>(service: string, url: string, signal: AbortSignal): Promise<T | null | undefined> => {
  const s = await get(service, url, signal);
  if (s == null) return s;
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
};
/** The first source, in order, that answers with something; the next one starts when the one before fails or after `head` ms. */
async function cascade<T>(tries: (() => Promise<T | null | undefined>)[], head = 1200): Promise<{ value: T | null; silent: boolean }> {
  const runs: Promise<T | null | undefined>[] = [];
  let silent = false;
  let done = false;
  for (let i = 0; i < tries.length; i++) {
    runs[i] ??= tries[i]();
    if (i + 1 < tries.length) void pause(head).then(() => void (done || (runs[i + 1] ??= tries[i + 1]())));
    const v = await runs[i];
    if (v === undefined) silent = true;
    if (v) return (done = true), { value: v, silent };
  }
  done = true;
  return { value: null, silent };
}

const OA = "https://api.openalex.org/works";
const SELECT = "select=id,title,doi,ids,authorships,publication_year,primary_location,best_oa_location,locations,abstract_inverted_index,open_access,cited_by_count";
type Loc = { is_oa?: boolean; landing_page_url?: string | null; pdf_url?: string | null; version?: string | null; source?: { display_name?: string; type?: string } | null };
export type OaWork = { src?: string; abstract?: string; oaKnown?: boolean; cited_by_count?: number; title?: string | null; doi?: string | null; ids?: { pmid?: string; pmcid?: string }; authorships?: { author?: { display_name?: string } }[]; publication_year?: number | null; primary_location?: Loc | null; best_oa_location?: Loc | null; locations?: Loc[]; abstract_inverted_index?: Record<string, number[]> | null };

const version = (v?: string | null): Copy["version"] => (v === "publishedVersion" ? "published" : v === "acceptedVersion" ? "accepted" : v === "submittedVersion" ? "preprint" : null);
const ARXIV = /(?:arxiv\.org\/(?:abs|pdf|html)\/|10\.48550\/arxiv\.)([\w./-]+?)(?:v\d+)?(?:\.pdf)?\/?$/i;
const NOT_A_COPY = /(^|\.)doaj\.org$/; // a directory's record page, not the text
const PMC = /\b(PMC\d{3,9})\b/i;

/** Open copies from the index's locations, one entry per readable form, best for listening first: HTML full text (arXiv HTML,
 * PubMed Central, the publisher's open copy) before PDF; within a form, the published version before the accepted one before a preprint. */
const HAL_RECORD = /^(https:\/\/(?:[\w-]+\.)?hal\.science\/(?:hal|tel|inria|cea|halshs|insu|pasteur|in2p3|ird|inserm)-\d+)(?:v\d+)?\/?$/;
/** A work stored before Arc knew where HAL keeps the file names only the record page: add the file, so the stored work still opens. */
export function withHalFile(copies: Copy[]): Copy[] {
  const rec = copies.find((c) => c.kind === "html" && HAL_RECORD.test(c.url));
  if (!rec || copies.some((c) => c.kind === "pdf" && /(^|\.)hal\.science$/.test(new URL(c.url).hostname))) return copies;
  return [...copies, { ...rec, url: `${HAL_RECORD.exec(rec.url)![1]}/document`, kind: "pdf" }];
}
export function copiesOf(locs: Loc[]): Copy[] {
  const out: Copy[] = [];
  const add = (c: Copy) => !out.some((x) => x.url === c.url) && out.push(c);
  for (const l of locs) {
    if (!l?.is_oa || (l.landing_page_url && !l.pdf_url && NOT_A_COPY.test(new URL(l.landing_page_url).hostname))) continue;
    const repo = l.source?.display_name || (l.landing_page_url ? new URL(l.landing_page_url).hostname.replace(/^www\./, "") : "an open repository");
    const v = version(l.version);
    const a = ARXIV.exec(l.landing_page_url ?? "")?.[1] ?? ARXIV.exec(l.pdf_url ?? "")?.[1];
    const pmc = PMC.exec(l.landing_page_url ?? "")?.[1] ?? PMC.exec(l.pdf_url ?? "")?.[1];
    if (a) {
      add({ url: `https://arxiv.org/html/${a}`, kind: "html", repo: "arXiv", version: v ?? "preprint" });
      add({ url: `https://arxiv.org/pdf/${a}`, kind: "pdf", repo: "arXiv", version: v ?? "preprint" });
    } else if (pmc) {
      add({ url: `https://pmc.ncbi.nlm.nih.gov/articles/${pmc.toUpperCase()}/`, kind: "html", repo: "PubMed Central", version: v ?? "published" });
    } else {
      if (l.landing_page_url) add({ url: l.landing_page_url, kind: /\.pdf(?:$|[?#])/i.test(l.landing_page_url) ? "pdf" : "html", repo, version: v });
      // A HAL record page is a notice; its main file is at <record>/document (HAL's fileMain_s), read through the PDF route.
      const hal = HAL_RECORD.exec(l.landing_page_url ?? "")?.[1];
      if (hal && !l.pdf_url) add({ url: `${hal}/document`, kind: "pdf", repo, version: v });
      if (l.pdf_url) add({ url: l.pdf_url, kind: "pdf", repo, version: v });
    }
  }
  const rank = (c: Copy) => (c.kind === "html" ? 0 : 10) + (c.version === "published" ? 0 : c.version === "accepted" ? 1 : c.version === "preprint" ? 2 : 1);
  return out.map((c, i) => [c, i] as const).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map(([c]) => c);
}

const toWork = (w: OaWork, from: string[]): Work | null =>
  w.title
    ? {
        title: w.title.replace(/<[^>]+>/g, ""),
        authors: (w.authorships ?? []).flatMap((a) => cleanName(a.author?.display_name) ?? []),
        venue: w.primary_location?.source?.display_name ?? "",
        year: w.publication_year ?? null,
        doi: w.doi?.replace(/^https?:\/\/doi\.org\//i, "") ?? null,
        abstract: w.abstract || rebuildAbstract(w.abstract_inverted_index),
        copies: copiesOf([w.best_oa_location ?? null, ...(w.locations ?? [])].filter(Boolean) as Loc[]),
        pmid: w.ids?.pmid?.replace(/\D/g, "") || null,
        from,
      }
    : null;

// ---- Sources. Each answers in OpenAlex's record shape so the rest of the file reads one shape. ----
const CR = "https://api.crossref.org/works";
// Papers only: a Crossref search otherwise returns figures and supplementary files (type "component") as results.
const PAPER_TYPES = ["journal-article", "proceedings-article", "book-chapter", "posted-content", "monograph"].map((t) => `type:${t}`).join(",");
const CR_SELECT = "select=DOI,title,author,container-title,issued,abstract,is-referenced-by-count,alternative-id";
type CrItem = { DOI?: string; title?: string[]; author?: { given?: string; family?: string; name?: string }[]; "container-title"?: string[]; issued?: { "date-parts"?: number[][] }; abstract?: string; "is-referenced-by-count"?: number; "alternative-id"?: string[] };
const stripTags = (s = "") => s.replace(/<jats:title>[^<]*<\/jats:title>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
/** Crossref item in OpenAlex's shape. Crossref does not report open access: oaKnown stays false. */
export const fromCrossref = (c: CrItem): OaWork => ({
  title: c.title?.[0] ?? null,
  doi: c.DOI ? `https://doi.org/${c.DOI}` : null,
  publication_year: c.issued?.["date-parts"]?.[0]?.[0] ?? null,
  authorships: (c.author ?? []).map((a) => ({ author: { display_name: a.name ?? [a.given, a.family].filter(Boolean).join(" ") } })),
  primary_location: { source: { display_name: c["container-title"]?.[0] ?? "" } },
  cited_by_count: c["is-referenced-by-count"],
  abstract: stripTags(c.abstract),
  oaKnown: false,
  src: "Crossref",
});
type S2 = { title?: string; abstract?: string | null; year?: number | null; venue?: string; citationCount?: number; authors?: { name?: string }[]; externalIds?: { DOI?: string; ArXiv?: string; PubMed?: string; PubMedCentral?: string }; openAccessPdf?: { url?: string | null } | null };
const S2_FIELDS = "fields=title,abstract,year,venue,authors,externalIds,openAccessPdf,citationCount";
/** Semantic Scholar paper in OpenAlex's shape; it reports open access (openAccessPdf, arXiv and PubMed Central ids). */
export const fromS2 = (p: S2): OaWork => ({
  title: p.title ?? null,
  doi: p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : null,
  publication_year: p.year ?? null,
  authorships: (p.authors ?? []).map((a) => ({ author: { display_name: a.name ?? "" } })),
  primary_location: { source: { display_name: p.venue ?? "" } },
  cited_by_count: p.citationCount,
  abstract: p.abstract ?? "",
  ids: { pmid: p.externalIds?.PubMed },
  src: "Semantic Scholar",
  locations: [
    ...(p.externalIds?.ArXiv ? [{ is_oa: true, landing_page_url: `https://arxiv.org/abs/${p.externalIds.ArXiv}`, version: "submittedVersion" }] : []),
    ...(p.externalIds?.PubMedCentral ? [{ is_oa: true, landing_page_url: `https://pmc.ncbi.nlm.nih.gov/articles/PMC${p.externalIds.PubMedCentral}/` }] : []),
    ...(p.openAccessPdf?.url ? [{ is_oa: true, pdf_url: p.openAccessPdf.url, source: { display_name: new URL(p.openAccessPdf.url).hostname.replace(/^www\./, "") } }] : []),
  ],
  oaKnown: true,
});
type Epmc = { title?: string; doi?: string; pmid?: string; pmcid?: string; authorString?: string; journalTitle?: string; pubYear?: string; isOpenAccess?: string; inPMC?: string; citedByCount?: number; abstractText?: string };
/** Europe PMC record in OpenAlex's shape; it reports whether PubMed Central holds the full text (inPMC, pmcid). */
export const fromEpmc = (r: Epmc): OaWork => ({
  title: r.title?.replace(/\.$/, "") ?? null,
  doi: r.doi ? `https://doi.org/${r.doi}` : null,
  publication_year: Number(r.pubYear) || null,
  authorships: (r.authorString ?? "").split(/,\s*/).filter(Boolean).map((n) => ({ author: { display_name: n.replace(/\.$/, "") } })),
  primary_location: { source: { display_name: r.journalTitle ?? "" } },
  cited_by_count: r.citedByCount,
  abstract: stripTags(r.abstractText),
  ids: { pmid: r.pmid },
  src: "Europe PMC",
  locations: r.pmcid && r.inPMC === "Y" ? [{ is_oa: true, landing_page_url: `https://pmc.ncbi.nlm.nih.gov/articles/${r.pmcid}/`, source: { display_name: "PubMed Central" } }] : [],
  oaKnown: true,
});

const oa = {
  byKey: (key: string, signal: AbortSignal) => json<OaWork>("openalex", `${OA}/${encodeURIComponent(key).replace(/%3A/g, ":").replace(/%2F/g, "/")}?${SELECT}`, signal).then((w) => (w?.title ? { ...w, oaKnown: true, src: "OpenAlex" } : w)),
  search: (q: string, signal: AbortSignal) => json<{ results?: OaWork[] }>("openalex", `${OA}?search=${encodeURIComponent(q.slice(0, 250))}&per-page=8&${SELECT}`, signal).then((d) => (d === undefined ? undefined : (d?.results ?? []).map((w) => ({ ...w, oaKnown: true, src: "OpenAlex" })))),
};
const crossref = {
  doi: (doi: string, signal: AbortSignal) => json<{ message?: CrItem }>("crossref", `${CR}/${encodeURIComponent(doi)}`, signal).then((d) => (d === undefined ? undefined : d?.message ? fromCrossref(d.message) : null)),
  pii: (pii: string, signal: AbortSignal) => json<{ message?: { items?: CrItem[] } }>("crossref", `${CR}?filter=alternative-id:${encodeURIComponent(pii)}&rows=1&${CR_SELECT}`, signal).then((d) => (d === undefined ? undefined : d?.message?.items?.find((x) => x["alternative-id"]?.some((y) => y.toUpperCase() === pii)) ?? null)),
  search: (q: string, signal: AbortSignal, rows = 8) => json<{ message?: { items?: CrItem[] } }>("crossref", `${CR}?query.bibliographic=${encodeURIComponent(q.slice(0, 250))}&rows=${rows}&filter=${PAPER_TYPES}&${CR_SELECT}`, signal).then((d) => (d === undefined ? undefined : (d?.message?.items ?? []).map(fromCrossref))),
};
const s2 = {
  doi: (doi: string, signal: AbortSignal) => json<S2>("semanticscholar", `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?${S2_FIELDS}`, signal).then((p) => (p === undefined ? undefined : p?.title ? fromS2(p) : null)),
  id: (sha: string, signal: AbortSignal) => json<S2>("semanticscholar", `https://api.semanticscholar.org/graph/v1/paper/${sha}?${S2_FIELDS}`, signal).then((p) => (p === undefined ? undefined : p?.title ? fromS2(p) : null)),
  search: (q: string, signal: AbortSignal) => json<{ data?: S2[] }>("semanticscholar", `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q.slice(0, 250))}&limit=8&${S2_FIELDS}`, signal).then((d) => (d === undefined ? undefined : (d?.data ?? []).map(fromS2))),
};
const EP = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const epmcQuery = (query: string, signal: AbortSignal, size = 8) => json<{ resultList?: { result?: Epmc[] } }>("europepmc", `${EP}?query=${encodeURIComponent(query)}&format=json&resultType=core&pageSize=${size}`, signal).then((d) => (d === undefined ? undefined : (d?.resultList?.result ?? []).map(fromEpmc)));
const epmc = {
  /** Europe PMC knows biomedical papers; an empty answer means "not in Europe PMC", not "no open copy". */
  doi: (doi: string, signal: AbortSignal) => epmcQuery(`DOI:"${doi}"`, signal, 1).then((r) => (r === undefined ? undefined : (r[0] ?? null))),
  ext: (q: string, signal: AbortSignal) => epmcQuery(q, signal, 1).then((r) => (r === undefined ? undefined : (r[0] ?? null))),
  search: (q: string, signal: AbortSignal) => epmcQuery(q, signal, 8),
};
/** The same title: the same words in the same order (case, punctuation and accents aside). */
export const sameTitle = (a: string, b: string) => words(a).join(" ") === words(b).join(" ");
/** arXiv API entries (Atom) as records, each with its arXiv DOI so opening it runs the arXiv route. */
export function arxivEntries(atom: string): OaWork[] {
  const $ = cheerio.load(atom, { xml: true });
  return $("entry").toArray().flatMap((e) => {
    const id = /arxiv\.org\/abs\/(.+?)(?:v\d+)?$/.exec($(e).find("id").first().text().trim())?.[1];
    const title = $(e).find("title").first().text().replace(/\s+/g, " ").trim();
    if (!id || !title) return [];
    return [{ src: "arXiv", oaKnown: true, title, doi: `https://doi.org/10.48550/arXiv.${id}`, publication_year: Number($(e).find("published").first().text().slice(0, 4)) || null, authorships: $(e).find("author name").map((_, n) => ({ author: { display_name: $(n).text().trim() } })).get(), primary_location: { source: { display_name: "arXiv" } }, locations: [{ is_oa: true, landing_page_url: `https://arxiv.org/abs/${id}`, version: "submittedVersion" }] }];
  });
}
const arxivByTitle = async (title: string, signal: AbortSignal) => {
  const xml = await get("arxiv", `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(`ti:"${title.replace(/["()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)}"`)}&max_results=5`, signal, "application/atom+xml");
  return xml == null ? xml : arxivEntries(xml);
};

/** arXiv's own API, by title phrase and first author's surname: a preprint of the same work. Returns the arXiv id or null. */
export function arxivMatch(atom: string, title: string, surname: string): string | null {
  const $ = cheerio.load(atom, { xml: true });
  for (const e of $("entry").toArray()) {
    const t = $(e).find("title").first().text().replace(/\s+/g, " ").trim();
    const first = words($(e).find("author name").first().text()).at(-1);
    const id = /arxiv\.org\/abs\/([^v\s]+(?:v\d+)?)/.exec($(e).find("id").first().text())?.[1]?.replace(/v\d+$/, "");
    if (id && titleSimilarity(title, t) >= MATCH && first === surname) return id;
  }
  return null;
}
const arxivApi = async (title: string, surname: string, signal: AbortSignal) => {
  const q = `ti:"${title.replace(/["()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)}" AND au:${surname}`;
  const xml = await get("arxiv", `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&max_results=3`, signal, "application/atom+xml");
  return xml == null ? xml : arxivMatch(xml, title, surname);
};

/** The abstract and details from PubMed through NCBI E-utilities (PubMed's own pages refuse this machine's address). */
async function pubmed(pmid: string, signal: AbortSignal): Promise<Partial<Work> | null | undefined> {
  const xml = await get("ncbi", `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml`, signal, "application/xml");
  return xml ? parsePubmed(xml) : (xml as null | undefined);
}
/** PubMed efetch XML to the work's fields. Exported for scripts/checks/scholar.ts. */
export function parsePubmed(xml: string): Partial<Work> | null {
  const $ = cheerio.load(xml, { xml: true });
  const a = $("PubmedArticle").first();
  const title = a.find("ArticleTitle").first().text().trim();
  if (!title) return null;
  const abstract = a
    .find("Abstract AbstractText")
    .map((_, e) => [$(e).attr("Label"), $(e).text().trim()].filter(Boolean).join(": "))
    .get()
    .join("\n\n");
  const authors = a.find("AuthorList Author").map((_, e) => [$(e).find("ForeName").text(), $(e).find("LastName").text() || $(e).find("CollectiveName").text()].filter(Boolean).join(" ")).get().flatMap((n) => cleanName(n) ?? []);
  const doi = a.find('ArticleIdList ArticleId[IdType="doi"]').first().text().trim() || null;
  const pmc = a.find('ArticleIdList ArticleId[IdType="pmc"]').first().text().trim();
  return {
    title,
    abstract,
    authors,
    venue: a.find("Journal Title").first().text().trim(),
    year: Number(a.find("JournalIssue PubDate Year").first().text()) || null,
    doi,
    copies: pmc ? [{ url: `https://pmc.ncbi.nlm.nih.gov/articles/${pmc}/`, kind: "html", repo: "PubMed Central", version: "published" }] : [],
  };
}

/** The open copies of `w` and of its other records: same title (at the match bar), same first author's surname, years within one. */
export function siblingCopies(w: OaWork, sibs: OaWork[]): Copy[] {
  const first = (x: OaWork) => words(x.authorships?.[0]?.author?.display_name ?? "").at(-1);
  const out = [...(toWork(w, [])?.copies ?? [])];
  for (const x of sibs) {
    if (x === w || !first(x) || first(x) !== first(w) || titleSimilarity(w.title ?? "", x.title ?? "") < MATCH || Math.abs((x.publication_year ?? 0) - (w.publication_year ?? 0)) > 1) continue;
    for (const c of toWork(x, [])?.copies ?? []) if (!out.some((y) => y.url === c.url)) out.push(c);
  }
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "html" ? -1 : 1));
}

type Resolved = { work: Work | null; why?: "nodoi" | "short" | "nomatch" | "ambiguous" | "unknown" | "unchecked"; candidates?: OaWork[]; partial?: "exact" | "similar" };
export const strongOf = (title: string, found: OaWork[]) => found.filter((x) => titleSimilarity(title, x.title ?? "") >= MATCH).sort((a, b) => (b.cited_by_count ?? 0) - (a.cited_by_count ?? 0)).slice(0, 5);

// Kept on disk (public metadata): a work with an open copy, for good; a work that an open-access source checked and found closed,
// for a day (a free copy can appear later). A work no such source answered for is never kept: the next try asks again.
const DAY_MS = 86_400_000;
const memo = (id: Ident) => `.cache/scholar/${createHash("sha1").update(`${id.kind}:${id.value.toLowerCase()}`).digest("hex")}.json`;
/** Whether a stored work may answer for this paper now. Exported for scripts/checks/scholar.ts. */
export const keptFresh = (w: (Work & { at?: number }) | null, now = Date.now()) => !!w && (w.copies?.length > 0 || (w.checked === true && now - (w.at ?? 0) < DAY_MS));
export async function resolveKept(id: Ident, signal: AbortSignal, alias?: Ident): Promise<Resolved> {
  const kept = await readFile(memo(id), "utf8").then((x) => JSON.parse(x) as Work & { at?: number }, () => null);
  if (kept?.copies) kept.copies = withHalFile(kept.copies);
  const fresh = keptFresh(kept);
  const r: Resolved = fresh ? { work: kept } : await resolve(id, signal);
  if (fresh && !alias) return r;
  if (r.work && (r.work.copies.length || r.work.checked)) {
    await mkdir(".cache/scholar", { recursive: true }).catch(() => {});
    for (const k of [id, ...(alias ? [alias] : []), ...(r.work.doi ? [{ kind: "doi" as const, value: r.work.doi }] : [])]) await writeFile(memo(k), JSON.stringify({ ...r.work, at: Date.now() })).catch(() => {});
  }
  return r;
}

/**
 * Everything the open indexes say about the work. Finding it: OpenAlex, then Crossref, then Semantic Scholar (Europe PMC for PubMed
 * ids), each starting when the one before fails or is slow. Open copies, side by side when the record has none of its own: Europe PMC
 * (PubMed Central), Semantic Scholar, arXiv's API, then OpenAlex's other records of the same title. `work.checked` is true only when
 * a source that reports open access answered for this exact work.
 */
export async function resolve(id: Ident, signal: AbortSignal): Promise<Resolved> {
  const from = new Set<string>();
  let checked = false;
  if (id.kind === "pii") {
    const c = await crossref.pii(id.value, signal);
    if (c === undefined) return { work: null, why: "unchecked" };
    if (!c?.DOI) return { work: null, why: "nodoi" };
    from.add("Crossref");
    id = { kind: "doi", value: c.DOI };
  }
  if (id.kind === "ieee") return { work: null, why: "unknown" }; // no open index maps an IEEE document number; the page's own DOI is used instead
  let w: OaWork | null;
  let pool: OaWork[] = []; // other records seen: a preprint and its journal version are often separate records
  if (id.kind === "title") {
    const q = id.value;
    const r = await cascade([() => oa.search(q, signal), () => crossref.search(q, signal), () => s2.search(q, signal)].map((f) => () => f().then((x) => (x?.length ? x : x === undefined ? undefined : null))));
    pool = r.value ?? [];
    // Only OpenAlex's search covers enough records to know a title names one work. Otherwise: arXiv's own API by exact title too,
    // and records are offered, never chosen; only the same words in the same order count as this title ("Is Attention All You
    // Need?" is another paper than "Attention Is All You Need").
    if (pool[0]?.src !== "OpenAlex") {
      const ax = await arxivByTitle(q, signal);
      if (!pool.length && ax === undefined && r.silent) return { work: null, why: "unchecked" };
      const all = [...pool, ...(ax ?? [])];
      const exact = all.filter((x) => sameTitle(q, x.title ?? "")).sort((a, b) => (b.cited_by_count ?? 0) - (a.cited_by_count ?? 0)).slice(0, 5);
      if (exact.length) return { work: null, why: "ambiguous", candidates: exact, partial: "exact" };
      const near = strongOf(q, all);
      return near.length ? { work: null, why: "ambiguous", candidates: near, partial: "similar" } : { work: null, why: r.silent ? "unchecked" : "nomatch" };
    }
    const pick = pickByTitle(q, pool.map((x) => ({ title: x.title ?? "", doi: x.doi ?? null, year: x.publication_year ?? null, firstAuthor: x.authorships?.[0]?.author?.display_name ?? "" })));
    if ("none" in pick) return pick.none === "ambiguous" ? { work: null, why: "ambiguous", candidates: strongOf(q, pool) } : { work: null, why: pick.none };
    w = pool.find((x) => (x.doi ?? null) === pick.pick.doi && x.title === pick.pick.title) ?? null;
  } else {
    const v = id.value;
    const tries =
      id.kind === "doi" ? [() => oa.byKey(`doi:${v}`, signal), () => crossref.doi(v, signal), () => s2.doi(v, signal)]
      : id.kind === "pmid" ? [() => oa.byKey(`pmid:${v}`, signal), () => epmc.ext(`EXT_ID:${v} AND SRC:MED`, signal)]
      : id.kind === "pmcid" ? [() => oa.byKey(`pmcid:${v}`, signal), () => epmc.ext(`PMCID:${v}`, signal)]
      : id.kind === "arxiv" ? [() => oa.byKey(`doi:10.48550/arXiv.${v}`, signal), () => s2.id(`arXiv:${v}`, signal)]
      : [() => s2.id(v, signal)];
    const r = await cascade<OaWork>(tries.map((f) => () => f().then((x) => (x?.title ? x : x))));
    if (!r.value) return { work: null, why: r.silent ? "unchecked" : "unknown" };
    w = r.value;
  }
  if (!w) return { work: null, why: "unknown" };
  const take = (x: OaWork | null | undefined, src: string) => {
    if (!x?.title) return;
    from.add(src);
    if (x.oaKnown) checked = true;
    for (const c of toWork(x, [])?.copies ?? []) if (!work.copies.some((y) => y.url === c.url)) work.copies.push(c);
    work.abstract ||= toWork(x, [])?.abstract ?? "";
    work.copies.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "html" ? -1 : 1));
  };
  const work = toWork({ ...w, locations: [] , best_oa_location: null }, [])!;
  take(w, w.src ?? "an open index");
  // The record's only open copies are the publisher's own (a preview page for Arc), or it has none: ask the others side by side.
  const own = (c: Copy) => !!work.doi && decodeURIComponent(c.url).toLowerCase().includes(work.doi.toLowerCase());
  if (work.copies.every(own)) {
    const doi = work.doi;
    const surname = words(work.authors[0] ?? "").at(-1);
    const [e, s, ax] = await Promise.all([
      doi && w.src !== "Europe PMC" ? epmc.doi(doi, signal) : null,
      doi && w.src !== "Semantic Scholar" ? s2.doi(doi, signal) : null,
      surname ? arxivApi(work.title, surname, signal) : null,
    ]);
    take(e, "Europe PMC");
    take(s, "Semantic Scholar");
    if (ax) take({ title: work.title, oaKnown: true, locations: [{ is_oa: true, landing_page_url: `https://arxiv.org/abs/${ax}`, version: "submittedVersion" }] }, "arXiv");
    if (work.copies.every(own) && w.src === "OpenAlex") {
      if (!pool.length) pool = (await oa.search(work.title, signal)) ?? [];
      for (const c of siblingCopies(w, pool)) if (!work.copies.some((y) => y.url === c.url)) work.copies.push(c);
    }
  }
  const pmid = work.pmid ?? (id.kind === "pmid" ? id.value : null);
  if (!work.abstract && pmid) {
    const p = await pubmed(pmid, signal);
    if (p?.title) {
      from.add("PubMed (NCBI E-utilities)");
      work.abstract ||= p.abstract ?? "";
      for (const c of p.copies ?? []) if (!work.copies.some((x) => x.url === c.url)) work.copies.unshift(c);
    }
  }
  work.from = [...from];
  work.checked = checked;
  return { work };
}

// ---- Twins ----
const nid = (i: number) => `n${String(i).padStart(2, "0")}`;
/** Authors as spoken: the first three in full, then "and N others". */
export const names = (a: string[]) => (a.length <= 2 ? a.join(" and ") : a.length === 3 ? `${a[0]}, ${a[1]} and ${a[2]}` : `${a.slice(0, 3).join(", ")} and ${a.length - 3} ${a.length - 3 === 1 ? "other" : "others"}`);
const VERSION: Record<NonNullable<Copy["version"]>, [string, string]> = {
  published: ["the publisher's version", "the publisher's version"],
  accepted: ["the authors' accepted manuscript, not the journal's final layout", "the authors' accepted manuscript"],
  preprint: ["the authors' preprint, which can differ a little from the published version", "a preprint"],
};
/** The Details block: authors, year, journal or venue, DOI, and for a copy which version it is. Read by the question model. */
export function detailsText(w: Pick<Work, "authors" | "year" | "venue" | "doi">, c?: Copy): string {
  return [
    w.authors.length ? `By ${names(w.authors)}.` : "Authors not listed.",
    [w.venue, w.year].filter(Boolean).join(", ") + (w.venue || w.year ? "." : ""),
    w.doi ? `DOI ${w.doi}.` : "",
    c?.version ? `This copy is ${VERSION[c.version][1]}.` : "",
  ].filter(Boolean).join(" ");
}
const host = (u: string) => new URL(u).hostname.replace(/^www\./, "");
export const LINES = {
  signIn: "The full article needs the publisher's sign-in. If your school gives you access, open it in your browser and use the Arc extension.",
  noAbstract: "Arc found this paper in open indexes, but they hold no abstract for it.",
  unchecked: "Arc could not check for a free copy just now. Here are the paper's details and abstract. Try again in a minute.",
};

/** The spoken line and the visible credit for an open copy of the paper the student asked for. */
export function copyNote(c: Copy, publisher: string): { line: string; credit: string } {
  return {
    // The first sentence alone carries the essential fact (the page speaks it when the paper opens).
    line: c.version ? `This is the free copy from ${c.repo}: ${VERSION[c.version][0]}.` : `This is the free copy of the paper you asked for, from ${c.repo}.`,
    credit: `Open copy from ${c.repo}${c.version ? ` (${c.version} version)` : ""}, found through open scholarly indexes. The paper you asked for: ${publisher}`,
  };
}

/** "About this copy" (where it came from, which version), then "Details" (authors, year, venue, DOI), before the paper's own nodes.
 * Ids n00 and n000, orders -2 and -1, so the page's own ids and order stay as the parser gave them. */
export function withNote(t: Twin, line: string, credit: string, w?: Pick<Work, "authors" | "year" | "venue" | "doi"> | null, c?: Copy): Twin {
  const noFigures = !t.counts.figures && /E-utilities/.test(t.source.credit ?? "") ? " The figures are not included in this copy." : "";
  const head: TwinNode[] = [{ id: "n00", kind: "section", order: -2, level: 2, heading: "About this copy", text: line + noFigures }];
  if (w) head.push({ id: "n000", kind: "section", order: -1, level: 2, heading: "Details", text: detailsText(w, c) });
  return { ...t, source: { ...t.source, via: "open-copy", credit: [credit, t.source.credit].filter(Boolean).join(" ") }, nodes: [...head, ...t.nodes.filter((n) => n.id !== "n00" && n.id !== "n000")], counts: { ...t.counts, sections: t.counts.sections + head.length } };
}

/** The twin built from open metadata: details, the abstract as blocks, one plain line about the full text. */
export function metadataTwin(w: Work, url: string, free?: Copy): Twin {
  const details = detailsText(w);
  const only = w.abstract ? "Details and abstract only" : "Details only";
  const about = free
    ? `${only} for now: a free copy exists at ${free.repo}, but it did not open in time. Load the link again to open it.`
    : w.checked === false
      ? `${only}: Arc could not check for a free copy just now. Try again in a minute.`
      : `${only}: the full article needs the publisher's sign-in. If your school gives you access, open it in your browser and use the Arc extension.`;
  const nodes: TwinNode[] = [{ id: nid(0), kind: "section", order: 0, level: 2, heading: "About this page", text: about }];
  if (details) nodes.push({ id: nid(1), kind: "section", order: 1, level: 2, heading: "Details", text: details });
  if (w.abstract) nodes.push({ id: nid(2), kind: "section", order: 2, level: 2, heading: "Abstract", text: w.abstract.replace(/\s*\n\s*\n\s*/g, "\n\n").trim() });
  return {
    id: "twin-" + createHash("sha1").update(url).digest("hex").slice(0, 8),
    source: { url, kind: "page", title: w.title, via: "open-index", credit: `Details and abstract from ${w.from.join(", ")}. ${free ? `Free copy: ${free.url}` : `The full article is at ${host(url)}.`}` },
    nodes,
    counts: { sections: nodes.length, figures: 0, segments: 0 },
  };
}

// ---- The decision ----
// Open copies that finished loading after the student was answered, by the link they asked for (one long-lived process).
const late = ((globalThis as unknown as { __arcLateCopies?: Map<string, { twin?: Twin }> }).__arcLateCopies ??= new Map());
// Section headings that are page furniture around a preview (Springer: editor information, copyright, cite this paper, keywords).
const FURNITURE = /^(abstract|summary|keywords?|references|bibliography|notes|copyright|rights|permissions|about this|cite this|citation|editor|author|affiliation|publish with us|access|download|share|metrics|similar|related|figures?|tables?|supplementary|funding|acknowledge?ments?)/i;
/** A publisher page that loaded but is only a preview: under 2,000 characters outside the abstract and the furniture sections.
 * A full article (Introduction, Methods, ...) is far over that, so open-access pages never count as previews. */
export const isPreview = (t: Twin) => !t.pdf && t.nodes.filter((n) => n.kind === "section" && !FURNITURE.test(n.heading.trim())).reduce((k, n) => k + n.text.length, 0) < 2000;
const PAGE_GRACE_MS = 5000; // the page itself, when it loads, answers in under 1 s direct or 2 to 7 s through the Unlocker
// Hosts that show only a paywall, a sign-in or a block to Arc (measured): the indexes are asked alone, the page only if they know nothing.
const CLOSED_HOSTS = /(^|\.)(sciencedirect\.com|cell\.com|thelancet\.com|linkinghub\.elsevier\.com|ieeexplore\.ieee\.org|researchgate\.net|onlinelibrary\.wiley\.com|tandfonline\.com|dl\.acm\.org|jstor\.org|journals\.sagepub\.com|pubmed\.ncbi\.nlm\.nih\.gov)$/;
export const skipPage = (url: string) => CLOSED_HOSTS.test(new URL(url).hostname);
const BUDGET_MS = 12_000;
const wordsIn = (t: Twin) => t.nodes.reduce((n, x) => n + x.text.split(/\s+/).length, 0);
const sleep = (ms: number) => new Promise<null>((r) => setTimeout(r, Math.max(0, ms), null));
type Loaders = { page: (u: string) => Promise<Twin>; pdf: (u: string, bytes?: Uint8Array) => Promise<Twin> };
/** A HAL file, fetched as what Arc is (HAL shows a bot check to browser-like agents and serves the file to a client that names
 * itself). Through the address guard; at most 60 MB; read by the PDF route. */
async function halPdf(url: string, load: Loaders): Promise<Twin> {
  const res = await safeFetch(url, { headers: { "user-agent": UA, accept: "application/pdf" }, signal: AbortSignal.timeout(10_000) });
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!res.ok || bytes.length > 60 * 1024 * 1024 || Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-") throw new Error("HAL did not send the PDF");
  return load.pdf(url, bytes);
}
export const NO_WORK = {
  nodoi: "Arc could not find which paper this link is in the open indexes, so it will not guess. Search for the paper's title instead.",
  short: "That title is too short to know which paper it is, so Arc will not guess. Search for the title with an author's name.",
  nomatch: "Arc could not match this title to one paper in the open indexes, so it will not guess. Search for the title instead.",
  ambiguous: "Several different papers have this title, so Arc will not guess which one you mean. Search for the title with an author's name.",
  unchecked: "Arc could not reach the open scholarly indexes just now, so it cannot tell which paper this is. Try again in a minute.",
};

/**
 * The page itself when it loads with the full text; else the best open copy; else the open metadata. `pageFirst` is the normal
 * load of the pasted link (started at once, in parallel with the indexes); pass null when it already failed. Throws the page's
 * own error when the indexes know nothing either.
 */
export async function scholarLoad(url: string, id: Ident, pageFirst: Promise<Twin> | null | (() => Promise<Twin>), load: Loaders, alias?: Ident): Promise<Twin> {
  const t0 = Date.now();
  if (id.kind === "arxiv" && !/^\/html\//.test(new URL(url).pathname)) return arxivLoad(url, id.value, load); // abs page or arXiv DOI
  // A known paywalled host: do not start (or wait on) the publisher's page; it is loaded only if the indexes know nothing.
  const later = typeof pageFirst === "function" ? pageFirst : null;
  if (later) pageFirst = null;
  type P = { ok: true; twin: Twin } | { ok: false; err: Error };
  const page: Promise<P> | null = (pageFirst as Promise<Twin> | null)?.then((twin) => ({ ok: true as const, twin }), (err: Error) => ({ ok: false as const, err })) ?? null;
  const signal = AbortSignal.timeout(6000);
  const found: Promise<Resolved> = resolveKept(id, signal, alias).catch(() => ({ work: null, why: "unknown" as const }));
  const done = (t: Twin) => ((t.source.ms = Date.now() - t0), t);
  let preview: Twin | null = null; // the publisher's page loaded but holds only a preview: kept unless an open copy loads
  if (page) {
    const first = await Promise.race([page, found.then(() => null)]);
    if (first?.ok && !isPreview(first.twin)) return done(first.twin); // the page answered first with its full text
  }
  const { work, why, candidates, partial } = await found;
  if (!work && later && !(why && why in NO_WORK)) return scholarLoad(url, id, later(), load); // the indexes know nothing: the page after all
  if (!work && why === "ambiguous" && candidates?.length) {
    const hits = hitsOf(candidates, true);
    return done(resultsTwin(url, `Papers titled ${candidates[0].title}`, id.value, partial === "similar" ? `I could not find that exact paper just now. Here ${candidates.length === 1 ? "is one" : "are some"} with a similar title.` : partial ? "I could not check which paper this is just now, so I will not pick one for you. These have exactly this title. Say open and a number." : "Several papers have this title. Arc will not choose for you. Say open and a number.", hits, `Candidates from ${partial ? "open scholarly indexes" : "OpenAlex open scholarly metadata"}, most cited first.`));
  }
  console.log(`[scholar] ${id.kind} ${id.value.slice(0, 60)}: ${work ? `${work.from.join("+")}, ${work.abstract ? "abstract" : "no abstract"}, ${work.copies.length} open copies` : `no work (${why})`} ${Date.now() - t0}ms`);
  if (page) {
    const p = await Promise.race([page, work ? sleep(PAGE_GRACE_MS - (Date.now() - t0)) : page]);
    if (p?.ok && !isPreview(p.twin)) return done(p.twin);
    if (p?.ok) preview = p.twin;
    if (preview && !work?.copies.length) return done(preview); // no open copy: the publisher's page stays, as before
    const err = p && !p.ok ? p.err : undefined;
    const named = (err as { doi?: string } | undefined)?.doi; // the page would not show the paper but named it (IEEE Xplore)
    if (!work && named && id.kind !== "doi") return scholarLoad(url, { kind: "doi", value: named }, null, load, id).catch(() => Promise.reject(err));
    if (!work && !preview && !(why && why in NO_WORK)) throw err ?? new Error("Could not load that page.");
  }
  if (!work) {
    const line = why && why in NO_WORK ? NO_WORK[why as keyof typeof NO_WORK] : NO_WORK.nodoi;
    throw Object.assign(new Error(line), { name: "PageError", status: 404 });
  }
  const tried = new Set([host(url), ...(id.kind === "doi" || id.kind === "pii" ? ["doi.org", "dx.doi.org", "linkinghub.elsevier.com"] : [])]);
  const ready = late.get(url);
  if (ready?.twin) return done(ready.twin); // a copy that was still loading last time, finished since
  const copies = work.copies.filter((c) => !tried.has(host(c.url))).slice(0, 3); // polite: at most three copies
  const good = (t: Twin | null) => !!t?.nodes.length && (!!t.pdf || wordsIn(t) >= 600); // a repository record page is not the paper
  for (const c of copies) {
    const left = BUDGET_MS - (Date.now() - t0);
    if (left < 1500) break;
    const job = (c.kind === "pdf" ? (/(^|\.)hal\.science$/.test(new URL(c.url).hostname) ? halPdf(c.url, load) : load.pdf(c.url)) : /^pmc\.ncbi\.nlm\.nih\.gov$/.test(new URL(c.url).hostname) ? pmcPage(c.url) : load.page(c.url)).catch((e: Error) => (console.log(`[scholar] copy ${c.url} failed: ${e.message.slice(0, 60)}`), null));
    const twin = await Promise.race([job, sleep(left).then(() => undefined)]);
    if (twin && good(twin)) {
      const { line, credit } = copyNote(c, url);
      return done(withNote(twin, line, credit, work, c));
    }
    if (twin === undefined) {
      // Out of time with this copy still coming: let it finish in the background and open it on the next load of this link.
      late.set(url, {});
      void job.then((t) => (t && good(t) ? late.set(url, { twin: withNote(t, copyNote(c, url).line, copyNote(c, url).credit, work, c) }) : late.delete(url)));
      break;
    }
  }
  return done(preview ?? metadataTwin(work, url, copies[0] ?? work.copies[0])); // a known free copy is named, never the sign-in line
}

/** A PubMed Central article by direct fetch only: Bright Data does not fetch .gov, so the Unlocker and Browser API routes only
 * add 10 s of refusals. PMC sometimes answers this machine with a 403 or a reCAPTCHA page and the article a moment later: three
 * plain tries, 0.8 s apart. A challenge is never answered, only waited out. */
const pmcLater = ((globalThis as unknown as { __arcPmcLater?: Map<string, Twin> }).__arcPmcLater ??= new Map());
async function pmcPage(url: string): Promise<Twin> {
  const { direct, verdict } = await import("@/lib/server/fetch"); // loaded late: fetch.ts imports this file
  const before = pmcLater.get(url);
  if (before) return before; // the article page, with its figures, fetched in the background after an earlier challenge
  const got = await direct(url, AbortSignal.timeout(4000)).catch(() => null);
  const v = verdict(got, url);
  console.log(`[scholar] pmc page: ${got?.status ?? "error"} ${v.ok ? "ok" : v.why}`);
  if (v.ok) return Object.assign(v.twin, { source: { ...v.twin.source, via: "direct" as const } });
  // The page challenged or refused: the same open text from NCBI's own E-utilities (JATS XML), never past the challenge.
  const id = /PMC(\d+)/i.exec(url)?.[1];
  const xml = id ? await get("ncbi", `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${id}&retmode=xml`, AbortSignal.timeout(5000), "application/xml") : null;
  const twin = xml ? parseJats(xml, url) : null;
  if (!twin) throw new Error("PubMed Central did not answer");
  twin.source.credit = "Full text from PubMed Central through NCBI E-utilities.";
  // The article page has the figures: one more plain try in 20 s, kept for the next load if it answers.
  setTimeout(() => void direct(url, AbortSignal.timeout(6000)).then((g) => {
    const again = verdict(g, url);
    console.log(`[scholar] pmc page later: ${g?.status ?? "error"} ${again.ok ? "ok" : again.why}`);
    if (again.ok) pmcLater.set(url, Object.assign(again.twin, { source: { ...again.twin.source, via: "direct" as const } }));
  }, () => {}), 20_000).unref();
  return twin;
}

/** PubMed Central JATS XML (E-utilities efetch db=pmc) to a twin: title, abstract, each section's paragraphs, figure captions
 * as paragraphs (the image files have no stable public address in the XML). Null when the XML holds no body. */
export function parseJats(xml: string, url: string): Twin | null {
  const $ = cheerio.load(xml, { xml: true });
  const art = $("article").first();
  const text = (e: cheerio.Cheerio<import("domhandler").AnyNode>) => e.text().replace(/\s+/g, " ").trim();
  const title = text(art.find("article-meta title-group article-title").first());
  if (!title || !art.find("body").length) return null;
  const nodes: TwinNode[] = [];
  const push = (heading: string, paras: string[], level: number) => {
    const t = paras.filter(Boolean).join("\n\n");
    if (t) nodes.push({ id: nid(nodes.length + 1), kind: "section", order: nodes.length + 1, level, heading: heading || "Text", text: t });
  };
  push("Abstract", art.find("article-meta abstract").first().find("p").map((_, p) => text($(p))).get(), 2);
  const walk = (sec: cheerio.Cheerio<import("domhandler").Element>, level: number) => {
    const own = sec.children("p,fig,table-wrap").map((_, c) => (c.tagName === "p" ? text($(c)) : `${text($(c).children("label"))} ${text($(c).find("caption"))}`.trim())).get();
    push(text(sec.children("title")), own, level);
    sec.children("sec").each((_, c) => walk($(c), Math.min(level + 1, 3)));
  };
  const body = art.find("body").first();
  push("Introduction", body.children("p").map((_, p) => text($(p))).get(), 2);
  body.children("sec").each((_, c) => walk($(c), 2));
  return { id: "twin-" + createHash("sha1").update(url).digest("hex").slice(0, 8), source: { url, kind: "page", title, via: "direct" }, nodes, counts: { sections: nodes.length, figures: 0, segments: 0 } };
}

/** An arXiv abstract link opens the paper: arXiv's HTML full text when it has one for this id, else the PDF. The version in the
 * link (v3) is kept. Never the abstract page, so a stored abstract-only copy cannot win. */
export async function arxivLoad(url: string, id: string, load: Loaders): Promise<Twin> {
  const t0 = Date.now();
  const key = id + (/v\d+\/?$/.exec(new URL(url).pathname)?.[0].replace(/\/$/, "") ?? "");
  const meta = resolveKept({ kind: "arxiv", value: id }, AbortSignal.timeout(3000)).then((r) => r.work, () => null);
  const html = await load.page(`https://arxiv.org/html/${key}`).catch(() => null);
  const twin = html && wordsIn(html) >= 600 ? html : await load.pdf(`https://arxiv.org/pdf/${key}`);
  const c: Copy = { url: `https://arxiv.org/abs/${key}`, kind: "html", repo: "arXiv", version: "preprint" };
  const t = withNote(twin, copyNote(c, url).line, `Full text from arXiv (preprint). The abstract page: ${url}`, await meta, c);
  t.source.ms = Date.now() - t0;
  return t;
}

// ---- Google Scholar: a search becomes Arc's own search of open indexes ----
export type Hit = { title: string; url: string; snippet: string; open?: boolean; by?: string; year?: number }; // by, year: spoken, to tell same-titled papers apart
/** What a Google Scholar link is: a search (q), a citing list (cites), a version cluster (cluster), a profile (citations?user). */
export function scholarKind(raw: string): { kind: "search"; q: string } | { kind: "cites" | "cluster" | "profile" | "other" } | null {
  const u = new URL(raw);
  if (!/^scholar\.google\.[a-z.]+$/.test(u.hostname)) return null;
  if (u.pathname === "/citations" && u.searchParams.get("user")) return { kind: "profile" };
  if (u.searchParams.get("cites")) return { kind: "cites" };
  if (u.searchParams.get("cluster")) return { kind: "cluster" };
  const q = u.searchParams.get("q")?.trim();
  if (q) return { kind: "search", q };
  return { kind: "other" };
}
export const SCHOLAR_LINES = {
  searched: "Google Scholar does not let Arc read its pages, so Arc searched open scholarly indexes for the same words.",
  cites: "This Google Scholar link is a list of papers that cite another paper, and Google Scholar does not let Arc read it. Paste the paper's own link, or say search, and its title.",
  cluster: "This Google Scholar link lists the versions of one paper, and Google Scholar does not let Arc read it. Paste the paper's own link, or say search, and its title.",
  profile: "This is a researcher's Google Scholar profile, and Google Scholar does not let Arc read it. Say search, and the researcher's name with a topic.",
  other: "Google Scholar does not let Arc read its pages. Say search, and what you are looking for.",
};

/** Works for a query from OpenAlex, open or not; each says whether an open copy exists and links to it when it does. */
export async function searchWorks(q: string, signal: AbortSignal): Promise<Hit[]> {
  // OpenAlex, then Crossref, then Europe PMC. A fallback that does not report open access says nothing about it.
  const r = await cascade([() => oa.search(q, signal), () => crossref.search(q, signal, 10), () => epmc.search(q, signal)].map((f) => () => f().then((x) => (x?.length ? x : x === undefined ? undefined : null))), 1500);
  return hitsOf(r.value ?? [], false);
}
/** Works as results. byDoi: link each to its DOI, so opening it runs the open-copy route for exactly that work. */
export function hitsOf(found: OaWork[], byDoi: boolean): Hit[] {
  return found.flatMap((x) => {
    const w = toWork(x, ["OpenAlex"]);
    if (!w) return [];
    const open = w.copies[0];
    const known = x.src === "OpenAlex"; // only OpenAlex's search reports open access for every result; a fallback's silence is not "closed"
    const doiUrl = w.doi ? `https://doi.org/${w.doi}` : null;
    const url = (byDoi ? doiUrl : null) ?? open?.url ?? doiUrl ?? x.primary_location?.landing_page_url;
    if (!url) return [];
    const by = w.authors.length ? names(w.authors.slice(0, 3).concat(w.authors.length > 3 ? ["others"] : [])) : "";
    const line = [by, [w.venue, w.year].filter(Boolean).join(", ")].filter(Boolean).join(". ");
    const who = w.authors[0] ? { by: w.authors.length > 1 ? `${w.authors[0]} and others` : w.authors[0] } : {};
    const when = Number(w.year) ? { year: Number(w.year) } : {};
    return [{ title: w.title, url, snippet: [line, open ? `Open copy from ${open.repo}.` : known ? "Not open: abstract only." : "", w.abstract.slice(0, 240)].filter(Boolean).join(" "), open: open ? true : known ? false : undefined, ...who, ...when }];
  });
}

/** A result list as a twin (one section per result) for clients that only read twins; `results` carries the same list. */
export function resultsTwin(url: string, title: string, query: string, line: string, hits: Hit[], credit: string): Twin & { search: { query: string; results: Hit[] } } {
  const nodes: TwinNode[] = [
    { id: "n00", kind: "section", order: 0, level: 2, heading: "About these results", text: line },
    ...hits.map((h, i): TwinNode => ({ id: nid(i + 1), kind: "section", order: i + 1, level: 2, heading: h.title, text: `${h.snippet}\n\nLink: ${h.url}` })),
  ];
  return {
    id: "twin-" + createHash("sha1").update(url).digest("hex").slice(0, 8),
    source: { url, kind: "page", title, via: "open-index", credit },
    nodes,
    counts: { sections: nodes.length, figures: 0, segments: 0 },
    search: { query, results: hits },
  };
}
