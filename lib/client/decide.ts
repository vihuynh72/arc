// Browser side of the decision step: ask /api/decide, and dispatch an "arc:command" only when Arc is sure.
import type { Decision, Item } from "@/lib/server/decide";

export type { Decision };

export async function decide(utterance: string, items: Item[], inTour = false, state?: Record<string, string>): Promise<Decision> {
  const res = await fetch("/api/decide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // The Decisions API needs at least two target options ("none" is always one), so an empty page is sent one.
    body: JSON.stringify({ utterance, items: items.length ? items : [{ id: "top", label: "the top of the page" }], inTour, state }),
    signal: AbortSignal.timeout(3000), // normally 0.35 s; past this the caller answers locally rather than leave silence
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
  else if (d.action === "display") send("display", { setting: d.setting });
  else if (["next", "prev", "read", "continue", "stop", "faster", "slower", "refresh"].includes(d.action) || /^(?:next|prev)(?:Figure|Heading)$/.test(d.action)) send(d.action, {});
}
