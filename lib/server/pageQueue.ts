// Background clean-up of a web twin, after it is served: one model pass per node that code flagged (lib/parse/html.ts troublesOf):
// equations code could not voice, tables too complex to voice, link-dense leftovers, headings that look like furniture.
// The model returns, over the block ids code produced, only drop/keep and spoken forms; code applies them (unknown ids dropped,
// nothing reordered or added). Callers: app/api/load/route.ts (warmBlocks, never awaited) and app/api/page/blocks (status).
// State on globalThis (one long-lived process); results also on disk under .cache/blocks so a reload costs no call.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "@/lib/server/vault"; // private documents' files stay in memory (lib/server/vault.ts)
import { troublesOf, type Trouble } from "@/lib/parse/html";
import { allowExtras, isBudgetError } from "@/lib/server/budget";
import { generateJson, type Part } from "@/lib/server/gemini";
import { fetchImage } from "@/lib/server/images";
import { GEMINI_STRUCTURE_MODEL } from "@/lib/models";
import type { Twin } from "@/lib/types";

export type BlockFix = { done: boolean; drop: string[]; say: Record<string, string> };
type Page = BlockFix & { started: number };
type State = { pages: Map<string, Page>; calls: number[]; chain: Promise<unknown>; log: string[] };
const g = globalThis as unknown as { __arcBlocks?: State };
const S: State = (g.__arcBlocks ??= { pages: new Map(), calls: [], chain: Promise.resolve(), log: [] });
const PER_PAGE = 3; // flagged nodes per page sent to the model; the rest keep code's reading
const PER_HOUR = 30; // a ceiling on model calls, whatever pages are opened

const SCHEMA = {
  type: "OBJECT",
  properties: {
    drop: { type: "ARRAY", items: { type: "STRING" } },
    say: { type: "ARRAY", items: { type: "OBJECT", properties: { id: { type: "STRING" }, say: { type: "STRING" } }, required: ["id", "say"] } },
  },
  required: ["drop", "say"],
};

const PROMPT = `You clean up one section of a web page that is read aloud, block by block, to a blind student.
You get the page title, the section heading, why code flagged it, and the section's blocks as JSON lines with an id.
Answer with:
- drop: ids of blocks that are website furniture and not part of the article (menus, tabs, share, cite, metrics or download links, sign-in prompts, adverts, cookie notices). Keep every block that is part of the article.
- say: for equation and table blocks, and paragraphs whose formulas are pictures, the words a listener should hear. Read math in plain words ("x equals the fraction negative b plus or minus the square root of b squared minus 4 a c, over 2 a"). Read a table as "Table with R rows and C columns" then each row as "header: value, header: value", at most 12 rows. Use only what the block and any attached picture show; never add facts.
Use only ids from the list. Plain words, no markdown.`;

const fileOf = (twin: Twin, notes: Trouble[]) =>
  `.cache/blocks/${twin.id}-${createHash("sha1").update(JSON.stringify(notes.map((n) => [n.node, n.why, n.blocks]))).digest("hex").slice(0, 10)}.json`;

/** Status for app/api/page/blocks: done when every flagged node has been handled (or none was flagged). */
export function blockFix(id: string): BlockFix {
  const p = S.pages.get(id);
  return p ? { done: p.done, drop: p.drop, say: p.say } : { done: true, drop: [], say: {} };
}

/** For checks and the report: one line per model call. */
export const blockCalls = () => [...S.log];

async function one(twin: Twin, note: Trouble): Promise<{ drop: string[]; say: Record<string, string> }> {
  const node = twin.nodes.find((n) => n.id === note.node);
  if (!node?.blocks) return { drop: [], say: {} };
  const known = new Map(node.blocks.map((b) => [b.id, b]));
  const lines = node.blocks.slice(0, 40).map((b) => JSON.stringify({ id: b.id, kind: b.kind, text: b.text.slice(0, 700), ...(b.say ? { say: b.say.slice(0, 400) } : {}) }));
  const parts: Part[] = [{ text: `${PROMPT}\n\nPage: ${twin.source.title}\nSection: ${node.heading}\nFlagged: ${note.why} (blocks ${note.blocks.join(", ")})\n\n${lines.join("\n")}` }];
  for (const [id, url] of Object.entries(note.images ?? {}).slice(0, 3)) {
    const img = await fetchImage(url).catch(() => null);
    if (img && img.type !== "image/svg+xml") parts.push({ text: `Picture for ${id}:` }, { inlineData: { mimeType: img.type, data: Buffer.from(img.body).toString("base64") } });
  }
  const t = Date.now();
  S.calls.push(t);
  const out = await generateJson<{ drop?: string[]; say?: { id: string; say: string }[] }>(parts, SCHEMA, { model: GEMINI_STRUCTURE_MODEL, timeoutMs: 45_000, feature: "page-cleanup" });
  // Code applies the answer: known ids only; spoken forms only for blocks that need one; never a reorder or a new block.
  const drop = (out.drop ?? []).filter((id) => known.has(id) && (note.why === "links" || note.why === "furniture"));
  const say: Record<string, string> = {};
  for (const s of out.say ?? []) {
    const b = known.get(s.id);
    if (b && (b.kind === "equation" || b.kind === "table" || note.blocks.includes(s.id)) && typeof s.say === "string" && s.say.trim()) say[s.id] = s.say.trim().slice(0, 1500);
  }
  S.log.push(`${twin.id} ${note.node} ${note.why}: ${Date.now() - t} ms, drop ${drop.length}, say ${Object.keys(say).length}`);
  console.log(`[blocks] ${S.log[S.log.length - 1]}`);
  return { drop, say };
}

/** Queue the page's flagged nodes (returns at once). Most pages have none and cost nothing. */
export function warmBlocks(twin: Twin) {
  // An extra (the structure model is a heavy one): skipped on a lean day, and code's reading stands.
  const notes = allowExtras() ? troublesOf(twin).slice(0, PER_PAGE) : [];
  if (!notes.length) return void S.pages.set(twin.id, { done: true, drop: [], say: {}, started: Date.now() });
  const have = S.pages.get(twin.id);
  if (have && (!have.done || Date.now() - have.started < 10 * 60_000)) return;
  const page: Page = { done: false, drop: [], say: {}, started: Date.now() };
  S.pages.set(twin.id, page);
  const f = fileOf(twin, notes);
  S.chain = S.chain.then(async () => {
    const saved = await readFile(f, "utf8").then((s) => JSON.parse(s) as BlockFix, () => null);
    if (saved) return void Object.assign(page, saved, { done: true });
    for (const note of notes) {
      const hour = Date.now() - 3600_000;
      if (S.calls.filter((c) => c > hour).length >= PER_HOUR) break;
      try {
        const r = await one(twin, note);
        page.drop.push(...r.drop);
        Object.assign(page.say, r.say);
      } catch (e) {
        if (isBudgetError(e)) break;
        console.log(`[blocks] ${twin.id} ${note.node} failed: ${(e as Error).message.slice(0, 120)}`);
      }
    }
    page.done = true;
    await mkdir(".cache/blocks", { recursive: true });
    await writeFile(f, JSON.stringify({ done: true, drop: page.drop, say: page.say }));
  }).catch(() => {
    page.done = true;
  });
}
