// POST {url, hint?: {title, snippet}} -> a small first Twin within ~1.5 s, or 204. Called by components/Twin.tsx while /api/load runs.
// Sources raced: a plain fetch of the page, OpenAlex open metadata, and the search result the student picked.
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { paperFor } from "@/lib/server/openalex";
import { identify } from "@/lib/server/scholar";
import { youtubeOembed } from "@/lib/server/oembed";
import { isVideoUrl } from "@/lib/server/video";
import { safeFetch } from "@/lib/server/safeFetch";
import type { Twin, TwinNode } from "@/lib/types";

export const runtime = "nodejs";

const BUDGET = 1400;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BAN = /(^|\.)quizlet\.com$/;
const squash = (s = "") => s.replace(/\s+/g, " ").trim();

type Page = { title: string; summary: string; body: { heading: string; text: string }[] };

/** Plain fetch with a browser User-Agent: title, description, and the first headings and paragraphs when the body is really there. */
async function plain(url: string, signal: AbortSignal): Promise<Page | null> {
  const res = await safeFetch(url, { signal, headers: { "user-agent": UA, accept: "text/html" } }); // address guard on every hop
  if (!res.ok || !/html/i.test(res.headers.get("content-type") ?? "")) return null;
  const $ = cheerio.load(await res.text());
  const meta = (n: string) => squash($(`meta[name="${n}"],meta[property="${n}"]`).first().attr("content"));
  const title = squash(meta("citation_title") || meta("og:title") || $("title").first().text());
  const summary = meta("citation_abstract") || meta("description") || meta("og:description");
  const body: Page["body"] = [];
  const root = $("article").first().length ? $("article").first() : $("main").first().length ? $("main").first() : $("body");
  root.find("script,style,nav,header,footer,aside,figure").remove();
  let cur: Page["body"][number] | null = null;
  root.find("h2,h3,p").each((_, e) => {
    if (body.length >= 8) return false;
    const t = squash($(e).text());
    if (/^h/i.test(e.tagName)) {
      if (t && t.length < 120) body.push((cur = { heading: t, text: "" }));
    } else if (cur && t.length > 60 && cur.text.split("\n\n").length < 3) cur.text += (cur.text ? "\n\n" : "") + t;
  });
  return title ? { title, summary, body: body.filter((b) => b.text) } : null;
}

const within = <T,>(p: Promise<T>) => p.catch(() => null);

export async function POST(req: Request) {
  const { url, hint } = (await req.json().catch(() => ({}))) as { url?: string; hint?: { title?: string; snippet?: string } };
  let u: URL;
  try {
    u = new URL(url ?? "");
    if (!/^https?:$/.test(u.protocol) || BAN.test(u.hostname)) throw new Error();
  } catch {
    return Response.json({ error: "Enter a web address that starts with http." }, { status: 400 });
  }
  const t0 = Date.now();
  const signal = AbortSignal.timeout(BUDGET);
  const id = "preview-" + createHash("sha1").update(u.href).digest("hex").slice(0, 8);
  const node = (i: number, heading: string, text: string): TwinNode => ({ id: `p${String(i + 1).padStart(2, "0")}`, kind: "section", order: i + 1, level: 2, heading, text });
  const reply = (kind: Twin["source"]["kind"], title: string, parts: [string, string][], from: string) => {
    const nodes = parts.map(([h, t], i) => node(i, h, t));
    // via is not shown for a preview; `from` names the real source for the status line and the voice.
    const twin: Twin = { id, source: { url: u.href, kind, title, via: "cache", ms: Date.now() - t0 }, nodes, counts: { sections: nodes.length, figures: 0, segments: 0 } };
    return Response.json({ ...twin, from });
  };

  if (isVideoUrl(u.href)) {
    const v = await within(youtubeOembed(u.href, signal));
    if (!v) return new Response(null, { status: 204 });
    return reply("video", v.title, [[v.title, v.author ? `A video by ${v.author}.` : ""]], "YouTube");
  }

  const [page, paper] = await Promise.all([within(plain(u.href, signal)), within(paperFor(u.href, signal, identify(u.href) ? hint?.title : undefined)) /* a title search of the paper index only for a scholarly page */]);
  const title = paper?.title || page?.title || squash(hint?.title);
  if (!title) return new Response(null, { status: 204 });
  const summary = paper?.abstract || page?.summary || squash(hint?.snippet);
  const parts: [string, string][] = [[title, ""]];
  if (summary) parts.push([paper?.abstract ? "Abstract" : "Summary", summary]);
  for (const b of page?.body ?? []) if (!/^abstract$/i.test(b.heading)) parts.push([b.heading, b.text]);
  if (parts.length < 2) return new Response(null, { status: 204 });
  const from = paper?.abstract ? "open metadata (OpenAlex)" : page ? "the page itself" : "the search result";
  return reply("page", title, parts, from);
}
