import { serve } from "@/lib/server/tourQueue";

export const runtime = "nodejs";

// GET ?image=: the best tour now (full if ready, else the quick one; "stage": "quick" means a fuller one is coming).
// GET ?image=&want=full: 200 with the full tour, 202 while it is still being read, 404 when it failed or never comes.
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const image = q.get("image");
  if (!image) return Response.json({ error: "missing ?image=" }, { status: 404 });
  const want = q.get("want") === "full";
  const { tour, coming } = await serve(image, want);
  if (tour) return Response.json(tour, { headers: { "x-tour-coming": coming ? "1" : "0" } });
  if (want && coming) return Response.json({ state: "building" }, { status: 202 });
  return Response.json({ error: "no tour for this image" }, { status: 404 });
}
