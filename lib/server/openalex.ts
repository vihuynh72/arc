// OpenAlex open scholarly metadata (no key, nothing personal sent). Callers: app/api/preview/route.ts, app/api/search/route.ts.
const API = "https://api.openalex.org/works";
const SELECT = "select=title,doi,abstract_inverted_index,publication_year,primary_location,best_oa_location";

type Loc = { landing_page_url?: string | null; source?: { display_name?: string } | null } | null;
type Work = { title?: string | null; doi?: string | null; abstract_inverted_index?: Record<string, number[]> | null; publication_year?: number | null; primary_location?: Loc; best_oa_location?: Loc };
export type Paper = { title: string; url: string; doi: string | null; venue: string; year: number | null; abstract: string };

/** OpenAlex stores abstracts as word -> positions; rebuild the text. */
export function rebuildAbstract(inv?: Record<string, number[]> | null): string {
  if (!inv) return "";
  const words: string[] = [];
  for (const [w, at] of Object.entries(inv)) for (const i of at) words[i] = w;
  return words.filter(Boolean).join(" ");
}

const toPaper = (w: Work): Paper | null => {
  if (!w.title) return null;
  const url = w.best_oa_location?.landing_page_url || w.primary_location?.landing_page_url || w.doi;
  if (!url) return null;
  return { title: w.title, url, doi: w.doi ?? null, venue: w.primary_location?.source?.display_name ?? "", year: w.publication_year ?? null, abstract: rebuildAbstract(w.abstract_inverted_index) };
};

async function get(url: string, signal: AbortSignal): Promise<Work[]> {
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) return [];
  const d = (await res.json()) as { results?: Work[] } & Work;
  return d.results ?? (d.title ? [d] : []);
}

/** Open-access works for a search query. */
export async function searchPapers(q: string, signal: AbortSignal): Promise<Paper[]> {
  const works = await get(`${API}?search=${encodeURIComponent(q)}&per-page=6&filter=open_access.is_oa:true&${SELECT}`, signal);
  return works.map(toPaper).filter((p): p is Paper => !!p);
}

/** The one work a page link points at, when the link says enough: a DOI, a PMC id, or an MDPI issn/volume/issue/article path. */
export async function paperFor(link: string, signal: AbortSignal, title?: string): Promise<Paper | null> {
  const doi = /\b(10\.\d{4,9}\/[^\s?#]+)/.exec(decodeURIComponent(link))?.[1];
  const pmc = /\b(PMC\d+)\b/i.exec(link)?.[1];
  // shortcut: only MDPI's path shape is decoded; other publishers fall back to a title search when a hint gives one.
  const mdpi = /mdpi\.com\/(\d{4}-\d{3}[\dX])\/(\d+)\/(\d+)\/(\d+)/i.exec(link);
  let q: string | null = null;
  if (doi) q = `${API}/doi:${doi}?${SELECT}`;
  else if (pmc) q = `${API}/pmcid:${pmc.toUpperCase()}?${SELECT}`;
  else if (mdpi) q = `${API}?filter=primary_location.source.issn:${mdpi[1]},biblio.volume:${mdpi[2]},biblio.issue:${mdpi[3]},biblio.first_page:${mdpi[4]}&per-page=1&${SELECT}`;
  else if (title) q = `${API}?search=${encodeURIComponent(title.slice(0, 200))}&per-page=1&${SELECT}`;
  if (!q) return null;
  const w = (await get(q, signal))[0];
  return w ? toPaper(w) : null;
}
