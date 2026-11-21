// GET /api/page/blocks?id=<twin id> -> { done, drop, say }: the background model pass over a web twin's flagged blocks
// (lib/server/pageQueue.ts). The client polls until done; drop lists block ids to skip, say maps block ids to spoken forms.
import { blockFix } from "@/lib/server/pageQueue";

export const runtime = "nodejs";

export function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[\w-]{1,80}$/.test(id)) return Response.json({ error: "Give the twin id." }, { status: 400 });
  return Response.json(blockFix(id), { headers: { "cache-control": "no-store" } });
}
