// Browser side of the decision step: ask /api/decide, and dispatch an "arc:command" only when Arc is sure.
import type { Decision, Item } from "@/lib/server/decide";

export type { Decision };

export async function decideAndDispatch(utterance: string, items: Item[], inTour = false): Promise<Decision> {
  const res = await fetch("/api/decide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ utterance, items, inTour }),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Decision failed.");
  const d = (await res.json()) as Decision;
  if (d.act) {
    const label = items.find((i) => i.id === d.target)?.label;
    const send = (name: string, args: object) => window.dispatchEvent(new CustomEvent("arc:command", { detail: { name, args } }));
    if (d.action === "goto") send("goto", { query: label, id: d.target });
    else if (d.action === "tour") send("tour", { id: d.target ?? undefined });
    else if (d.action === "search") send("search", { query: d.query });
    else if (d.action === "next" || d.action === "prev" || d.action === "read" || d.action === "stop") send(d.action, {});
  }
  return d;
}
