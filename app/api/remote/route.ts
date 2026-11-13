// POST {url, figure} -> screenshot of the real page (Bright Data Browser API) with the figure's box. Read-only.
import { remoteShot } from "@/lib/server/remote";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  const { url, figure } = (await req.json().catch(() => ({}))) as { url?: string; figure?: number };
  if (!url || !/^https?:\/\//.test(url) || !Number.isInteger(figure) || figure! < 1)
    return Response.json({ error: "Send a page address and a figure number." }, { status: 400 });
  if (/(^|\.)quizlet\.com$/.test(new URL(url).hostname))
    return Response.json({ error: "That site does not allow this." }, { status: 400 });
  try {
    return Response.json(await remoteShot(url, figure!));
  } catch (e) {
    console.error("remote view failed:", e instanceof Error ? e.message.split("\n")[0] : e);
    return Response.json({ error: "The live page did not answer in time." }, { status: 502 });
  }
}
