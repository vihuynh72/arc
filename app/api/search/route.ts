// POST {query} -> web search through Bright Data (Google SERP zone, else Web Unlocker + DuckDuckGo/Bing), raced with OpenAlex papers.
// With `accept: application/x-ndjson` it streams one line per batch as each lands ({results, via, ms}); otherwise one merged JSON.
// Always live: a query searched before first streams its saved results (via "cache") at once, then the live batches.
// ARC_OFFLINE=1: the saved results only, no live search.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as cheerio from "cheerio";
import { serp, unlock } from "@/lib/server/brightdata";
import { offline, refuseUrl } from "@/lib/server/fetch";
import { searchPapers } from "@/lib/server/openalex";
import { hasStudy, order, race, scholarly, spacedText, type Hit } from "@/lib/server/search";

export const runtime = "nodejs";

/** Usable results: no Quizlet, nothing Arc knows it cannot open (a sign-in app, another video site). Ordering is lib/server/search.ts. */
const clean = (hits: Hit[]) =>
  hits.filter((h) => {
    try {
      return /^https?:$/.test(new URL(h.url).protocol) && !!h.title && !refuseUrl(h.url);
    } catch {
      return false;
    }
  });

// DuckDuckGo wraps links as //duckduckgo.com/l/?uddg=<encoded url>
function parseDdg(html: string): Hit[] {
  const $ = cheerio.load(html);
  return $(".result:not(.result--ad)").map((_, e) => {
    const href = $(e).find(".result__a").attr("href") ?? "";
    const url = new URL(href, "https://duckduckgo.com").searchParams.get("uddg") ?? "";
    return { title: spacedText($(e).find(".result__a").html() ?? ""), url, snippet: spacedText($(e).find(".result__snippet").html() ?? "") };
  }).get();
}

// Bing wraps links as bing.com/ck/a?...&u=a1<base64url of the target>
function parseBing(html: string): Hit[] {
  const $ = cheerio.load(html);
  return $("li.b_algo").map((_, e) => {
    let url = $(e).find("h2 a").attr("href") ?? "";
    const u = new URL(url, "https://www.bing.com").searchParams.get("u");
    if (u?.startsWith("a1")) url = Buffer.from(u.slice(2), "base64url").toString("utf8");
    return { title: spacedText($(e).find("h2").html() ?? ""), url, snippet: spacedText($(e).find(".b_caption p, p").first().html() ?? "") };
  }).get();
}

// DuckDuckGo then Bing through the Unlocker, after Google: MDPI search is refused for robots.txt reasons on the no-KYC zone.
const routes: [string, (q: string) => string, (h: string) => Hit[]][] = [
  ["unlocker:duckduckgo", (q) => `https://html.duckduckgo.com/html/?q=${q}`, parseDdg],
  ["unlocker:bing", (q) => `https://www.bing.com/search?q=${q}`, parseBing],
];

type Batch = { results: Hit[]; via: string; ms: number };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// The SERP zone sometimes answers 200 with an empty body after 35 s or more: 5 s cap, a second copy at 3 s, first good one wins.
async function google(q: string): Promise<Hit[]> {
  // Most organic links come as google.com/goto, which hides the address (measured: 5 of 7 for "organic chemistry"; only the videos
  // and one or two pages kept theirs, so the batch was all YouTube). A goto whose display_link is a whole site is that site; one
  // with a cut path ("chem.libretexts.org › Bookshelves › ...") cannot be rebuilt and is dropped.
  const once = async () =>
    clean(
      (await serp(q, AbortSignal.timeout(5000))).flatMap((o) => {
        const shown = (o as { display_link?: string }).display_link ?? "";
        const url = !/^https?:\/\/(www\.)?google\./.test(o.link) ? o.link : /^https?:\/\/[^\s›/]+\/?$/.test(shown) ? shown : "";
        return url ? [{ title: o.title, url, snippet: o.description ?? "" }] : [];
      }),
    );
  const first = once();
  const second = Promise.race([first, sleep(3000).then(() => Promise.reject(new Error("first not back")))]).catch(() => once());
  return Promise.any([first, second]);
}

const savedFile = (q: string) => `.cache/search/${createHash("sha1").update(q.toLowerCase()).digest("hex")}.json`;
/** The list saved the last time this query was searched (the final merged, ranked list): only the instant first view. */
const saved = async (q: string): Promise<Hit[] | null> => {
  const s = await readFile(savedFile(q), "utf8").catch(() => null);
  return s ? order(clean((JSON.parse(s) as { results: Hit[] }).results ?? []), q) : null;
};

/** The Bright Data web results, live (each Unlocker route may take 14 s: measured 7 to 11 s on a slow night, and a 9 s cap turned
 * those into a false "no results"). A staggered race, not a queue (lib/server/search.ts race): Google SERP at once, DuckDuckGo
 * through the Unlocker at 1.5 s and Bing at 3 s if nothing good has come back. Measured before: one after another took 3 to 14 s. */
async function web(q: string, t: number): Promise<Batch> {
  const stage = (s: string) => console.log(`[search] ${s} ${Date.now() - t}ms`);
  type Try = [string, number, () => Promise<Hit[]>];
  const routesToTry: Try[] = [
    ["brightdata:google", 0, () => google(q)],
    ...routes.map(([via, url, parse], i): [string, number, () => Promise<Hit[]>] => [via, 1500 * (i + 1), async () => clean(parse(await unlock(url(encodeURIComponent(q)), { markdown: false, signal: AbortSignal.timeout(14_000) })))]),
  ];
  const tries = routesToTry.map(([via, delay, go]): Try => [via, delay, async () => {
    stage(`${via} start`);
    const r = (await go().catch((e: unknown) => (stage(`${via} failed: ${(e as Error).message}`), Promise.reject(e)))).slice(0, 8);
    stage(`${via} ${r.length} results`);
    return r;
  }]);
  const best = await race(tries);
  return { ...best, results: order(best.results, q), ms: Date.now() - t };
}

