import { getTour } from "@/lib/server/tour";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const image = new URL(req.url).searchParams.get("image");
  if (!image) return Response.json({ error: "missing ?image=" }, { status: 404 });
  const tour = await getTour(image);
  return tour ? Response.json(tour) : Response.json({ error: "no tour for this image" }, { status: 404 });
}
