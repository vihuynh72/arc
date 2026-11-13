import { fetchMarkdown } from "@/lib/server/fetch";
import { isVideoUrl, videoToTwin } from "@/lib/server/video";
import { parseMarkdown } from "@/lib/parse/markdown";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { url, live } = (await req.json().catch(() => ({}))) as { url?: string; live?: boolean };
  if (!url || !/^https?:\/\//i.test(url)) return Response.json({ error: "Enter a web address that starts with http." }, { status: 400 });
  try {
    if (isVideoUrl(url)) return Response.json(await videoToTwin(url));
    const { markdown, via, ms } = await fetchMarkdown(url, { live: !!live });
    const twin = parseMarkdown(markdown, url);
    twin.source.via = via;
    twin.source.ms = ms;
    return Response.json(twin);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Could not load that page." }, { status: 502 });
  }
}