// Paper searches are kept a day: the same words do not spend the paper index's daily allowance twice.
const paperFile = (q: string) => `.cache/papers/${createHash("sha1").update(q.toLowerCase()).digest("hex")}.json`;
async function papers(q: string, t: number): Promise<Batch> {
  const kept = await readFile(paperFile(q), "utf8").then((x) => JSON.parse(x) as { at: number; found: Awaited<ReturnType<typeof searchPapers>> }, () => null);
  const fresh = kept && Date.now() - kept.at < 86_400_000;
  console.log(`[search] paper index ${fresh ? "kept copy" : "asked"} for "${q.slice(0, 60)}"`);
  const found = fresh ? kept.found : await searchPapers(q, AbortSignal.timeout(4000));
  if (!fresh && found.length) await mkdir(".cache/papers", { recursive: true }).then(() => writeFile(paperFile(q), JSON.stringify({ at: Date.now(), found }))).catch(() => {});
  const results = found.map((p) => ({
    title: p.title,
    url: p.url,
    snippet: [[p.venue, p.year].filter(Boolean).join(", "), p.abstract.slice(0, 280)].filter(Boolean).join(". "),
    open: true, // the search asks OpenAlex for open-access works only
    ...(p.year ? { year: p.year } : {}),
  }));
  return { results: order(clean(results), q), via: "openalex", ms: Date.now() - t };
}

// One key per paper or page: the DOI when the link is one, else the bare address; titles too, since the same paper has many homes.
const keys = (h: Hit) => {
  const doi = /10\.\d{4,9}\/\S+/.exec(h.url)?.[0]?.toLowerCase();
  const bare = h.url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "").toLowerCase();
  return [doi ?? bare, h.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()];
};

export async function POST(req: Request) {
  const t = Date.now();
  const { query } = (await req.json().catch(() => ({}))) as { query?: string };
  const q = query?.trim().slice(0, 200);
  if (!q) return Response.json({ error: "Say what you want to search for." }, { status: 400 });

  const ndjson = /ndjson/.test(req.headers.get("accept") ?? "");
  const earlier = await saved(q);
  if (offline()) {
    if (!earlier?.length) return Response.json({ error: "Arc is offline and has no saved results for this search." }, { status: 502 });
    const b = { results: earlier, via: "cache", ms: Date.now() - t };
    return ndjson ? new Response(JSON.stringify(b) + "\n", { headers: { "content-type": "application/x-ndjson" } }) : Response.json(b);
  }

  const seen = new Set<string>();
  const all: Hit[] = [];
  const fresh = (b: Batch): Batch => {
    const results = b.results.filter((h) => {
      const k = keys(h);
      if (k.some((x) => seen.has(x))) return false;
      k.forEach((x) => seen.add(x));
      return true;
    });
    all.push(...results);
    return { ...b, results };
  };
  // Saved once every route has finished: the merged, ranked list, never one batch; and a list with no study source in it never
  // replaces a saved one that has one (a night of YouTube-only answers must not become tomorrow's first view).
  // The saved list never shrinks to one slow night's answer: this search's results merged with the saved ones, ranked, ten at most.
  const keep = async () => {
    const list = order([...all, ...(earlier ?? [])], q).slice(0, 10);
    if (!list.length || (!hasStudy(list) && hasStudy(earlier))) return;
    await mkdir(".cache/search", { recursive: true });
    await writeFile(savedFile(q), JSON.stringify({ results: list, via: "merged" })).catch(() => {});
  };
  const w = web(q, t);
  // The paper index only for a search that asks for research, or when the web routes return too little.
  const p = scholarly(q) ? papers(q, t) : w.then((b) => (b.results.length >= 3 ? null : papers(q, t)), () => papers(q, t)).then((b) => b ?? Promise.reject(new Error("not asked")));
  if (!scholarly(q)) console.log(`[search] paper index not asked first for "${q.slice(0, 60)}"`);
  w.then((b) => console.log(`[search] web done ${b.ms}ms`), () => console.log(`[search] web failed ${Date.now() - t}ms`));
  p.then((b) => console.log(`[search] openalex done ${b.ms}ms`), (e) => console.log(`[search] openalex ${(e as Error).message === "not asked" ? "not needed" : "failed"} ${Date.now() - t}ms`));

  if (!ndjson) {
    const done = await Promise.allSettled([w, p]);
    const batches = done.flatMap((d) => (d.status === "fulfilled" ? [fresh(d.value)] : []));
    await keep();
    if (!batches.length) return Response.json({ error: "Search is not answering right now." }, { status: 502 });
    return Response.json({ results: order(all, q), via: batches.map((b) => b.via).join("+"), ms: Date.now() - t });
  }

  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(ctl) {
      let sent = 0;
      // The saved list goes out first; then each live batch the moment it lands, each result with its rank, so the browser merges
      // them in order (components/Twin.tsx). The stream ends only when every route has finished: "no results" means that.
      if (earlier?.length) ctl.enqueue(enc.encode(JSON.stringify({ results: earlier, via: "cache", ms: Date.now() - t }) + "\n"));
      await Promise.allSettled(
        [w, p].map((j) =>
          j.then((b) => {
            sent++;
            ctl.enqueue(enc.encode(JSON.stringify(fresh(b)) + "\n"));
          }),
        ),
      );
      await keep();
      if (!sent) ctl.enqueue(enc.encode(JSON.stringify({ error: "Search is not answering right now." }) + "\n"));
      ctl.close();
    },
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}
