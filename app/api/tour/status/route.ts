import { status } from "@/lib/server/tourQueue";

export const runtime = "nodejs";

// GET ?images=a,b or ?images=a&images=b: {image: {state, kind?}} for each.
export async function GET(req: Request) {
  const images = new URL(req.url).searchParams.getAll("images").flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean).slice(0, 60);
  return Response.json(await status(images));
}
