// The reading cursor's stops inside a section: the section's own blocks if the parser made them, else its text cut at blank lines.
// Pure; used by components/Reader.tsx and components/twin/Nodes.tsx. Only sections have blocks: a figure or a video part is one stop.
import type { Block, TwinNode } from "./types";

// PDF nodes (they carry a page) are cut by the server one heading or one paragraph, equation or table at a time:
// a heading is a stop with no blocks, and anything else is a stop that is only its text (its `heading` is just the section it sits under).
export const isText = (n: Pick<TwinNode, "kind" | "level" | "page">) => n.page != null && n.kind === "section" && !n.level;

export function blocksOf(n: Pick<TwinNode, "id" | "kind" | "text" | "blocks"> & Partial<Pick<TwinNode, "level" | "page">>): Block[] {
  if (n.kind !== "section" || (n.page != null && n.level)) return [];
  if (n.blocks?.length) return n.blocks;
  return (n.text ?? "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((text, i) => ({ id: `${n.id}.b${String(i + 1).padStart(2, "0")}`, kind: "paragraph" as const, text }));
}
