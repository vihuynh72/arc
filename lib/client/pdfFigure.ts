"use client";
// Cuts a PDF figure out of its page in the browser (the server has no canvas). pdfjs-dist loads only when a PDF figure first
// needs drawing; one document per PDF is kept (the stored file at /api/pdf/file, fetched by byte ranges); one render runs at a
// time and its canvas is freed at once. Used by components/PdfFigure.tsx.
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { Box } from "@/lib/types";

let lib: Promise<typeof import("pdfjs-dist")> | null = null;
const pdfjs = () =>
  (lib ??= import("pdfjs-dist").then((m) => {
    m.GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), { type: "module" });
    return m;
  }));

type Task = { promise: Promise<PDFDocumentProxy>; destroy: () => Promise<void> };
let open: { id: string; task: Promise<Task> } | null = null;
function docFor(id: string) {
  if (open?.id !== id) {
    void open?.task.then((t) => t.destroy()).catch(() => {}); // another PDF was open: let it go
    open = { id, task: pdfjs().then((m) => m.getDocument({ url: `/api/pdf/file?id=${id}`, disableAutoFetch: true, disableStream: true })) };
  }
  return open.task.then((t) => t.promise);
}

let chain: Promise<unknown> = Promise.resolve();
const MARGIN = 3; // in 0..1000 page units, about 2 points: edge strokes stay in; more reaches the caption line below
const MAX_PX = 2400;

/** The box of page `page` as a PNG about 2x the shown width in device pixels (capped). An equation is cut exactly at its (already
 * padded and checked) box and as sharp as the cap allows, because it is shown at whatever text size the student chose. */
export function renderFigure(id: string, page: number, box: Box, cssWidth: number, eq = false): Promise<Blob> {
  const run = chain.then(async () => {
    const p = await (await docFor(id)).getPage(page);
    try {
      const base = p.getViewport({ scale: 1 });
      const m = eq ? 0 : MARGIN;
      const [y0, x0, y1, x1] = [Math.max(0, box[0] - m), Math.max(0, box[1] - m), Math.min(1000, box[2] + m), Math.min(1000, box[3] + m)];
      const w = (base.width * (x1 - x0)) / 1000, h = (base.height * (y1 - y0)) / 1000;
      const want = eq ? MAX_PX : Math.min(MAX_PX, Math.max(800, cssWidth * (window.devicePixelRatio || 1) * 2));
      const scale = Math.min(want / w, MAX_PX / h, 8);
      const viewport = p.getViewport({ scale, offsetX: (-base.width * scale * x0) / 1000, offsetY: (-base.height * scale * y0) / 1000 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      await p.render({ canvas, viewport, background: "#ffffff" }).promise;
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      canvas.width = canvas.height = 0; // free the pixels now, not at the next collection
      if (!blob) throw new Error("no image");
      return blob;
    } finally {
      p.cleanup();
    }
  });
  chain = run.catch(() => {});
  return run;
}

export type FigureMeta = { box_2d: Box; page: number; label: string; url: string; stored: boolean; eq?: boolean };

/** The node's image URL is the stored picture's: /api/pdf/figure?id=&node=&box=. An equation's adds &as=equation and &size=WxH (points). */
export const figureRef = (url: string) => {
  const q = new URL(url, location.href).searchParams;
  const [w, h] = (q.get("size") ?? "").split("x").map(Number);
  return { id: q.get("id") ?? "", node: q.get("node") ?? "", eq: q.get("as") === "equation", size: w > 0 && h > 0 ? ([w, h] as [number, number]) : null };
};

/** The figure's picture URL for its current box, drawn and stored here first if the server has none. */
export async function ensureFigure(url: string, cssWidth: number): Promise<string> {
  const { id, node, eq } = figureRef(url);
  const meta = await fetch(`/api/pdf/figure?id=${id}&node=${node}&meta=1${eq ? "&as=equation" : ""}`).then((r) => (r.ok ? (r.json() as Promise<FigureMeta>) : null));
  if (!meta) throw new Error("no box");
  if (meta.stored) return meta.url;
  const png = await renderFigure(id, meta.page, meta.box_2d, cssWidth, eq);
  const r = await fetch(meta.url, { method: "POST", headers: { "content-type": "image/png" }, body: png });
  if (!r.ok) throw new Error(`store failed ${r.status}`);
  return meta.url;
}
