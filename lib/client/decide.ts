// Browser side of the decision step: ask /api/decide, and dispatch an "arc:command" only when Arc is sure.
import type { Decision, Item } from "@/lib/server/decide";

export type { Decision };

export async function decide(utterance: string, items: Item[], inTour = false): Promise<Decision> {
  const res = await fetch("/api/decide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // SubQ needs at least two target options ("none" is always one): an empty page (nothing loaded yet) got HTTP 422.
    body: JSON.stringify({ utterance, items: items.length ? items : [{ id: "top", label: "the top of the page" }], inTour }),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Decision failed.");
  return (await res.json()) as Decision;
}

export function dispatchDecision(d: Decision, items: Item[]) {
  if (!d.act) return;
  const label = items.find((i) => i.id === d.target)?.label;
  const send = (name: string, args: object) => window.dispatchEvent(new CustomEvent("arc:command", { detail: { name, args } }));
  if (d.action === "goto") send("goto", { query: label, id: d.target });
  else if (d.action === "tour") send("tour", { id: d.target ?? undefined });
  else if (d.action === "search") send("search", { query: d.query });
  else if (d.action === "open") send("open", { id: d.target });
  else if (d.action === "next" || d.action === "prev" || d.action === "read" || d.action === "stop" || d.action === "refresh") send(d.action, {});
}
