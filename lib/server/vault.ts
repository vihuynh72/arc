// Private documents (from the student's own signed-in browser, through the Arc helper) live here, in memory only, for about two
// hours after their last use. Nothing here is written to disk, logged, or listed.
// It is also a drop-in for the few fs/promises calls the shared caches make (lib/server/tour.ts, pdf.ts, pageQueue.ts and the PDF
// file and figure routes import readFile/writeFile/mkdir/stat/open from here): a path a private document has claimed (its PDF
// folder, its figures' tour files, its clean-up result) is kept in memory with the document; every other path is the real disk.
// So a private document's tours, PDF pages and clean-up results never reach .cache/, and they vanish with it.
// Callers: lib/server/ingest.ts (put, claim, images), lib/server/live.ts (isPrivateText). Checked by scripts/checks/ingest.ts.
import * as fs from "node:fs/promises";
import type { Twin } from "@/lib/types";

export const TTL_MS = Number(process.env.ARC_VAULT_TTL_MS) || 2 * 3600_000; // a private page or an upload lives this long after its last use
// All private documents and uploads together, in memory. Past it the least recently used documents go first (the student hears
// "this page is no longer here" and sends it again). 1 GB holds about forty 25 MB private PDFs or a few hundred pages with pictures.
const MAX_BYTES = () => (Number(process.env.ARC_VAULT_MB) || 1024) * 1024 * 1024;
type Doc = { twin: Twin; prefixes: string[]; text: string; touched: number; onExpire: (() => void)[] };
type Store = { docs: Map<string, Doc>; files: Map<string, { doc: string; data: Buffer }>; images: Map<string, { doc: string; type: string; data: Buffer }> };
const g = globalThis as unknown as { __arcVault?: Store };
const V: Store = (g.__arcVault ??= { docs: new Map(), files: new Map(), images: new Map() });
/** The clock, replaceable by the checks (expiry with injected time). */
export const clock = { now: () => Date.now() };

const norm = (p: string) => String(p).replace(/^\.\//, "");
const squash = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Drops every document unused for TTL_MS, with its files, pictures and queue entries. */
export function sweep() {
  const now = clock.now();
  for (const [id, d] of V.docs) if (now - d.touched > TTL_MS) drop(id);
}
export function drop(id: string) {
  const d = V.docs.get(id);
  if (!d) return;
  V.docs.delete(id);
  for (const [k, f] of V.files) if (f.doc === id) V.files.delete(k);
  for (const [k, i] of V.images) if (i.doc === id) V.images.delete(k);
  for (const fn of d.onExpire) {
    try {
      fn();
    } catch {
      // a queue that is gone already
    }
  }
}
const timer = setInterval(sweep, 10 * 60_000);
timer.unref?.();

/** Stores a private twin under its id (random, from lib/server/ingest.ts). */
export function put(id: string, twin: Twin, onExpire: (() => void)[] = []) {
  sweep();
  const text = squash([twin.source.title, ...twin.nodes.flatMap((n) => [n.heading, n.text, ...(n.blocks ?? []).flatMap((b) => [b.text, b.say ?? ""])])].join("\n"));
  const had = V.docs.get(id);
  V.docs.set(id, { twin, prefixes: had?.prefixes ?? [], text, touched: clock.now(), onExpire: [...(had?.onExpire ?? []), ...onExpire] });
}
/** Reserves paths for a document before anything writes them (it may not be put yet: a PDF claims its folder first). */
export function claim(id: string, prefix: string) {
  let d = V.docs.get(id);
  if (!d) V.docs.set(id, (d = { twin: null as unknown as Twin, prefixes: [], text: "", touched: clock.now(), onExpire: [] }));
  d.prefixes.push(norm(prefix));
}
/** The twin, and its life starts again. Null when it is gone. */
export function get(id: string): Twin | null {
  sweep();
  const d = V.docs.get(id);
  if (!d?.twin) return null;
  d.touched = clock.now();
  return d.twin;
}
export function putImage(doc: string, key: string, type: string, data: Buffer) {
  V.images.set(key, { doc, type, data });
  fit(doc);
}
/** Drops the least recently used documents (never `keep`) until everything held fits MAX_BYTES. */
function fit(keep: string) {
  let total = 0;
  for (const f of V.files.values()) total += f.data.length;
  for (const i of V.images.values()) total += i.data.length;
  if (total <= MAX_BYTES()) return;
  const size = (id: string) => [...V.files.values(), ...V.images.values()].reduce((n, x) => n + (x.doc === id ? x.data.length : 0), 0);
  for (const [id] of [...V.docs].sort((a, b) => a[1].touched - b[1].touched)) {
    if (total <= MAX_BYTES()) break;
    if (id === keep) continue;
    total -= size(id);
    drop(id);
  }
}
export function getImage(key: string): { type: string; data: Buffer } | null {
  sweep();
  const i = V.images.get(key);
  if (!i) return null;
  const d = V.docs.get(i.doc);
  if (d) d.touched = clock.now();
  return { type: i.type, data: i.data };
}
/** For the checks and the report: what is held now (counts only). */
export const held = () => ({ docs: V.docs.size, files: V.files.size, images: V.images.size });

/** True when the text (a line about to be cached as audio, or logged) comes from a private document that is still alive. */
export function isPrivateText(text: string): boolean {
  const t = squash(text ?? "");
  if (t.length < 8) return false;
  for (const d of V.docs.values()) if (d.text.includes(t)) return true;
  return false;
}

/** The private document that claimed this path, refreshed; undefined for an ordinary path. */
function owner(path: string): string | undefined {
  const p = norm(path);
  for (const [id, d] of V.docs) if (d.prefixes.some((x) => p.startsWith(x))) {
    d.touched = clock.now();
    return id;
  }
  return undefined;
}
const missing = (path: string) => Object.assign(new Error(`ENOENT: no such file, '${path}'`), { code: "ENOENT" });

// ---- the fs/promises subset the caches use ----
export function readFile(path: string): Promise<Buffer>;
export function readFile(path: string, enc: BufferEncoding): Promise<string>;
export async function readFile(path: string, enc?: BufferEncoding): Promise<Buffer | string> {
  if (!owner(path)) return enc ? fs.readFile(path, enc) : fs.readFile(path);
  const f = V.files.get(norm(path));
  if (!f) throw missing(path);
  return enc ? f.data.toString(enc) : f.data;
}
/** The private document a picture address belongs to: an ingest picture, or a figure cut from a private PDF. */
export function privateUrlDoc(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url, "http://x");
  } catch {
    return undefined;
  }
  if (u.pathname === "/api/ingest" && u.searchParams.get("img")) return V.images.get(u.searchParams.get("img")!)?.doc;
  if (u.pathname === "/api/pdf/figure" && u.searchParams.get("id")) return owner(`.cache/pdf/${u.searchParams.get("id")}/`);
  return undefined;
}

