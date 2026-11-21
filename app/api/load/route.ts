import { liveRoute, loadPage, offline, refuseUrl, statedDoi } from "@/lib/server/fetch";
import { checkMessage, checkUrl, normalizeUrl, NOT_PUBLIC, safeFetch } from "@/lib/server/safeFetch";
import { probeFigures } from "@/lib/server/images";
import { warmBlocks } from "@/lib/server/pageQueue";
import { pdfFromLink, pdfTwin, PdfError } from "@/lib/server/pdf";
import { warmPage } from "@/lib/server/tourQueue";
import { isVideoUrl, videoToTwin } from "@/lib/server/video";
import { redditLink, redditLoad } from "@/lib/server/reddit";
import { identify, resultsTwin, SCHOLAR_LINES, scholarKind, scholarLoad, searchWorks, skipPage, isPreview } from "@/lib/server/scholar";
import type { Twin } from "@/lib/types";

export const runtime = "nodejs";

const PDF_URL = /\.pdf(?:$|[?#])|^https?:\/\/(?:export\.)?arxiv\.org\/pdf\//i;

export async function POST(req: Request) {
  const { url: input, live } = (await req.json().catch(() => ({}))) as { url?: unknown; live?: boolean };
  // What the student pasted, as an address: trimmed, https added, scheme and host lower-cased, tracking parameters dropped.
  const url = normalizeUrl(input);
  if (url === "scheme") return Response.json({ error: NOT_PUBLIC }, { status: 400 });
  if (!url) return Response.json({ error: "That does not look like a web address." }, { status: 400 });
  // The address guard, before any fetch, Bright Data call or browser (lib/server/safeFetch.ts; each redirect is checked again).
  const checked = await checkUrl(url);
  if (!checked.ok) return Response.json({ error: checkMessage(checked.why) }, { status: checked.why === "dns" ? 404 : 400 });
  const refused = refuseUrl(url);
  if (refused) return Response.json({ error: refused.message }, { status: refused.status });
  try {
    const yt = youtubeList(url);
    if (yt === "channel") return Response.json({ error: "That is a channel. Paste one video from it." }, { status: 422 });
    if (yt === "playlist") {
      const first = await firstOfPlaylist(url);
      if (!first) return Response.json({ error: "That is a playlist. Paste one video from it." }, { status: 422 });
      return Response.json(await videoToTwin(first));
    }
    if (isVideoUrl(url)) return Response.json(await videoToTwin(url));
    if (PDF_URL.test(url)) return Response.json(await pdfFromLink(url, new URL(req.url).origin));
    const origin = new URL(req.url).origin;
    // Google Scholar and Reddit: their own routes (lib/server/scholar.ts, lib/server/reddit.ts).
    const gs = scholarKind(url);
    if (gs) {
      if (gs.kind !== "search") return Response.json({ error: SCHOLAR_LINES[gs.kind] }, { status: 422 });
      const hits = await searchWorks(gs.q, AbortSignal.timeout(6000)).catch(() => []);
      if (!hits.length) return Response.json({ error: "Search is not answering right now." }, { status: 502 });
      return Response.json(resultsTwin(url, `Search: ${gs.q}`, gs.q, SCHOLAR_LINES.searched, hits, "Results from open scholarly indexes (OpenAlex, else Crossref or Europe PMC), for the words of a Google Scholar search."));
    }
    const rd = redditLink(url);
    if (rd) {
      const r = await redditLoad(rd);
      if ("twin" in r) return Response.json(r.twin);
      return Response.json(resultsTwin(url, rd.sub ? `r/${rd.sub}` : "Reddit search", rd.sub ?? "", "Threads from Reddit's public feed.", r.results, "From Reddit's public feed."));
    }
    // The page; a link that turns out to be a PDF is read as a PDF, never as text.
    const page = (u: string) => loadPage(u, { live: !!live }).catch((e) => ((e as Error).name === "IsPdf" ? pdfFromLink(u, origin) : Promise.reject(e)));
    const loaders = { page, pdf: (u: string, bytes?: Uint8Array) => (bytes ? pdfTwin(bytes, u, { origin }) : pdfFromLink(u, origin)) };
    // A link that names a paper: the page and the open indexes at once; the open copy or the open metadata when the page fails.
    const work = identify(url);
    let twin: Twin = work
      ? await scholarLoad(url, work, skipPage(url) ? () => page(url) : page(url), loaders)
      : await page(url).catch((e) => {
          const doi = (e as { doi?: string }).doi; // the page named its paper but would not show it
          if (doi) return scholarLoad(url, { kind: "doi", value: doi }, null, loaders).catch(() => Promise.reject(e));
          throw e;
        });
    // A page whose address names no paper but whose citation tags do, and which shows only a preview: the open copy when one exists.
    const stated = !work && statedDoi(twin);
    if (stated && isPreview(twin)) twin = await scholarLoad(url, { kind: "doi", value: stated }, Promise.resolve(twin), loaders).catch(() => twin);
    if (twin.pdf) return Response.json(twin);
    const img = await probeFigures(twin, origin); // figures the browser cannot load directly go through /api/image
    if (img.probed) console.log(`[images] ${new URL(url).hostname}: ${img.proxied} of ${img.probed} figures proxied (${img.ms} ms)`);
    warmTours(twin);
    warmBlocks(twin); // code's leftover trouble, one background model pass per flagged node; never awaited
    // A stored copy: say which route the live fetch the page asks for next will take (none when offline).
    const next = twin.source.via === "cache" && !live && !offline() ? liveRoute(url) : undefined;
    return Response.json({ ...twin, live: next });
  } catch (e) {
    if (e instanceof PdfError) return Response.json({ error: e.message }, { status: 422 });
    if ((e as Error).name === "BlockedUrl") return Response.json({ error: (e as Error).message }, { status: 400 }); // a redirect to a refused address
    return Response.json({ error: e instanceof Error ? e.message : "Could not load that page." }, { status: (e as { status?: number }).status ?? 502 });
  }
}

/** A YouTube playlist page (no single video in the link) or a channel page. */
function youtubeList(url: string): "playlist" | "channel" | null {
  const u = new URL(url);
  if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
  if (u.pathname === "/playlist" && u.searchParams.get("list")) return "playlist";
  if (/^\/(@[^/]+|channel\/|c\/|user\/)/.test(u.pathname)) return "channel";
  return null;
}

/** The playlist's first video, read from its page with one plain fetch (about half a second); null when it is not there. */
async function firstOfPlaylist(url: string): Promise<string | null> {
  const res = await safeFetch(url, { headers: { "accept-language": "en-US,en;q=0.9", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" }, signal: AbortSignal.timeout(5000) }).catch(() => null);
  const html = res?.ok ? await res.text().catch(() => "") : "";
  const id = /"playlistVideoRenderer":\{"videoId":"([\w-]{11})"/.exec(html)?.[1] ?? /"videoId":"([\w-]{11})"/.exec(html)?.[1];
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

/** Start figure tours in the background while the student reads (never awaited). */
const warmTours = (twin: Twin) => warmPage(twin.nodes.flatMap((n) => (n.kind === "figure" && n.image && !n.tour ? [n.image.url] : [])));
