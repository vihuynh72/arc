"use client";
// The browser side of a PDF (server: lib/server/pdf.ts, /api/pdf/*). The twin opens with pages 1 and 2; this adds the rest by position:
// the page after the last loaded one when the cursor (or a hand scroll) is within a screen of the end, the page before the first
// one likewise. Pages still "quick" (text pulled out by code) are asked again until the model's "full" version arrives and is
// swapped in by id: never under a block that is being spoken, never scrolling, never re-reading. Used by components/Twin.tsx.
import { useEffect, type Dispatch, type SetStateAction } from "react";
import { type Chunk, said, speaker, startWaitTone } from "@/lib/client/reader";
import { headingOn } from "@/lib/outline";
import type { Twin, TwinNode } from "@/lib/types";
import { OPENING } from "@/lib/keys";

// figures: node id -> per-figure data (box, label); carried onto its node as `figure`, like a late `image`.
export type PageReply = { page: number; pages: number; stage: "quick" | "full"; nodes: TwinNode[]; figures?: Record<string, unknown>; outline?: NonNullable<Twin["pdf"]>["outline"] };
/** The whole document's outline, once a reply carries it (a file without bookmarks: found a moment after it opens). */
const withOutline = (t: Twin, r: PageReply): Twin => (r.outline && !t.pdf?.outline && t.pdf ? { ...t, pdf: { ...t.pdf, outline: r.outline } } : t);

const POLL_MS = 2500;
const NEAR = 2; // pages either side of the cursor that are kept fresh
const speak = (line: string) => {
  said(line);
  void speaker.say([line]);
};

export const pdfIntro = (t: Twin): Chunk[] => [
  t.source.lang && !/^(en|und|zxx)\b/i.test(t.source.lang) ? { text: `${t.source.title}.`, lang: t.source.lang } : `${t.source.title}.`,
  `${t.pdf?.pages ?? 0} ${t.pdf?.pages === 1 ? "page" : "pages"}.`,
  OPENING,
];

export const isPdfFile = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

/** GET reads page n; student: POST says the student is at n, so the server prepares n and n+1 first. null when the server did not answer. */
export async function fetchPage(id: string, n: number, student = false): Promise<PageReply | null> {
  try {
    const r = student
      ? await fetch("/api/pdf/page", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, n }) })
      : await fetch(`/api/pdf/page?id=${encodeURIComponent(id)}&n=${n}`);
    return r.ok ? ((await r.json()) as PageReply) : null;
  } catch {
    return null;
  }
}

// Every field the server sent is compared (a figure's `image` and `figure` arrive with a later stage), not only the words.
const same = (a: TwinNode, b: TwinNode) => (Object.keys(b) as (keyof TwinNode)[]).every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
/** The reply's nodes, each figure with its entry from `figures` (whatever fields the server adds pass through untouched). */
export const withFigures = (r: PageReply): TwinNode[] => (r.figures ? r.nodes.map((n) => (r.figures![n.id] ? ({ ...n, figure: r.figures![n.id] } as TwinNode) : n)) : r.nodes);

/** `nodes` with page `page` replaced by `fresh`, in reading order. A node whose id and words did not change keeps its object, so React
 * leaves it alone; `held` (the block being spoken) stays as it is. The same array comes back when nothing changed. */
export function mergePage(nodes: TwinNode[], page: number, fresh: TwinNode[], held?: TwinNode): TwinNode[] {
  const old = new Map(nodes.filter((n) => n.page === page).map((n) => [n.id, n]));
  // A changed node is the server's version; a tour fetched in the browser stays on it.
  const next = fresh.map((f) => {
    const o = old.get(f.id);
    if (held && f.id === held.id) return held;
    if (o && same(o, f)) return o;
    return o?.tour && !f.tour ? { ...f, tour: o.tour } : f;
  });
  if (held && held.page === page && !next.some((n) => n.id === held.id)) next.push(held);
  const sorted = next.sort((a, b) => a.order - b.order);
  const there = nodes.filter((n) => n.page === page);
  if (there.length === sorted.length && there.every((n, i) => n === sorted[i])) return nodes;
  return [...nodes.filter((n) => n.page !== page), ...sorted].sort((a, b) => a.order - b.order);
}

/** A PDF dropped on the page, or pasted: calls onFile with it. Anything else that is a file is refused in a line (the browser would open it). */
export function watchPdfFiles(onFile: (f: File) => void, onOther: () => void) {
  const files = (dt: DataTransfer | null) => [...(dt?.files ?? [])];
  const over = (e: DragEvent) => void ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === "file") && e.preventDefault());
  const drop = (e: DragEvent) => {
    const all = files(e.dataTransfer);
    if (!all.length) return;
    e.preventDefault();
    const f = all.find(isPdfFile);
    if (f) onFile(f);
    else onOther();
  };
  const paste = (e: ClipboardEvent) => {
    const f = files(e.clipboardData).find(isPdfFile);
    if (!f) return;
    e.preventDefault();
    onFile(f);
  };
  window.addEventListener("dragover", over);
  window.addEventListener("drop", drop);
  window.addEventListener("paste", paste);
  return () => {
    window.removeEventListener("dragover", over);
    window.removeEventListener("drop", drop);
    window.removeEventListener("paste", paste);
  };
}

