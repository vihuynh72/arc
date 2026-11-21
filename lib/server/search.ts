// The search's ordering and racing rules, pure (no I/O, so lib/client/narrow.ts shares contentWords): app/api/search/route.ts
// ranks, dedupes and races its routes with these; scripts/checks/search.ts checks them offline.

export type Hit = { title: string; url: string; snippet: string; open?: boolean; year?: number; rank?: number; study?: boolean };

const STOP = new Set(
  "a an the and or of for in on to with about from by at as is are was be it its this that these those how what why which who when where do does i me my we you want need like study studying learn learning help some something stuff thing things one ones kind sort bit part about please just really".split(" "),
);
/** The words of a query that carry its meaning ("the one about how cells divide" -> cells, divide). */
export const contentWords = (q: string) =>
  q.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").split(/\s+/).filter((w) => w.length >= 2 && !STOP.has(w));

// Sources Arc reads well and a student can trust come first: open textbooks, encyclopedias, lessons and lectures Arc opens, open papers.
const TRUST: RegExp[] = [
  /(^|\.)(openstax\.org|libretexts\.org|ck12\.org|lumenlearning\.com|pressbooks\.pub)$/,
  /(^|\.)(wikipedia\.org|britannica\.com)$/,
  /(^|\.)(khanacademy\.org|youtube\.com|youtu\.be)$/,
  /(^|\.)(ncbi\.nlm\.nih\.gov|arxiv\.org|mdpi\.com|doi\.org|plos\.org|nature\.com|openalex\.org)$|\.edu$/,
];
const tier = (h: Hit) => {
  try {
    const host = new URL(h.url).hostname.replace(/^www\./, "");
    const i = TRUST.findIndex((re) => re.test(host));
    return i < 0 ? TRUST.length : i;
  } catch {
    return TRUST.length;
  }
};
const stem = (w: string) => w.slice(0, 4); // "divide" and "division", "cells" and "cell"
// Words that only frame a request: the subject, the site, the level, the kind of material. "OpenStax Biology 2e Chapters 1.1"
// shares "openstax" and "biology" with "photosynthesis openstax biology" and is still not about photosynthesis.
const FRAME = new Set(
  "biology chemistry physics math maths mathematics science history geography economics psychology anatomy physiology medicine engineering calculus algebra statistics openstax wikipedia khan khanacademy libretexts britannica youtube ck12 first year college school university high advanced intro introduction introductory beginner textbook textbooks chapter chapters lecture lectures video videos lesson lessons paper papers notes course 2e".split(" "),
);
/** Shares a word (by stem) of what the query is about with the result's title and snippet; with only framing words, one of those. */
export function relevant(h: Hit, q: string): boolean {
  const all = contentWords(q);
  const topic = all.filter((w) => !FRAME.has(w));
  const qw = (topic.length ? topic : all).map(stem);
  if (!qw.length) return true;
  const hw = new Set(contentWords(`${h.title} ${h.snippet}`).map(stem));
  return qw.some((w) => hw.has(w));
}
// The same chapter mirrored on two sites ("8.1 Overview of Photosynthesis - Biology 2e | OpenStax" and "8.1: Overview of
// Photosynthesis - Biology LibreTexts"): its title without the numbering and the site's tail; three words or more, since
// "Photosynthesis" alone names many different chapters.
export const mirror = (title: string) => {
  const t = title.split(/\s+[|–—-]\s+/)[0].replace(/^\s*\d+(?:\.\d+)*[.:]?\s+/, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return t.split(" ").length >= 3 ? `m:${t}` : `t:${title.toLowerCase()}`;
};

/**
 * Best first, each page once. Relevance before source: a result sharing none of the query's words never ranks above one that does.
 * rank: a number the browser sorts merged batches by; study: a relevant textbook, encyclopedia, lesson or lecture (the first three tiers).
 */
export function order(hits: Hit[], q: string): Hit[] {
  const seen = new Set<string>();
  return hits
    .map((h, i) => {
      const r = relevant(h, q);
      const t = tier(h);
      return { h: { ...h, rank: (r ? 0 : 10) + t, study: r && t <= 2 }, i };
    })
    .sort((a, b) => a.h.rank - b.h.rank || a.i - b.i)
    .map((x) => x.h)
    .filter((h) => {
      const k = [h.url, mirror(h.title)];
      if (k.some((x) => seen.has(x))) return false;
      k.forEach((x) => seen.add(x));
      return true;
    });
}
export const hasStudy = (hits: Hit[] | null | undefined) => !!hits?.some((h) => h.study);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/**
 * A staggered race: each route starts at its delay unless one already won; the first with `need` results or more wins. When none
 * reaches that, the largest non-empty answer is used once every route has finished; it rejects only when all failed or came back empty.
 */
export async function race(tries: [string, number, () => Promise<Hit[]>][], need = 3): Promise<{ results: Hit[]; via: string }> {
  let won = false;
  const partial: { results: Hit[]; via: string }[] = [];
  const runs = tries.map(([via, delay, go]) =>
    sleep(delay).then(async () => {
      if (won) throw new Error("not needed");
      const results = await go();
      if (results.length < need) {
        if (results.length) partial.push({ results, via });
        throw new Error("too few");
      }
      won = true;
      return { results, via };
    }),
  );
  return Promise.any(runs).catch(() => {
    const best = partial.sort((a, b) => b.results.length - a.results.length)[0];
    if (!best) throw new Error("web search failed");
    return best;
  });
}

/** Text of a result's HTML with a space wherever two page elements meet ("<span>Chapter Summary</span><span>8.1</span>Overview"
 * reads "Chapter Summary 8.1 Overview", not "8.1Overview"), whitespace collapsed. No parser: this file is shared with the browser. */
export function spacedText(html: string): string {
  return html
    .replace(/<\/?(?:div|p|br|li|ul|ol|dd|dt|h[1-6]|td|th|tr|section|span|cite|time)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** A search that asks for research: a paper word, an author-and-year, a DOI or arXiv id. Only these ask the paper index (whose free
 * daily allowance ordinary searches used up); an ordinary topic search asks it only when the web routes return too little. */
export const scholarly = (q: string) =>
  /\b(papers?|study|studies|articles?|journals?|review|reviews|preprints?|doi|et al|arxiv|pubmed|abstract|citations?|thesis|dissertation|meta-analysis)\b/i.test(q) ||
  /\b\p{Lu}\p{Ll}+(?: et al\.?)?,? \(?(?:19|20)\d{2}\)?/u.test(q) ||
  /\b10\.\d{4,9}\/\S+|\b\d{4}\.\d{4,5}\b/.test(q);
