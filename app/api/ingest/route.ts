// POST {url, title?, html} from the Arc browser extension (extension/background.js): the page the student already has open,
// so nothing is fetched from the web. Only the parsed Twin is stored and served; the HTML itself is never kept or re-served.
// GET ?id= returns that Twin; components/Twin.tsx calls it for /?doc=<id>.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseHtml } from "@/lib/parse/html";
import { warmPage } from "@/lib/server/tourQueue";

export const runtime = "nodejs";

const MAX = 4 * 1024 * 1024;
// The caller is an extension or bookmarklet on another site: cross-origin is allowed for this route only.
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });
const file = (id: string) => `.cache/ingest/${id}.json`;

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: Request) {
  if (Number(req.headers.get("content-length") || 0) > MAX) return reply({ error: "That page is larger than 4 MB." }, 413);
  const raw = await req.text();
  if (Buffer.byteLength(raw) > MAX) return reply({ error: "That page is larger than 4 MB." }, 413);
  let body: { url?: unknown; title?: unknown; html?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return reply({ error: "Send JSON: {url, title, html}." }, 400);
  }
  const { url, title, html } = body;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url) || typeof html !== "string" || !html) return reply({ error: "Send JSON: {url, title, html}." }, 400);

  const safe = html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "").replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  const twin = parseHtml(safe, url);
  if (typeof title === "string" && title.trim() && twin.source.title === url) twin.source.title = title.trim().slice(0, 300);
  twin.source.via = "browser";
  const id = createHash("sha1").update(url + html.length + Date.now()).digest("hex").slice(0, 12);
  twin.id = `doc-${id}`;
  await mkdir(".cache/ingest", { recursive: true });
  await writeFile(file(id), JSON.stringify(twin));
  warmPage(twin.nodes.flatMap((n) => (n.kind === "figure" && n.image && !n.tour ? [n.image.url] : []))); // background figure tours
  return reply({ id, counts: twin.counts, title: twin.source.title });
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f]{12}$/.test(id)) return reply({ error: "Unknown page." }, 404);
  const saved = await readFile(file(id), "utf8").catch(() => null);
  return saved ? new Response(saved, { headers: { ...CORS, "content-type": "application/json" } }) : reply({ error: "Unknown page." }, 404);
}
