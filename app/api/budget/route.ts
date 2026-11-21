// GET -> today's estimated spend by feature and by model, Bright Data counts and the guard's level (lib/server/budget.ts).
// Same machine only, checked as app/api/pointer does: on a public host it answers 404, so strangers do not learn the budget.
import { report } from "@/lib/server/budget";

export const runtime = "nodejs";

const local = (req: Request) => {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
  const fwd = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean); // Next sets this to the peer address
  return fwd.every((a) => ["::1", "127.0.0.1", "::ffff:127.0.0.1"].includes(a)) && ["localhost", "127.0.0.1", "[::1]"].includes(host);
};

export function GET(req: Request) {
  if (!local(req)) return new Response("Not found", { status: 404 });
  return Response.json(report(), { headers: { "cache-control": "no-store" } });
}
