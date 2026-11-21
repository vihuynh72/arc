import { prioritise } from "@/lib/server/tourQueue";

export const runtime = "nodejs";

// POST {image}: build this figure's tour next. Called by components/FigureTour.tsx when a tour opens.
export async function POST(req: Request) {
  const { image } = (await req.json().catch(() => ({}))) as { image?: unknown };
  if (typeof image !== "string" || !/^https?:\/\//i.test(image)) return Response.json({ error: "Send {image}." }, { status: 400 });
  if (!prioritise(image)) return Response.json({ error: "no tour for this image" }, { status: 404 }); // never seen on a page Arc loaded
  return Response.json({ ok: true });
}
