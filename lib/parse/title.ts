// A page or video title without the site and breadcrumb names around it: "Bayes' theorem - Wikipedia" -> "Bayes' theorem",
// "Applying mathematical reasoning | Pre-Algebra | Khan Academy" -> "Applying mathematical reasoning". Callers: lib/parse/html.ts,
// lib/server/captions.ts, lib/server/oembed.ts. Checked by scripts/checks/htmlblocks.ts.
const SITES = /^(wikipedia|wikimedia|khan academy|openstax|libretexts|.* libretexts|youtube|pubmed central|pmc|ncbi|nature|plos one|plos|mdn web docs|mdn|stack overflow|britannica|encyclop(a)?edia britannica|coursera|edx|mit opencourseware|ocw|github|medium|substack|reddit|scholarpedia|stanford encyclopedia of philosophy|arxiv(\.org)?|semantic scholar|researchgate|springerlink|sciencedirect|ieee xplore)$/i;

export function cleanTitle(raw: string, site = ""): string {
  const t = raw.replace(/\s+/g, " ").trim();
  // Split on " | ", " - ", " – ", " — ", " · " and keep the first part when every later part is a site name or short breadcrumb.
  const parts = t.split(/\s+[|–—·]\s+|\s+-\s+/);
  if (parts.length < 2 || parts[0].length < 3) return t;
  const rest = parts.slice(1);
  const siteLike = (p: string) => SITES.test(p.trim()) || (!!site && p.trim().toLowerCase() === site.trim().toLowerCase());
  if (siteLike(rest[rest.length - 1]) && rest.every((p) => siteLike(p) || p.split(" ").length <= 5)) return parts[0].trim();
  return t;
}
