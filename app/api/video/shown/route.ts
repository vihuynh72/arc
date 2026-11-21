// The video pipeline (lib/server/videoQueue.ts). GET ?id=<youtubeId>: everything known so far (all segments, in order, with
// stable ids; headings; shown). POST {id, duration}: the player's length bounds the windows. POST {id, node} or {id, at}: the
// student moved there, so that window goes first. POST {id, node, frame: true}: the student asked for that segment's picture.
// GET also returns frames: {node: {url, at, visual}}; url is absolute so /api/tour?image=<url> can fetch it server-side.
import { seePictures } from "@/lib/server/tourQueue";
import { atNode, prioritise, requestFrame, restore, setDuration, status } from "@/lib/server/videoQueue";

export const runtime = "nodejs";

const valid = (id: unknown): id is string => typeof id === "string" && /^[\w-]{11}$/.test(id);

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!valid(id)) return Response.json({ error: "Give a YouTube video id." }, { status: 400 });
  const s = await status(id);
  const origin = new URL(req.url).origin;
  const frames = Object.fromEntries(
    Object.entries(s.frames).map(([node, f]) => [node, { url: `${origin}/api/video/frame?id=${id}&node=${node}`, at: f.at, visual: f.visual }]),
  );
  seePictures(Object.values(frames).map((f) => f.url)); // Arc's own stills: their tours may be built (lib/server/tourQueue.ts)
  return Response.json({ ...s, frames });
}

export async function POST(req: Request) {
  const { id, node, at, duration, frame } = (await req.json().catch(() => ({}))) as { id?: unknown; node?: unknown; at?: unknown; duration?: unknown; frame?: unknown };
  if (!valid(id)) return Response.json({ error: "Give a YouTube video id." }, { status: 400 });
  const out: Record<string, boolean | string> = {};
  await restore(id); // after a restart the job is only on disk
  if (frame === true && typeof node === "string") out.frame = requestFrame(id, node); // "ready" | "queued" | "unknown" | why not
  if (typeof duration === "number") out.duration = setDuration(id, duration);
  const t = typeof at === "number" ? at : typeof node === "string" ? atNode(id, node) : undefined;
  if (t !== undefined) out.queued = prioritise(id, t);
  if (!Object.keys(out).length) return Response.json({ error: "Give a duration, a segment id or a time in seconds." }, { status: 400 });
  return Response.json(out);
}