// One PDF is open at a time.
const S = { id: "", stage: new Map<number, string>(), busy: new Set<number>(), pending: new Map<number, PageReply>(), cur: "", page: 0, jump: "", lead: "", movedAt: 0 };
let nodesNow: TwinNode[] = [];
let pagesNow = 0;
let outlineNow = false;
let again = () => {}; // look again at how far the end of the loaded pages is
const send = (name: string, args: object) => window.dispatchEvent(new CustomEvent("arc:command", { detail: { name, args } }));
/** The cursor to `id`, which reads it. lead: an outline entry whose heading the page did not show: its name first (the reader then names the page). */
const goWith = (id: string, lead: string) => {
  if (!lead) return send("goto", { id });
  said(lead);
  void speaker.say([lead]).then((ok) => ok && send("goto", { id }));
};

export function usePdf(twin: Twin | null, setTwin: Dispatch<SetStateAction<Twin | null>>) {
  const id = twin?.pdf?.id ?? "";
  useEffect(() => {
    nodesNow = twin?.nodes ?? [];
    outlineNow = !!twin?.pdf?.outline;
    pagesNow = twin?.pdf?.pages ?? 0;
  });
  // After "go to page 9" has put its page on screen, the cursor goes to the page's first stop (which reads it).
  useEffect(() => {
    if (S.jump && nodesNow.some((n) => n.id === S.jump)) {
      goWith(S.jump, S.lead);
      S.jump = S.lead = "";
    }
  }, [twin]);

  useEffect(() => {
    if (!id) return;
    Object.assign(S, { id, stage: new Map(), busy: new Set(), pending: new Map(), cur: "", page: 0, jump: "", lead: "", movedAt: 0 });
    let raf = 0;
    const loaded = () => new Set(nodesNow.flatMap((n) => (n.page ? [n.page] : [])));

    // A page's nodes into the twin. While the block under the cursor is being spoken it stays as it is and the new page waits (S.pending).
    const apply = (r: PageReply) => {
      S.stage.set(r.page, r.stage);
      const cur = nodesNow.find((n) => n.id === S.cur);
      const hold = cur?.page === r.page && speaker.busy ? cur : undefined;
      if (hold) S.pending.set(r.page, r);
      else S.pending.delete(r.page);
      // Whatever is added or swapped above the cursor, the cursor stays where it is on the screen (the browser's own scroll anchoring does most of it).
      const mark = document.querySelector('[aria-current="true"]');
      const top = mark?.getBoundingClientRect().top;
      setTwin((t) => {
        if (!t?.pdf || t.pdf.id !== id) return t;
        const nodes = mergePage(t.nodes, r.page, withFigures(r), hold && t.nodes.find((n) => n.id === hold.id));
        return withOutline(nodes === t.nodes ? t : { ...t, nodes }, r);
      });
      if (mark && top != null)
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const d = mark.isConnected ? mark.getBoundingClientRect().top - top : 0;
            if (Math.abs(d) > 2) window.scrollBy({ top: d, behavior: "instant" });
          }),
        );
    };
    // A reply only counts while its page is loaded, beside what is loaded, or the cursor's: one that arrives after a jump must not bring an old page back.
    const wanted = (n: number) => loaded().has(n) || loaded().has(n - 1) || loaded().has(n + 1) || n === S.page;
    const get = async (n: number, student = false) => {
      if (n < 1 || n > pagesNow || (!student && S.busy.has(n))) return null;
      S.busy.add(n);
      const r = await fetchPage(id, n, student);
      if (r && S.id === id && wanted(n)) apply(r);
      setTimeout(() => S.busy.delete(n), r ? 400 : 0); // until the page is on screen: a scroll in between must not ask for it again
      return r;
    };

    // Within a screen of the end (or the start) of what is loaded: the next (previous) page is added, quietly.
    const near = () => {
      raf = 0;
      if (!nodesNow.length) return;
      const ps = [...loaded()];
      const [hi, lo] = [Math.max(...ps), Math.min(...ps)];
      const el = (n: TwinNode) => document.querySelector(`[data-node-id="${n.id}"]`);
      const last = el(nodesNow[nodesNow.length - 1]);
      const first = el(nodesNow[0]);
      if (hi < pagesNow && last && last.getBoundingClientRect().bottom < window.innerHeight * 2) void get(hi + 1);
      // The page before the first loaded one waits until the cursor has stopped moving, so the page is not shifted under a glide.
      if (lo > 1 && first && first.getBoundingClientRect().top > -window.innerHeight) {
        if (performance.now() - S.movedAt > 900) void get(lo - 1);
        else setTimeout(soon, 950);
      }
    };
    const soon = () => void (raf ||= requestAnimationFrame(near));
    again = soon;

    const onCursor = (e: Event) => {
      S.cur = (e as CustomEvent<{ id: string }>).detail?.id ?? "";
      S.movedAt = performance.now();
      const page = nodesNow.find((n) => n.id === S.cur)?.page;
      if (page && page !== S.page) {
        S.page = page;
        void get(page, true); // the student is here: this page and the next go to the front of the model's queue
      }
      S.pending.forEach(apply); // the cursor may have left the block that was held
      soon();
    };

    // "go to page 9", "next page": the page is fetched if it is not here, then the cursor goes to its first stop. With `title` (an
    // outline entry, lib/client/command.ts): to that heading on the page, else to the page's top after the heading's name.
    const onCommand = async (e: Event) => {
      const { name, args } = (e as CustomEvent<{ name: string; args?: { n?: number; by?: number; title?: string } }>).detail ?? {};
      if (name !== "page") return;
      const want = args?.n ?? (S.page || 1) + (args?.by ?? 0);
      if (want > pagesNow || want < 1) return speak(args?.n ? `This PDF has ${pagesNow} ${pagesNow === 1 ? "page" : "pages"}.` : want < 1 ? "That is the first page." : "That is the last page.");
      const was = S.page;
      S.page = want; // from here on, replies for the old place are stale
      const target = (nodes: TwinNode[]) => {
        const at = args?.title ? headingOn(nodes, want, args.title) : undefined;
        S.lead = args?.title && !at ? `${args.title.replace(/^(\d+(?:\.\d+)*)\.(?=\s)/, "$1")}.` : ""; // spoken without the dot after its number
        return at ?? nodes.find((n) => n.page === want)?.id;
      };
      const first = nodesNow.find((n) => n.page === want);
      if (!first) {
        let off = () => {};
        const late = setTimeout(() => void (off = startWaitTone()), 400); // the usual waiting tone, while the page is read
        const next = loaded().has(want - 1) || loaded().has(want + 1); // beside what is loaded: added; elsewhere: it replaces it, so no gap is read across
        // A heading mid-page: the page before comes with it, so it is not added above the cursor while the reader glides there
        // (seen: the cursor then landed on the page before and read from there).
        const [r, prev] = await Promise.all([fetchPage(id, want, true), !next && args?.title && want > 1 ? fetchPage(id, want - 1) : null]);
        clearTimeout(late);
        off();
        if (S.id !== id) return;
        if (!r?.nodes.length) {
          S.page = was; // the student stays where they were
          return speak(`I could not get page ${want}. Try again in a moment.`);
        }
        S.stage.set(want, r.stage);
        if (prev) S.stage.set(want - 1, prev.stage);
        const own = [...(prev ? withFigures(prev) : []), ...withFigures(r)];
        setTwin((t) => t && withOutline({ ...t, nodes: next ? mergePage(t.nodes, want, withFigures(r)) : own }, r));
        S.jump = target(r.nodes) ?? r.nodes[0].id;
        return;
      }
      void get(want, true);
      goWith(target(nodesNow) ?? first.id, S.lead);
      S.lead = "";
    };

    let asks = 0;
    const tick = setInterval(() => {
      S.pending.forEach(apply);
      if (!outlineNow && asks++ < 8) void get([...loaded()][0] ?? 1); // the outline is still being found: asked again, about 20 s at most
      for (const p of loaded()) if (S.stage.get(p) !== "full" && Math.abs(p - (S.page || 1)) <= NEAR) void get(p);
    }, POLL_MS);
    void get(1, true);
    window.addEventListener("arc:cursor", onCursor);
    const onBlock = () => {
      S.movedAt = performance.now();
      soon();
    };
    window.addEventListener("arc:block", onBlock);
    window.addEventListener("scroll", soon, { passive: true });
    window.addEventListener("arc:command", onCommand);
    return () => {
      clearInterval(tick);
      cancelAnimationFrame(raf);
      window.removeEventListener("arc:cursor", onCursor);
      window.removeEventListener("arc:block", onBlock);
      window.removeEventListener("scroll", soon);
      window.removeEventListener("arc:command", onCommand);
      S.id = "";
      again = () => {};
    };
  }, [id, setTwin]);

  useEffect(() => void (id && requestAnimationFrame(() => again())), [twin?.nodes, id]); // pages added: look again, so a short page does not stop the paging
}
