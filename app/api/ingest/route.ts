// POST the page the student sent from their own browser (the Arc helper extension, or the bookmarklet through an Arc tab):
// {url, title, html, images, links, frames, videos, youtube, lines} or {url, title, pdf: {name, data}}. Nothing is fetched: this
// route receives content, it never fetches an address it is given. Kept in memory only (lib/server/ingest.ts, lib/server/vault.ts).
// GET with header x-arc-doc: <32 hex> (or ?id=) -> the private twin (components/Twin.tsx, /#doc=<id>); GET ?img=<key> -> one of its pictures.
// Nothing about the page (address, title, text) is logged.
import { IngestError, ingest, LIMITS, validate } from "@/lib/server/ingest";
import * as vault from "@/lib/server/vault";

export const runtime = "nodejs";

// Cross-origin: only the extension's own background page (chrome-extension://...) may post here. The bookmarklet posts from an
// Arc tab (same origin). Any other site gets no CORS headers, so a browser will not let it read the answer.
const cors = (req: Request): Record<string, string> => {
  const o = req.headers.get("origin") ?? "";
  return /^chrome-extension:\/\/[a-p]{32}$/.test(o) ? { "access-control-allow-origin": o, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, x-arc-doc", vary: "origin" } : {};
};
const reply = (req: Request, body: unknown, status = 200) => Response.json(body, { status, headers: { ...cors(req), "cache-control": "no-store" } });
const TOO_BIG = "That page is larger than Arc can take: 40 megabytes with its pictures.";

export function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: cors(req) });
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  // A page on another site must not plant documents here (the extension and Arc's own tab are the only senders).
  if (origin && origin !== new URL(req.url).origin && !cors(req)["access-control-allow-origin"]) return reply(req, { error: "Not allowed." }, 403);
  if (Number(req.headers.get("content-length") || 0) > LIMITS.body) return reply(req, { error: TOO_BIG, code: "big" }, 413);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const c of (req.body ?? []) as unknown as AsyncIterable<Uint8Array>) {
    total += c.length;
    if (total > LIMITS.body) return reply(req, { error: TOO_BIG, code: "big" }, 413);
    chunks.push(c);
  }
  try {
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new IngestError("Send JSON: {url, title, html}.");
    }
    const { id, twin } = await ingest(validate(raw), new URL(req.url).origin);
    return reply(req, { id, counts: twin.counts, title: twin.source.title });
  } catch (e) {
    if (e instanceof IngestError) return reply(req, { error: e.message, code: e.code }, e.status);
    console.log(`[ingest] failed: ${(e as Error).name}`); // never the page's address or text
    return reply(req, { error: "Arc could not read that page." }, 500);
  }
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const img = q.get("img");
  if (img) {
    const pic = /^[0-9a-f]{16}\d{1,3}$/.test(img) ? vault.getImage(img) : null;
    if (!pic) return new Response("Gone.", { status: 404, headers: { "cache-control": "no-store" } });
    return new Response(new Uint8Array(pic.data), { headers: { "content-type": pic.type, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  }
  const id = req.headers.get("x-arc-doc") ?? q.get("id") ?? ""; // the header keeps the id out of request logs (Arc's page sends it so)
  const twin = /^[0-9a-f]{32}$/.test(id) ? vault.get(id) : null;
  return twin ? reply(req, twin) : reply(req, { error: "This page is no longer here. Send it again from your tab." }, 404);
}
