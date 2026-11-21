// POST {request, asked:[{q,a,kind}], level?} -> one narrowing step (lib/server/narrow.ts). Called by lib/client/narrow.ts, which
// searches with what it has on any error, a budget refusal or a slow answer: this route can make a search better, never block it.
import { isBudgetError } from "@/lib/server/budget";
import { narrowStep, type Asked } from "@/lib/server/narrow";

export const runtime = "nodejs";

const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");

export async function POST(req: Request) {
  const b = (await req.json().catch(() => null)) as { request?: unknown; asked?: unknown; level?: unknown } | null;
  const request = str(b?.request, 200);
  if (!request) return Response.json({ error: "Missing request." }, { status: 400 });
  const asked: Asked[] = (Array.isArray(b?.asked) ? b.asked : []).slice(0, 4).map((x: { q?: unknown; a?: unknown; kind?: unknown }) => ({ q: str(x?.q, 200), a: str(x?.a, 200), kind: str(x?.kind, 20) }));
  try {
    return Response.json(await narrowStep(request, asked, str(b?.level, 60) || undefined));
  } catch (e) {
    if (isBudgetError(e)) return Response.json({ error: "budget" }, { status: 503 });
    console.error("narrow failed:", e instanceof Error ? e.message : "unknown");
    return Response.json({ error: "The narrowing step did not answer." }, { status: 502 });
  }
}
