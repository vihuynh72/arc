// GET ?id= -> the stored PDF, for the browser to render figures from (components/PdfFigure.tsx). Takes byte ranges, so pdfjs
// fetches only the parts of a large book it needs. Ids are content hashes: the bytes never change, so they cache forever.
import { open, stat } from "@/lib/server/vault"; // private documents' files stay in memory (lib/server/vault.ts)

export const runtime = "nodejs";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[a-f0-9]{24}$/.test(id)) return new Response("No such PDF.", { status: 404 });
  const path = `.cache/pdf/${id}/file.pdf`;
  const size = (await stat(path).catch(() => null))?.size;
  if (!size) return new Response("No such PDF.", { status: 404 });
  const head = { "content-type": "application/pdf", "accept-ranges": "bytes", "cache-control": "private, max-age=31536000, immutable" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  const from = m ? (m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))) : 0;
  const to = m && m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
  if (from > to) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  const f = await open(path);
  try {
    const buf = Buffer.alloc(to - from + 1);
    await f.read(buf, 0, buf.length, from);
    return new Response(buf, { status: m ? 206 : 200, headers: { ...head, "content-length": String(buf.length), ...(m ? { "content-range": `bytes ${from}-${to}/${size}` } : {}) } });
  } finally {
    await f.close();
  }
}
