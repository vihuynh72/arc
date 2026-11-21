// GET -> {available}. POST {x, y, ms?} (screen points) -> glides the real mouse pointer there. Local machine only.
import { movePointer, pointerAvailable } from "@/lib/server/pointer";

export const runtime = "nodejs";

// The pointer belongs to whoever sits at this machine: only a browser on the same machine may move it.
const local = (req: Request) => {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
  const fwd = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean); // Next sets this to the peer address
  return fwd.every((a) => ["::1", "127.0.0.1", "::ffff:127.0.0.1"].includes(a)) && ["localhost", "127.0.0.1", "[::1]"].includes(host);
};

export async function GET(req: Request) {
  return Response.json({ available: local(req) && pointerAvailable() });
}

export async function POST(req: Request) {
  if (!local(req)) return Response.json({ moved: false }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as { x?: number; y?: number; ms?: number };
  return Response.json({ moved: movePointer(Number(b.x), Number(b.y), b.ms === undefined ? 350 : Number(b.ms)) });
}
