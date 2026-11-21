// GET /api/image?u=<absolute url>: a figure image fetched on the server (direct, else the Web Unlocker), checked to be an image,
// size-capped and cached under .cache/images. Public http(s) hosts only (lib/server/images.ts guards every redirect hop).
// The parser's figures point here only when the direct address fails (lib/server/images.ts probeFigures).
import { fetchImage } from "@/lib/server/images";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const u = new URL(req.url).searchParams.get("u") ?? "";
  if (!/^https?:\/\//i.test(u) || u.length > 4000) return new Response("Give an http or https image address.", { status: 400 });
  const img = await fetchImage(u).catch(() => null);
  if (!img) return new Response("That image could not be loaded.", { status: 404, headers: { "cache-control": "no-store" } });
  return new Response(Buffer.from(img.body), {
    headers: {
      "content-type": img.type,
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
      // An SVG opened on its own must not run scripts on this origin.
      "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
      "x-arc-image-via": img.via,
    },
  });
}
