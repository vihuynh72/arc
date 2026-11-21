// Keeps the disk caches that grow with use under a size each, oldest access first. Run by server.ts at start and hourly.
// Each top-level entry of a folder is one unit (a file, or a PDF's whole folder); its last use is the newest access or change
// time of anything in it. Only the folders below, under the working folder's .cache: never anything else.
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const dev = process.env.NODE_ENV !== "production";
// Caps in MB (ARC_CACHE_MB_<NAME>). Hosted: sized for a small disk. Development: ten times that, so a laptop keeps its demo
// pages, tours and voice lines, but there is still a cap.
const mb = (name: string, hosted: number) => (Number(process.env[`ARC_CACHE_MB_${name}`]) || hosted * (dev ? 10 : 1)) * 1024 * 1024;
export const caps = () => ({
  pdf: mb("PDF", 1000), // public PDFs by link, their pages and figure crops
  images: mb("IMAGES", 500), // figures fetched through /api/image
  tours: mb("TOURS", 100), // tour JSON (a few KB each)
  audio: mb("AUDIO", 500), // read-aloud audio in the Live voice (about 50 KB a line)
});
const HOUR = 3600_000;

type Unit = { p: string; bytes: number; used: number };
async function measure(p: string): Promise<Unit> {
  const s = await stat(p);
  if (!s.isDirectory()) return { p, bytes: s.size, used: Math.max(s.atimeMs, s.mtimeMs) };
  let bytes = 0, used = s.mtimeMs;
  for (const e of await readdir(p).catch(() => [])) {
    const u = await measure(path.join(p, e)).catch(() => null);
    if (u) (bytes += u.bytes), (used = Math.max(used, u.used));
  }
  return { p, bytes, used };
}

/** Trims one folder to `cap` bytes, least recently used entries first. Returns what was removed. */
export async function trim(dir: string, cap: number): Promise<{ removed: string[]; bytes: number }> {
  const units = (await Promise.all((await readdir(dir).catch(() => [])).map((e) => measure(path.join(dir, e)).catch(() => null)))).filter((u): u is Unit => !!u);
  let total = units.reduce((n, u) => n + u.bytes, 0);
  const removed: string[] = [];
  for (const u of units.sort((a, b) => a.used - b.used)) {
    if (total <= cap) break;
    await rm(u.p, { recursive: true, force: true });
    total -= u.bytes;
    removed.push(path.basename(u.p));
  }
  return { removed, bytes: total };
}

/** One pass over every capped folder of `root` (the working folder's .cache by default). */
export async function sweep(root = ".cache") {
  for (const [name, cap] of Object.entries(caps())) {
    const r = await trim(path.join(root, name), cap).catch(() => ({ removed: [], bytes: 0 }));
    if (r.removed.length) console.log(`[janitor] .cache/${name}: removed ${r.removed.length} oldest entries, ${(r.bytes / 1048576).toFixed(1)} MB left of ${(cap / 1048576).toFixed(1)}`);
  }
}

export function startJanitor() {
  void sweep();
  setInterval(() => void sweep(), HOUR).unref();
}
