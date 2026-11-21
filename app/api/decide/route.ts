// POST {utterance, items, inTour?} -> Decision. Called by lib/client/decide.ts for every spoken or typed request.
import { isBudgetError } from "@/lib/server/budget";
import { decide, warm, type Item } from "@/lib/server/decide";

export const runtime = "nodejs";

// GET: called once when the page opens, so the route is compiled and the connection to the Decisions API is open before the first request.
export async function GET() {
  await warm();
  return new Response(null, { status: 204 });
}

export async function POST(req: Request) {
  const b = (await req.json().catch(() => null)) as { utterance?: unknown; items?: unknown; inTour?: unknown; state?: unknown } | null;
  if (typeof b?.utterance !== "string" || !b.utterance.trim()) {
    return Response.json({ error: "Missing utterance." }, { status: 400 });
  }
  const items = (Array.isArray(b.items) ? b.items : []).filter(
    (i): i is Item => typeof i?.id === "string" && typeof i?.label === "string",
  );
  try {
    // state: short strings from lib/client/command.ts (mode, current item, position, last commands); anything else is dropped.
    const state = b.state && typeof b.state === "object" ? Object.fromEntries(Object.entries(b.state).filter(([, v]) => typeof v === "string").slice(0, 8).map(([k, v]) => [k.slice(0, 40), (v as string).slice(0, 300)])) : {};
    return Response.json(await decide({ utterance: b.utterance, items, inTour: b.inTour === true, state }));
  } catch (e) {
    // No budget for a decision: answer "a question, not sure" so the client hands the words to the question session, which
    // speaks the budget line in Arc's voice (lib/server/live.ts). A 503 here made the client say only "That did not work".
    if (isBudgetError(e)) return Response.json({ action: "question", confidence: 0, target: null, targetConfidence: 0, setting: null, settingConfidence: 0, query: b.utterance, ms: 0, act: false, budget: e.code, say: e.say });
    console.error("decide failed:", e instanceof Error ? e.message : "unknown");
    return Response.json({ error: "The decision service did not answer." }, { status: 502 });
  }
}
