// POST {query} -> {results, via, ms}. Web search through the Bright Data Web Unlocker.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as cheerio from "cheerio";
import { unlock } from "@/lib/server/brightdata";

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

export async function POST(req: Request) {
  const t = Date.now();
  const { query } = (await req.json().catch(() => ({}))) as { query?: string };
  const q = query?.trim().slice(0, 200);
  if (!q) return Response.json({ error: "Say what you want to search for." }, { status: 400 });

  const file = `.cache/search/${createHash("sha1").update(q.toLowerCase()).digest("hex")}.json`;
  const hit = await readFile(file, "utf8").catch(() => null);
  if (hit) return Response.json({ ...JSON.parse(hit), via: "cache", ms: Date.now() - t });

  for (const [via, url, parse] of routes) {
    try {
      const results = clean(parse(await unlock(url(encodeURIComponent(q)), { markdown: false }))).slice(0, 8);
      if (results.length < 3) continue;
      await mkdir(".cache/search", { recursive: true });
      await writeFile(file, JSON.stringify({ results, via }));
      return Response.json({ results, via, ms: Date.now() - t });
    } catch {
      // try the next route
    }
  }
  return Response.json({ error: "Search is not answering right now." }, { status: 502 });
}
