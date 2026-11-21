// GET ?id=&n= -> { page, pages, stage, nodes, figures } (figures: node id -> {box_2d, page, label}; a boxed figure node has image): the best nodes for page n now ("quick" means a better version can come).
// POST {id, n}: the student is at page n; n and n+1 go to the front of the model queue if they need it. Same reply as GET.
import { pdfPage, PdfError, touch } from "@/lib/server/pdf";

export const runtime = "nodejs";

const fail = (e: unknown) =>
  e instanceof PdfError ? Response.json({ error: e.message }, { status: 400 }) : Response.json({ error: "Arc could not read this page of the PDF." }, { status: 500 });

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  return pdfPage(q.get("id") ?? "", Number(q.get("n")), new URL(req.url).origin).then((r) => Response.json(r), fail);
}

export async function POST(req: Request) {
  const { id, n } = (await req.json().catch(() => ({}))) as { id?: string; n?: number };
  try {
    const page = await pdfPage(id ?? "", Number(n), new URL(req.url).origin); // validates id and n before anything is queued
    await touch(id!, page.page);
    return Response.json(page);
  } catch (e) {
    return fail(e);
  }
}
