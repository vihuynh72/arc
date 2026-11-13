import { loadPage } from "@/lib/server/fetch";
import { warmPage } from "@/lib/server/tourQueue";
import { isVideoUrl, videoToTwin } from "@/lib/server/video";
import type { Twin } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { url, live } = (await req.json().catch(() => ({}))) as { url?: string; live?: boolean };
  if (!url || !/^https?:\/\//i.test(url)) return Response.json({ error: "Enter a web address that starts with http." }, { status: 400 });
  try {
    if (isVideoUrl(url)) return Response.json(await videoToTwin(url));
    const twin = await loadPage(url, { live: !!live });
    warmTours(twin);
    return Response.json(twin);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Could not load that page." }, { status: 502 });
  }
}

/** Start figure tours in the background while the student reads (never awaited). */
const warmTours = (twin: Twin) => warmPage(twin.nodes.flatMap((n) => (n.kind === "figure" && n.image && !n.tour ? [n.image.url] : [])));
