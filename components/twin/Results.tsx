// Search results as a plain list the reading cursor can move through. Used by components/Twin.tsx, which also reads the
// first three aloud with resultLine and puts results from a source the student named first (preferSource).
// Nothing in a result is a Tab stop: Enter opens the result under the cursor, a number key opens that result, a click anywhere on
// one opens it, Escape goes back to the page behind (Twin's "leave").
import { useEffect, useRef } from "react";
import { narrowOpen, searchPending } from "@/lib/client/narrow";
import { splitSentences } from "@/lib/client/reader";
import { siteWord } from "@/lib/intent";

export type Result = { title: string; url: string; snippet: string; open?: boolean; by?: string; year?: number; rank?: number; study?: boolean }; // rank, study: from app/api/search (lib/server/search.ts order) // open, by, year: a paper (lib/server/scholar.ts, OpenAlex)

const SITES: Record<string, string> = { openstax: "OpenStax", khanacademy: "Khan Academy", wikipedia: "Wikipedia", libretexts: "LibreTexts", britannica: "Britannica", nih: "the National Institutes of Health", bbc: "the BBC", mdpi: "MDPI", nature: "Nature", youtube: "YouTube", doi: "a journal", arxiv: "arXiv", ck12: "CK-12" };
const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};
/** The site a result is from, as said aloud: "OpenStax", else its address ("biologydictionary.net"). */
export const siteName = (u: string) => SITES[siteWord(host(u))] ?? host(u);
/** What kind of thing a result is, when its address says so: "a textbook chapter", "a video". */
export function kindOf(r: Result): string {
  const u = r.url.toLowerCase();
  if (r.open !== undefined || /doi\.org|arxiv\.org|mdpi\.com|ncbi\.nlm\.nih\.gov\/pmc|nature\.com\/articles/.test(u)) return "a paper";
  if (/youtube\.com\/watch|youtu\.be\/|khanacademy\.org\/.*\/v\//.test(u)) return "a video";
  if (/openstax\.org\/books|libretexts\.org/.test(u)) return "a textbook chapter";
  if (/wikipedia\.org\/wiki|britannica\.com/.test(u)) return "an encyclopedia article";
  if (/khanacademy\.org|ck12\.org/.test(u)) return "a lesson";
  if (/\.pdf($|[?#])/.test(u)) return "a PDF";
  return "";
}
const NUMS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"];
/** "One: 8.1 Overview of Photosynthesis, Biology 2e, OpenStax, a textbook chapter." The title loses the site name it often ends with. */
export function resultLine(r: Result, n: number): string {
  const site = siteName(r.url);
  const parts = r.title.split(/\s+[|–—-]\s+/).map((x) => x.trim()).filter((x) => x && x.toLowerCase() !== site.toLowerCase());
  const N = NUMS[n] ?? String(n);
  // A paper from the research index: who wrote it, when, and whether a free copy exists tell same-titled papers apart by ear; "a journal" does not.
  if (r.open !== undefined) return `${N}: ${r.title.replace(/[.\s]+$/, "")}${r.by ? `, by ${r.by}` : ""}${r.year ? `, ${r.year}` : ""}, ${r.open ? "free copy" : "abstract only"}.`;
  const kind = kindOf(r);
  return `${N}: ${(parts.length ? parts : [r.title]).join(", ").replace(/[.\s]+$/, "")}, ${site}${kind ? `, ${kind}` : ""}.`;
}
/** One sentence of what a result says, for landing on it: a paper's snippet starts with its venue and year, already said. */
export const resultSummary = (r: Result) => {
  const s = splitSentences(r.snippet);
  return (r.open !== undefined && s.length > 1 && s[0].length < 80 ? s[1] : s[0]) ?? "";
};
/** The query's words that name a site a result could come from ("openstax" in "photosynthesis openstax biology"). */
export const namedSites = (query: string) => {
  const w = query.toLowerCase().split(/\s+/);
  return Object.keys(SITES).filter((k) => k !== "doi" && (w.includes(k) || w.some((x, i) => x + (w[i + 1] ?? "") === k)));
};
/** Results from a named site first, in their own order; `has`: at least one is from such a site. */
export function preferSource(query: string, results: Result[]): { results: Result[]; has: boolean; named: boolean } {
  const named = namedSites(query);
  if (!named.length) return { results, has: false, named: false };
  const from = (r: Result) => named.includes(siteWord(host(r.url)));
  const mine = results.filter(from);
  return { results: [...mine, ...results.filter((r) => !from(r))], has: mine.length > 0, named: true };
}

type Props = {
  query: string;
  results: Result[];
  ids: string[]; // cursor ids, one per result
  onOpen: (url: string) => void;
};

export default function Results({ query, results, ids, onOpen }: Props) {
  const at = useRef(-1); // the result under the reading cursor
  const live = useRef({ results, ids, onOpen });
  useEffect(() => {
    live.current = { results, ids, onOpen };
  });
  useEffect(() => {
    const onCursor = (e: Event) => void (at.current = live.current.ids.indexOf((e as CustomEvent<{ id: string }>).detail?.id));
    // Capture phase, before the reader (Enter would read the result again, a number would jump by heading level).
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (narrowOpen() || searchPending() || e.repeat || e.ctrlKey || e.metaKey || e.altKey || t?.closest?.("input, textarea, select, button, a, [contenteditable='true'], dialog")) return;
      const { results: r, onOpen: open } = live.current;
      const k = Number(e.key);
      const i = e.key === "Enter" ? Math.max(at.current, 0) : k >= 1 && k <= 9 ? k - 1 : -1;
      if (e.key === "Escape") return void setTimeout(() => window.dispatchEvent(new CustomEvent("arc:command", { detail: { name: "leave" } })), 0); // after the key has stopped the voice
      if (i < 0 || !r[i]) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      open(r[i].url);
    };
    window.addEventListener("arc:cursor", onCursor);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("arc:cursor", onCursor);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);
  return (
    <section aria-labelledby="results-title" className="results">
      <h1 id="results-title">Search results for {query}</h1>
      {results.length === 0 && <p>No results.</p>}
      <ol>
        {results.map((r, i) => {
          const kind = kindOf(r);
          return (
            <li key={ids[i]} data-node-id={ids[i]} onClick={() => onOpen(r.url)}>
              <h2 data-cursor>{r.title}</h2>
              <p className="result-from">
                {siteName(r.url)}
                {kind && ` · ${kind.replace(/^an? /, "")}`}
                {r.year ? ` · ${r.year}` : ""}
              </p>
              <p>{r.snippet}</p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
