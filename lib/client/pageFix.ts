"use client";
// The background clean-up of a web page (server: lib/server/pageQueue.ts, GET /api/page/blocks). After a page twin loads, the server's
// model pass names leftover page furniture to drop and gives spoken forms for equations and tables. This polls for it and applies it
// by block id, never under the cursor: the block the cursor is on is not dropped until the cursor leaves it, and a block that is being
// spoken keeps its words until it has finished. Nothing scrolls (the stop under the cursor stays where it is on the screen), nothing
// is read again, and ids never change, so the cursor does not jump (components/Reader.tsx follows its block by id). Used by components/Twin.tsx.
import { useEffect, type Dispatch, type SetStateAction } from "react";
import { speaker } from "@/lib/client/reader";
import type { Block, Twin, TwinNode } from "@/lib/types";

export type BlockFix = { done: boolean; drop: string[]; say: Record<string, string> };

const POLL_MS = 2500;
const GIVE_UP_MS = 60_000;

/** `nodes` with the fix applied. `held`: the block under the cursor (kept even if dropped). `speaking`: the block being spoken (its spoken form waits).
 * Same array back when nothing changed. A section keeps `text` equal to its blocks' text, as the parser made it. */
export function applyFix(nodes: TwinNode[], fix: Pick<BlockFix, "drop" | "say">, held = "", speaking = ""): TwinNode[] {
  const drop = new Set(fix.drop);
  let changed = false;
  const out = nodes.map((n) => {
    if (n.kind !== "section" || !n.blocks?.length) return n;
    const blocks: Block[] = [];
    let dropped = false;
    let said = false;
    for (const b of n.blocks) {
      if (drop.has(b.id) && b.id !== held) {
        dropped = true;
        continue;
      }
      const say = fix.say[b.id];
      if (say && say !== b.say && b.id !== speaking) {
        said = true;
        blocks.push({ ...b, say });
      } else blocks.push(b);
    }
    if (!dropped && !said) return n;
    changed = true;
    return { ...n, blocks, ...(dropped && { text: blocks.map((b) => b.text).join("\n\n") }) };
  });
  return changed ? out : nodes;
}

/** Polls /api/page/blocks for a web page twin until the server says it is done (or about a minute), and applies what arrives. */
export function usePageFix(twin: Twin | null, setTwin: Dispatch<SetStateAction<Twin | null>>) {
  const id = twin?.source.kind === "page" ? twin.id : "";
  useEffect(() => {
    if (!id) return;
    let live = true;
    let fix: BlockFix = { done: false, drop: [], say: {} };
    let timer = 0;
    const started = Date.now();
    // What is under the cursor now: its block id, and whether the voice is on it.
    const cursor = () => {
      const held = document.querySelector<HTMLElement>('#content [aria-current="true"][data-block-id]')?.dataset.blockId ?? "";
      return { held, speaking: held && speaker.busy ? held : "" };
    };
    const flush = () => {
      if (!live || (!fix.drop.length && !Object.keys(fix.say).length)) return;
      const { held, speaking } = cursor();
      const mark = document.querySelector('[aria-current="true"]');
      const top = mark?.getBoundingClientRect().top;
      let changed = false;
      setTwin((t) => {
        if (!t || t.id !== id) return t;
        const nodes = applyFix(t.nodes, fix, held, speaking);
        changed = nodes !== t.nodes;
        return changed ? { ...t, nodes } : t;
      });
      // Whatever was removed above the cursor, it stays where it is on the screen.
      if (mark && top != null)
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const d = mark.isConnected ? mark.getBoundingClientRect().top - top : 0;
            if (changed && Math.abs(d) > 2) window.scrollBy({ top: d, behavior: "instant" });
          }),
        );
    };
    const poll = async () => {
      try {
        const r = await fetch(`/api/page/blocks?id=${encodeURIComponent(id)}`, { cache: "no-store" });
        if (r.ok && live) fix = (await r.json()) as BlockFix;
      } catch {
        // offline: the page keeps the code's reading
      }
      if (!live) return;
      flush();
      if (!fix.done && Date.now() - started < GIVE_UP_MS) timer = window.setTimeout(poll, POLL_MS);
    };
    timer = window.setTimeout(poll, 1000);
    // A held block lets go once the cursor leaves it; a spoken one once it has finished.
    const again = window.setInterval(flush, 700);
    window.addEventListener("arc:block", flush);
    window.addEventListener("arc:cursor", flush);
    return () => {
      live = false;
      clearTimeout(timer);
      clearInterval(again);
      window.removeEventListener("arc:block", flush);
      window.removeEventListener("arc:cursor", flush);
    };
  }, [id, setTwin]);
}
