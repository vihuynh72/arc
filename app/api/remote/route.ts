// POST {url, target} -> screenshot of the real page (Bright Data Browser API) scrolled to the target, with its box. Read-only.
// Also {url, figure} (the per-figure button) and {url, warm: true} (open the session early).
import { remoteGo, remoteShot, remoteWarm, Superseded, type RemoteTarget } from "@/lib/server/remote";

export const runtime = "nodejs";
export const maxDuration = 120;

const bad = (error: string) => Response.json({ error }, { status: 400 });

function parseTarget(t: unknown): RemoteTarget | null {
  const o = (t ?? {}) as { kind?: unknown; n?: unknown; text?: unknown };
  if (o.kind === "top") return { kind: "top" };
  if (o.kind === "figure" && Number.isInteger(o.n) && (o.n as number) >= 1) return { kind: "figure", n: o.n as number };
  if (o.kind === "heading" && typeof o.text === "string" && o.text.length <= 300) return { kind: "heading", text: o.text };
  return null;
}

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { url?: string; figure?: number; target?: unknown; warm?: boolean };
  if (!b.url || !/^https?:\/\//.test(b.url)) return bad("Send a page address.");
  try {
    if (/(^|\.)quizlet\.com$/.test(new URL(b.url).hostname)) return bad("That site does not allow this.");
  } catch {
    return bad("Send a page address.");
  }
  try {
    if (b.warm) {
      const t0 = Date.now();
      await remoteWarm(b.url);
      return Response.json({ ok: true, ms: Date.now() - t0 });
    }
    if (b.target !== undefined) {
      const target = parseTarget(b.target);
      return target ? Response.json(await remoteGo(b.url, target)) : bad("Send a target: figure, heading or top.");
    }
    if (Number.isInteger(b.figure) && b.figure! >= 1) return Response.json(await remoteShot(b.url, b.figure!));
    return bad("Send a target or a figure number.");
  } catch (e) {
    if (e instanceof Superseded) return Response.json({ error: "superseded" }, { status: 409 });
    console.error("remote view failed:", e instanceof Error ? e.message.split("\n")[0] : e);
    return Response.json({ error: "The live page did not answer in time." }, { status: 502 });
  }
}
