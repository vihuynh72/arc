// A PDF figure's picture. The server cannot draw PDF pages (no canvas); the browser does (components/PdfFigure.tsx) and stores
// the cut-out here once, so tours (lib/server/tour.ts fetches this URL) and later visits use it. The box is part of the URL and
// the file name, so a figure whose box changes (a model pass, a newer parser) is drawn again rather than shown stale.
// An equation's picture (a formula cut out of the page; the node stays an equation) is stored the same way: add &as=equation to every
// call. Its file name carries "eq-", so it cannot be taken for a figure's.
// GET ?id=&node=&box= -> the stored PNG, 404 until stored.
// GET ?id=&node=&meta=1 -> { box_2d, page, label, url, stored, eq } for the figure's current box, or 404 (no box yet).
// POST ?id=&node=&box= with the PNG as the body -> 204 (409 when the box is not the figure's current one). Only a box the server
// itself reported for that document, a real PNG of sane size, and the first write wins: a stored picture is never replaced
// (another visitor cannot swap what a tour or a student sees).
import { mkdir, readFile, stat, writeFile } from "@/lib/server/vault"; // private documents' files stay in memory (lib/server/vault.ts)
import { equationUrl, figureUrl, pdfPage } from "@/lib/server/pdf";

export const runtime = "nodejs";

const MAX = 8 * 1024 * 1024;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_SIDE = 8000; // pixels: a page drawn at four times its size is about 3,300 wide
/** A PNG's width and height from its header (IHDR), or null when it has none. */
const pngSize = (b: Uint8Array) =>
  b.length > 24 && PNG.every((x, i) => b[i] === x) && String.fromCharCode(...b.subarray(12, 16)) === "IHDR" ? { w: Buffer.from(b).readUInt32BE(16), h: Buffer.from(b).readUInt32BE(20) } : null;
const file = (id: string, node: string, box: number[], eq: boolean) => `.cache/pdf/${id}/figures/${node}-${eq ? "eq-" : ""}${box.join("_")}.png`;
const args = (req: Request) => {
  const q = new URL(req.url).searchParams;
  const id = q.get("id") ?? "", node = q.get("node") ?? "";
  const box = (q.get("box") ?? "").split(",").map(Number);
  if (!/^[a-f0-9]{24}$/.test(id) || !/^p\d{3,4}-[nf]\d{2}$/.test(node)) return null;
  return { id, node, eq: q.get("as") === "equation", meta: q.has("meta"), box: box.length === 4 && box.every((v) => Number.isInteger(v) && v >= 0 && v <= 1000) ? box : null };
};
const current = async (id: string, node: string, eq: boolean) => {
  const p = await pdfPage(id, Number(/^p(\d+)/.exec(node)![1])).catch(() => null);
  return (eq ? p?.equations : p?.figures)?.[node];
};

export async function GET(req: Request) {
  const a = args(req);
  if (!a) return Response.json({ error: "No such figure." }, { status: 404 });
  if (a.meta) {
    const f = await current(a.id, a.node, a.eq);
    if (!f) return Response.json({ error: "No picture for this figure yet." }, { status: 404 });
    const stored = !!(await stat(file(a.id, a.node, f.box_2d, a.eq)).catch(() => null));
    return Response.json({ ...f, url: a.eq ? equationUrl(a.id, a.node, f.box_2d) : figureUrl("", a.id, a.node, f.box_2d), stored, eq: a.eq });
  }
  const png = a.box && (await readFile(file(a.id, a.node, a.box, a.eq)).catch(() => null));
  if (!png) return Response.json({ error: "This figure has not been drawn yet." }, { status: 404 });
  return new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": "private, max-age=31536000, immutable" } });
}

export async function POST(req: Request) {
  const a = args(req);
  if (!a?.box) return Response.json({ error: "No such figure." }, { status: 404 });
  if (Number(req.headers.get("content-length") || 0) > MAX) return Response.json({ error: "That picture is too large." }, { status: 413 });
  const body = new Uint8Array(await req.arrayBuffer());
  const px = pngSize(body);
  if (body.length > MAX || !px || px.w < 1 || px.h < 1 || px.w > MAX_SIDE || px.h > MAX_SIDE) return Response.json({ error: "Send the figure as a PNG." }, { status: 400 });
  const f = await current(a.id, a.node, a.eq);
  if (!f) return Response.json({ error: "No such figure." }, { status: 404 });
  if (f.box_2d.join() !== a.box.join()) return Response.json({ error: "This figure's box has changed." }, { status: 409 });
  await mkdir(`.cache/pdf/${a.id}/figures`, { recursive: true });
  await writeFile(file(a.id, a.node, a.box, a.eq), body, { flag: "wx" }).catch((e) => {
    if ((e as { code?: string }).code !== "EEXIST") throw e; // already stored: the first picture stays
  });
  return new Response(null, { status: 204 });
}
