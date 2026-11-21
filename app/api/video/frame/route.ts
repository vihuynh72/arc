// A picture taken from a video (lib/server/videoFrames.ts): GET ?id=<youtubeId>&node=<segment id> -> image/jpeg.
import { readFile } from "node:fs/promises";
import { framePath } from "@/lib/server/videoFrames";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const id = q.get("id") ?? "";
  const node = q.get("node") ?? "";
  if (!/^[\w-]{11}$/.test(id) || !/^n\d{2,4}$/.test(node)) return Response.json({ error: "Give a YouTube video id and a segment id." }, { status: 400 });
  const jpg = await readFile(framePath(id, node)).catch(() => null);
  if (!jpg) return Response.json({ error: "No picture for that segment yet." }, { status: 404 });
  return new Response(new Uint8Array(jpg), { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" } });
}