export async function writeFile(path: string, data: string | Uint8Array, opts?: Parameters<typeof fs.writeFile>[2]): Promise<void> {
  let doc = owner(path);
  // A tour is saved by the hash of its picture's address (lib/server/tour.ts); the tour names that address in `source`.
  if (!doc && /^\.cache\/tours\//.test(norm(path)) && typeof data === "string") {
    const src = /"source":"([^"]+)"/.exec(data)?.[1];
    doc = src ? privateUrlDoc(src) : undefined;
    if (doc) V.docs.get(doc)!.prefixes.push(norm(path));
  }
  if (!doc) return fs.writeFile(path, data, opts);
  if (typeof opts === "object" && opts && "flag" in opts && opts.flag === "wx" && V.files.has(norm(path))) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
  V.files.set(norm(path), { doc, data: Buffer.from(data) });
  fit(doc);
}
export async function appendFile(path: string, data: string): Promise<void> {
  if (!owner(path)) return fs.appendFile(path, data);
  const had = V.files.get(norm(path));
  await writeFile(path, Buffer.concat([had?.data ?? Buffer.alloc(0), Buffer.from(data)]));
}
export async function mkdir(path: string, opts?: Parameters<typeof fs.mkdir>[1]): Promise<string | undefined> {
  if (owner(path)) return undefined;
  return fs.mkdir(path, opts);
}
export async function stat(path: string): Promise<{ size: number }> {
  if (!owner(path)) return fs.stat(path);
  const f = V.files.get(norm(path));
  if (!f) throw missing(path);
  return { size: f.data.length };
}
/** Enough of a FileHandle for app/api/pdf/file (positioned reads). */
export async function open(path: string): Promise<{ read: (buf: Buffer, off: number, len: number, pos: number) => Promise<unknown>; close: () => Promise<void> }> {
  if (!owner(path)) return fs.open(path);
  const f = V.files.get(norm(path));
  if (!f) throw missing(path);
  return {
    read: async (buf, off, len, pos) => f.data.copy(buf, off, pos, pos + len),
    close: async () => {},
  };
}
