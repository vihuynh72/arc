import { loadPage } from "@/lib/server/fetch";
import { isVideoUrl, videoToTwin } from "@/lib/server/video";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { url, live } = (await req.json().catch(() => ({}))) as { url?: string; live?: boolean };
  if (!url || !/^https?:\/\//i.test(url)) return Response.json({ error: "Enter a web address that starts with http." }, { status: 400 });
  try {
    if (isVideoUrl(url)) return Response.json(await videoToTwin(url));
    return Response.json(await loadPage(url, { live: !!live }));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Could not load that page." }, { status: 502 });
  }
}
