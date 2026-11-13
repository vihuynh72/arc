// POST {utterance, items, inTour?} -> Decision. Called by lib/client/decide.ts for every spoken or typed request.
import { decide, warm, type Item } from "@/lib/server/decide";

export const runtime = "nodejs";

// GET: called once when the page opens, so the route is compiled and the SubQ connection is open before the first request.
export async function GET() {
  await warm();
  return new Response(null, { status: 204 });
}

export async function POST(req: Request) {
  const b = (await req.json().catch(() => null)) as { utterance?: unknown; items?: unknown; inTour?: unknown } | null;
  if (typeof b?.utterance !== "string" || !b.utterance.trim()) {
    return Response.json({ error: "Missing utterance." }, { status: 400 });
  }
  const items = (Array.isArray(b.items) ? b.items : []).filter(
    (i): i is Item => typeof i?.id === "string" && typeof i?.label === "string",
  );
  try {
    return Response.json(await decide({ utterance: b.utterance, items, inTour: b.inTour === true }));
  } catch (e) {
    console.error("decide failed:", e instanceof Error ? e.message : "unknown");
    return Response.json({ error: "The decision service did not answer." }, { status: 502 });
  }
}
