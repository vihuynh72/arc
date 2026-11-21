// POST the PDF itself as the raw body (?name=file.pdf for its title) -> a twin with pages 1 and 2, like /api/load for a link.
// The file is held in memory under a random id (lib/server/pdf.ts uploadTwin: never on disk, gone about two hours after its last
// use) and sent nowhere but Gemini (one page at a time, only when needed).
import { MAX_BYTES, PdfError, uploadTwin } from "@/lib/server/pdf";

export const runtime = "nodejs";

const BIG = "This PDF is larger than 60 megabytes, which is more than Arc can read.";

export async function POST(req: Request) {
  if (Number(req.headers.get("content-length") || 0) > MAX_BYTES) return Response.json({ error: BIG }, { status: 413 });
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const c of (req.body ?? []) as unknown as AsyncIterable<Uint8Array>) {
    total += c.length;
    if (total > MAX_BYTES) return Response.json({ error: BIG }, { status: 413 });
    chunks.push(c);
  }
  if (!total) return Response.json({ error: "No file arrived. Send the PDF as the request body." }, { status: 400 });
  const name = new URL(req.url).searchParams.get("name")?.replace(/\.pdf$/i, "").slice(0, 200) || undefined;
  try {
    return Response.json(await uploadTwin(Buffer.concat(chunks), name, new URL(req.url).origin));
  } catch (e) {
    if (e instanceof PdfError) return Response.json({ error: e.message }, { status: 400 });
    console.log(`[pdf] upload failed: ${(e as Error).message}`);
    return Response.json({ error: "Arc could not read this PDF." }, { status: 500 });
  }
}
