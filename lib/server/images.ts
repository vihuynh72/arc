// Figure images that the student's browser cannot load directly (hotlink protection, a challenge, a referrer rule) are served
// through GET /api/image?u=<url> (app/api/image/route.ts). Callers: app/api/load/route.ts (probeFigures after a page is parsed)
// and the image route (fetchImage). Checked by scripts/checks/images.ts (the address guard, offline).
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Twin } from "@/lib/types";
import { unlockBytes } from "@/lib/server/brightdata";
import { checkUrl, safeFetch } from "@/lib/server/safeFetch";

export { privateAddress } from "@/lib/server/safeFetch";
export const publicUrl = async (raw: string) => {
  const c = await checkUrl(raw);
  return c.ok ? c.url : null;
};

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_BYTES = 15 * 1024 * 1024;
const PROBE_MS = 2500; // the whole probe step; a figure not answered in time keeps its direct address
const MAX_PROBES = 30;
const PROXY_MS = 4000; // the whole step when some figures need the route; pages whose figures load directly take about PROBE_MS at most

/** Image type from the first bytes; null when the bytes are not an image a browser shows. */
export function sniff(b: Uint8Array): string | null {
  const s = (i: number, n: number) => String.fromCharCode(...b.slice(i, i + n));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (s(0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (s(0, 4) === "GIF8") return "image/gif";
  if (s(0, 4) === "RIFF" && s(8, 4) === "WEBP") return "image/webp";
  if (s(4, 4) === "ftyp" && /avif|avis/.test(s(8, 4))) return "image/avif";
  if (s(0, 2) === "BM") return "image/bmp";
  const head = Buffer.from(b.slice(0, 1024)).toString("utf8").replace(/^\ufeff/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

async function readCapped(res: Response): Promise<Uint8Array | null> {
  if (Number(res.headers.get("content-length") || 0) > MAX_BYTES) return null;
  const reader = res.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

/** GET through the shared guard (lib/server/safeFetch.ts): every hop checked, the connection pinned to the checked address. */
const guardedGet = (url: string, signal: AbortSignal) =>
  safeFetch(url, { headers: { "user-agent": UA, accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" }, signal }).catch(() => null);

const file = (url: string) => `.cache/images/${createHash("sha1").update(url).digest("hex")}`;

/** The image bytes and type: from .cache/images, else a direct fetch, else the Web Unlocker. Null when it is not a reachable image. */
export async function fetchImage(url: string): Promise<{ body: Uint8Array; type: string; via: string } | null> {
  if (!(await publicUrl(url))) return null;
  const f = file(url);
  const hit = await readFile(f + ".bin").catch(() => null);
  const meta = hit && (await readFile(f + ".json", "utf8").then(JSON.parse, () => null));
  if (hit && meta?.type) return { body: hit, type: meta.type, via: "cache" };
  let body: Uint8Array | null = null;
  let via = "direct";
  const res = await guardedGet(url, AbortSignal.timeout(10_000)).catch(() => null);
  if (res?.ok) body = await readCapped(res).catch(() => null);
  else await res?.body?.cancel().catch(() => {});
  if (!body || !sniff(body)) {
    via = "unlocker";
    body = await unlockBytes(url, { signal: AbortSignal.timeout(20_000), max: MAX_BYTES }).catch(() => null);
  }
  const type = body && sniff(body);
  if (!body || !type) return null;
  await mkdir(".cache/images", { recursive: true });
  await writeFile(f + ".bin", body);
  await writeFile(f + ".json", JSON.stringify({ type, url, via }));
  return { body, type, via };
}

// Per image address: does a plain browser-like request without a referrer get an image back? Remembered for the process.
const seen = ((globalThis as unknown as { __arcImgOk?: Map<string, boolean> }).__arcImgOk ??= new Map());

async function loadsDirect(url: string, signal: AbortSignal): Promise<boolean> {
  if (seen.has(url)) return seen.get(url)!;
  const res = await guardedGet(url, signal).catch(() => null);
  if (!res) return false;
  let ok = false;
  if (res.ok) {
    const reader = res.body?.getReader();
    const first = reader ? await reader.read().catch(() => null) : null;
    await reader?.cancel().catch(() => {});
    ok = !!first?.value && !!sniff(first.value);
  } else await res.body?.cancel().catch(() => {});
  seen.set(url, ok);
  return ok;
}

/** Points each figure that does not load directly at the image route (an absolute address on `origin`, so tours can fetch it too),
 * but only when the route has actually got the picture (direct or Unlocker; it is then cached and served at once). Figures that
 * load directly, or that neither way could fetch in time, keep their own address: the student's browser may still load them. */
export async function probeFigures(twin: Twin, origin: string): Promise<{ probed: number; proxied: number; ms: number }> {
  const t = Date.now();
  const figs = twin.nodes.filter((n) => n.kind === "figure" && n.image && /^https?:\/\//i.test(n.image.url) && !n.image.url.startsWith(origin)).slice(0, MAX_PROBES);
  if (!figs.length) return { probed: 0, proxied: 0, ms: 0 };
  const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<null>((r) => setTimeout(r, Math.max(0, ms), null))]);
  const signal = AbortSignal.timeout(PROBE_MS);
  let proxied = 0;
  await Promise.all(
    figs.map(async (n) => {
      const url = n.image!.url;
      if ((await within(loadsDirect(url, signal), PROBE_MS)) !== false) return; // loads, or no answer in time: left as is
      const got = await within(fetchImage(url).catch(() => null), PROXY_MS - (Date.now() - t));
      if (!got) return;
      n.image!.url = `${origin}/api/image?u=${encodeURIComponent(url)}`;
      proxied++;
    }),
  );
  return { probed: figs.length, proxied, ms: Date.now() - t };
}
