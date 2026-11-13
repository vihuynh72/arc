// POST {query} -> web search through Bright Data (Google SERP zone, else Web Unlocker + DuckDuckGo/Bing), raced with OpenAlex papers.
// With `accept: application/x-ndjson` it streams one line per batch as each lands ({results, via, ms}); otherwise one merged JSON.
// Always live: a query searched before first streams its saved results (via "cache") at once, then the live batches.
// ARC_OFFLINE=1: the saved results only, no live search.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as cheerio from "cheerio";
import { serp, unlock } from "@/lib/server/brightdata";
import { offline } from "@/lib/server/fetch";
import { searchPapers } from "@/lib/server/openalex";

export const runtime = "nodejs";

type Hit = { title: string; url: string; snippet: string };
const BAN = /(^|\.)quizlet\.com$/;

const clean = (hits: Hit[]) => {
  const seen = new Set<string>();
  return hits.filter((h) => {
    try {
      const u = new URL(h.url);
      if (!/^https?:$/.test(u.protocol) || BAN.test(u.hostname) || seen.has(h.url) || !h.title) return false;
      seen.add(h.url);
      return true;
    } catch {
      return false;
    }
  });
};

// DuckDuckGo wraps links as //duckduckgo.com/l/?uddg=<encoded url>
function parseDdg(html: string): Hit[] {
  const $ = cheerio.load(html);
  return $(".result:not(.result--ad)").map((_, e) => {
    const href = $(e).find(".result__a").attr("href") ?? "";
    const url = new URL(href, "https://duckduckgo.com").searchParams.get("uddg") ?? "";
    return { title: $(e).find(".result__a").text().trim(), url, snippet: $(e).find(".result__snippet").text().trim() };
  }).get();
}

// Bing wraps links as bing.com/ck/a?...&u=a1<base64url of the target>
function parseBing(html: string): Hit[] {
  const $ = cheerio.load(html);
  return $("li.b_algo").map((_, e) => {
    let url = $(e).find("h2 a").attr("href") ?? "";
    const u = new URL(url, "https://www.bing.com").searchParams.get("u");
    if (u?.startsWith("a1")) url = Buffer.from(u.slice(2), "base64url").toString("utf8");
    return { title: $(e).find("h2").text().trim(), url, snippet: $(e).find(".b_caption p, p").first().text().trim() };
  }).get();
}

// Google (also with brd_json=1) returned an empty body on this zone, and MDPI search is refused for
// robots.txt reasons on the no-KYC zone, so DuckDuckGo then Bing are the working routes.
const routes: [string, (q: string) => string, (h: string) => Hit[]][] = [
  ["unlocker:duckduckgo", (q) => `https://html.duckduckgo.com/html/?q=${q}`, parseDdg],
  ["unlocker:bing", (q) => `https://www.bing.com/search?q=${q}`, parseBing],
];

type Batch = { results: Hit[]; via: string; ms: number };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// The SERP zone sometimes answers 200 with an empty body after 35 s or more: 5 s cap, a second copy at 3 s, first good one wins.
async function google(q: string): Promise<Hit[]> {
  // google.com/goto links hide the real address, so they are dropped.
  const once = async () => {
    const hits = clean((await serp(q, AbortSignal.timeout(5000))).filter((o) => !/^https?:\/\/(www\.)?google\./.test(o.link)).map((o) => ({ title: o.title, url: o.link, snippet: o.description ?? "" })));
    if (hits.length < 3) throw new Error("too few usable SERP results"); // same bar as the Unlocker routes below
    return hits;
  };
  const first = once();
  const second = Promise.race([first, sleep(3000).then(() => Promise.reject(new Error("first not back")))]).catch(() => once());
  return Promise.any([first, second]);
}

const savedFile = (q: string) => `.cache/search/${createHash("sha1").update(q.toLowerCase()).digest("hex")}.json`;
/** The web results saved the last time this query was searched: only the instant first view. */
const saved = async (q: string): Promise<Hit[] | null> => {
  const s = await readFile(savedFile(q), "utf8").catch(() => null);
  return s ? clean((JSON.parse(s) as { results: Hit[] }).results ?? []) : null;
};

/** The Bright Data web results, live; saved to disk for the next first view. */
async function web(q: string, t: number): Promise<Batch> {
  const file = savedFile(q);
  try {
    const results = (await google(q)).slice(0, 8);
    await mkdir(".cache/search", { recursive: true });
    await writeFile(file, JSON.stringify({ results, via: "brightdata:google" }));
    return { results, via: "brightdata:google", ms: Date.now() - t };
  } catch {
    // fall back to the Web Unlocker routes
  }
  for (const [via, url, parse] of routes) {
    try {
      const results = clean(parse(await unlock(url(encodeURIComponent(q)), { markdown: false }))).slice(0, 8);
      if (results.length < 3) continue;
      await mkdir(".cache/search", { recursive: true });
      await writeFile(file, JSON.stringify({ results, via }));
      return { results, via, ms: Date.now() - t };
    } catch {
      // try the next route
    }
  }
  throw new Error("web search failed");
}

async function papers(q: string, t: number): Promise<Batch> {
  const found = await searchPapers(q, AbortSignal.timeout(4000));
  const results = found.map((p) => ({
    title: p.title,
    url: p.url,
    snippet: [[p.venue, p.year].filter(Boolean).join(", "), p.abstract.slice(0, 280)].filter(Boolean).join(". "),
  }));
  return { results: clean(results), via: "openalex", ms: Date.now() - t };
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
  const fresh = (b: Batch): Batch => ({
    ...b,
    results: b.results.filter((h) => {
      const k = keys(h);
      if (k.some((x) => seen.has(x))) return false;
      k.forEach((x) => seen.add(x));
      return true;
    }),
  });
  const w = web(q, t);
  const p = papers(q, t);
  // Bright Data leads when it answers within about 2 s; otherwise OpenAlex keeps the 2-second promise and Bright Data is appended.
  const quickly = Promise.race([w.then(() => true, () => false), sleep(1800).then(() => false)]);

  if (!ndjson) {
    const jobs = (await quickly) ? [w, p] : [p, w];
    const done = await Promise.allSettled(jobs);
    const batches = done.flatMap((d) => (d.status === "fulfilled" ? [fresh(d.value)] : []));
    if (!batches.length) return Response.json({ error: "Search is not answering right now." }, { status: 502 });
    return Response.json({ results: batches.flatMap((b) => b.results), via: batches.map((b) => b.via).join("+"), ms: Date.now() - t });
  }

  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(ctl) {
      let sent = 0;
      // The saved results go out first, before the wait for Bright Data; the page replaces or extends them (components/Twin.tsx).
      if (earlier?.length) ctl.enqueue(enc.encode(JSON.stringify({ results: earlier, via: "cache", ms: Date.now() - t }) + "\n"));
      const quick = await quickly;
      const jobs = quick ? [w, p] : [p, w];
      if (quick) {
        // Bright Data first, then OpenAlex, in that order.
        for (const j of jobs) {
          const b = await j.catch(() => null);
          if (b) {
            sent++;
            ctl.enqueue(enc.encode(JSON.stringify(fresh(b)) + "\n"));
          }
        }
      } else await Promise.allSettled(
        jobs.map((j) =>
          j.then((b) => {
            sent++;
            ctl.enqueue(enc.encode(JSON.stringify(fresh(b)) + "\n"));
          }),
        ),
      );
      if (!sent) ctl.enqueue(enc.encode(JSON.stringify({ error: "Search is not answering right now." }) + "\n"));
      ctl.close();
    },
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}
