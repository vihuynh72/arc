// The page's headings as a tree, and the spoken ways to move around it: "section 3.2", "three point two", "appendix B",
// "next subsection", "up", "contents". Pure (no DOM): lib/client/command.ts builds the entries from the twin, lib/intent.ts
// calls these and turns the answer into an existing goto (by node id) or one spoken line. Checked by scripts/checks/outline.ts.

export interface Entry {
  i: number; // index in the page's item list (what "goto at" and the reader's cursor use)
  id: string;
  label: string; // the heading as shown, numbering included ("3.2 Attention")
  level: number; // heading level as rendered (2 to 4); only entries with kind "section" have a heading
  kind: "section" | "other"; // other: a figure or text with no heading
  num?: string[]; // numbering at the start of the heading: ["3","2"], ["A","1"], ["B"]
  pre?: string; // "appendix", "chapter", "section" or "part" when the heading starts with that word
  figure?: boolean; // a figure (label "Figure 3", cap its caption)
  cap?: string;
}

/** A twin node as far as the outline needs it (TwinNode fits). */
export interface NodeLike {
  id: string;
  kind: string;
  level: number | null;
  heading: string;
  text?: string;
  page?: number;
}

/**
 * The outline of a page from its nodes: headings are sections (a PDF paragraph, level null with a page, is not), figures are
 * kind other with their caption. Levels are evened out so the tree matches the document's own numbering: in a numbered paper a
 * heading's level is the depth of its number ("3.2" is one below "3"), and an unnumbered heading that is not nested under a
 * deeper numbered one ("Abstract", the title, "References") sits at the top. This settles PDFs, where the title, "Abstract" and
 * "1 Introduction" all render as h2 though the parser gave them levels 1 and 2.
 */
export function entriesOf(nodes: NodeLike[]): Entry[] {
  const raw: Entry[] = nodes.map((n, i) => {
    const head = n.kind !== "figure" && !(n.page != null && !n.level);
    if (!head) return { i, id: n.id, label: n.heading, level: 0, kind: "other", ...(n.kind === "figure" ? { figure: true, cap: (n.text ?? "").slice(0, 300) } : {}) };
    const num = numOf(n.heading);
    return { i, id: n.id, label: n.heading, level: Math.min(Math.max(n.level ?? 2, 1), 6), kind: "section", ...(num ? { num: num.num, pre: num.pre } : {}) };
  });
  return evenLevels(raw);
}

/** A PDF's whole-document outline entry (twin.pdf.outline, lib/server/pdf.ts): level 1 is the top. */
export type TocEntry = { title: string; page: number; level: number };
export const TOC_ID = "toc:"; // an entry on a page not loaded yet: "toc:<index in the outline>"

/**
 * The outline of a PDF: the loaded pages' headings as entriesOf gives them, plus the document outline's entries for pages not
 * loaded yet, in page order. Such an entry has id "toc:<k>" and an `i` between the items around it (fractional), so "here",
 * "next section" and the lists treat it as a heading in its place; going to it loads its page (lib/client/pdf.ts).
 */
export function withToc(nodes: NodeLike[], toc: TocEntry[] = []): Entry[] {
  const loaded = new Set(nodes.flatMap((n) => (n.page != null ? [n.page] : [])));
  const extra = toc.flatMap((e, k) => (loaded.has(e.page) ? [] : [{ id: `${TOC_ID}${k}`, kind: "section", level: e.level + 1, heading: e.title, page: e.page }])).sort((a, b) => a.page - b.page); // +1: the parser gives the title level 1
  if (!extra.length) return entriesOf(nodes);
  const all: NodeLike[] = [];
  const at: number[] = []; // each one's place in the item list
  let x = 0;
  const before = (p: number, last: number) => {
    for (let k = 0; x < extra.length && extra[x].page < p; x++, k++) {
      all.push(extra[x]);
      at.push(last + 0.5 + k / 1000);
    }
  };
  nodes.forEach((n, r) => {
    before(n.page ?? Infinity, r - 1);
    all.push(n);
    at.push(r);
  });
  before(Infinity, nodes.length - 1);
  return entriesOf(all).map((e, k) => ({ ...e, i: at[k] }));
}

const plain = (l: string) => l.toLowerCase().replace(/^\s*(?:(?:appendix|chapter|section|part)\s+)?(?:\d{1,3}(?:\.\d{1,3})*|[a-z](?:\.\d{1,3})*)[.:)]?\s+/, "").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
/** The heading on a page that an outline entry names: the same number, else the same words. undefined: land on the page's top. */
export function headingOn(nodes: NodeLike[], page: number, title: string): string | undefined {
  const heads = nodes.filter((n) => n.page === page && n.kind === "section" && n.level);
  const num = numOf(title)?.num.join(".");
  return (num ? heads.find((n) => numOf(n.heading)?.num.join(".") === num) : undefined)?.id ?? heads.find((n) => plain(n.heading) === plain(title))?.id;
}

/** True when the headings carry their own numbers (most numbered papers), false for Wikipedia-style pages. */
export function numbered(o: Entry[]): boolean {
  const s = sections(o);
  const n = s.filter((e) => e.num).length;
  return n >= 2 && n >= s.length / 3;
}

function evenLevels(o: Entry[]): Entry[] {
  if (!numbered(o)) return o;
  const ones = sections(o).filter((e) => e.num?.length === 1 && /^\d+$/.test(e.num[0]));
  if (!ones.length) return o;
  const base = Math.min(...ones.map((e) => e.level));
  let lastNumbered: Entry | undefined; // the numbered heading above, with its level as given
  return o.map((e) => {
    if (e.kind !== "section") return e;
    if (e.num) {
      lastNumbered = e;
      return { ...e, level: base + e.num.length - 1 };
    }
    // An unnumbered heading nested deeper than the numbered one above it keeps its place under it; any other is top level.
    return lastNumbered && e.level > lastNumbered.level ? { ...e, level: base + (lastNumbered.num?.length ?? 1) } : { ...e, level: base };
  });
}

/**
 * Outline numbers, the way the document is numbered: a heading's own number ("3.2"), or, when the headings have none, numbers
 * made from the heading levels (1, 1.1, 1.2, 2, ...). Headings above the top level, and unnumbered headings in a numbered paper
 * ("Abstract"), have none. Keyed by node id.
 */
export function numbering(o: Entry[]): Map<string, string> {
  const out = new Map<string, string>();
  if (numbered(o)) {
    for (const e of sections(o)) if (e.num) out.set(e.id, e.num.join("."));
    return out;
  }
  const t = topLevel(o);
  const stack: { level: number; n: number }[] = [];
  for (const e of sections(o)) {
    if (e.level < t) continue;
    while (stack.length && stack[stack.length - 1].level > e.level) stack.pop();
    if (stack.length && stack[stack.length - 1].level === e.level) stack[stack.length - 1].n++;
    else stack.push({ level: e.level, n: 1 });
    out.set(e.id, stack.map((x) => x.n).join("."));
  }
  return out;
}

/** The top level sections that carry a plain number: "section N of <this>" counts these. */
function counted(o: Entry[]): Entry[] {
  const nums = numbering(o);
  const t = topLevel(o);
  return sections(o).filter((e) => e.level === t && /^\d+$/.test(nums.get(e.id) ?? ""));
}

/** For the reader's position line: the outline number of the heading at or above node `id` ("2.1"), or "" when it has none. */
export function outlineNumber(nodes: NodeLike[], id: string): string {
  const o = entriesOf(nodes);
  const at = o.findIndex((e) => e.id === id);
  const h = at >= 0 ? here(o, at) : undefined;
  return h ? (numbering(o).get(h.id) ?? "") : "";
}

/** For the reader's position line: how many numbered top level sections the page has ("Section 2 of <this>"). */
export const outlineCount = (nodes: NodeLike[]): number => counted(entriesOf(nodes)).length;

export interface Ref {
  pre?: string; // the word said before the number
  tokens: string[]; // ["3","2"], ["A","1"]
  text: string; // "3.2"
}

export type Found = { id: string } | { say: string; list?: Entry[] };

const WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20",
};
const ORD: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5, "6th": 6, "7th": 7, "8th": 8, "9th": 9, "10th": 10,
};

/** The numbering at the start of a heading: "3.2 Attention", "2.1. Hardware", "A.1 Proofs", "Appendix B: Proofs", "1 Introduction". */
export function numOf(label: string): { num: string[]; pre?: string } | undefined {
  const m = label.match(/^\s*(?:(appendix|chapter|section|part)\s+)?(\d{1,3}(?:\.\d{1,3})*|[A-Za-z](?:\.?\d{1,3})*)(?=[.:)]?(?:\s|$))/i);
  if (!m) return undefined;
  const pre = m[1]?.toLowerCase();
  const tok = m[2];
  // A lone letter is a number only after "Appendix"-style words or with its own punctuation ("A. Proofs"), never "A Study of ...".
  // "A Study of ..." and "C4 plants" are words, not numbers: a letter counts after "Appendix"-style words, with its own dot ("A.1", "A. Proofs"), or as "A1." with one.
  const own = /^[.)]\s/.test(label.slice(m[0].length));
  if (/^[A-Za-z]\d*$/.test(tok) && !pre && !(tok === tok.toUpperCase() && own)) return undefined;
  return { num: tok.toUpperCase().match(/[A-Z]|\d+/g)!, pre };
}

const LEAD = /^(?:(?:hey arc|ok arc|okay arc|arc|hey|ok|okay|um+|uh+|please|can you|could you|would you|take me|bring me|go|jump|skip|navigate|open|read|show me|show)\s+)+/;

/** "section 3.2", "go to section three point two", "appendix B", "section A1", "chapter 4", or a bare "3.2" / "two point one". */
export function parseRef(utterance: string): Ref | undefined {
  let s = utterance.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ").trim().replace(/[?!,;:]+$/, "").replace(/\.$/, "");
  s = s.replace(LEAD, "").replace(/^(?:back )?to /, "").replace(/^the /, "").replace(/ (?:please|now)$/, "").trim();
  const m = s.match(/^(subsection|section|chapter|appendix|part)?\s*(.+)$/);
  if (!m) return undefined;
  let r = m[2]
    .split(" ")
    .map((w) => WORDS[w] ?? (/^(?:point|dot|period)$/.test(w) ? "." : w))
    .join(" ")
    .replace(/\s*\.\s*/g, ".");
  if (/^[a-z] \d/.test(r)) r = r.replace(" ", ""); // "a 1"
  if (/\s/.test(r) || !/^(?:\d{1,3}|[a-z]\.?\d{0,3})(?:\.\d{1,3})*$/.test(r)) return undefined;
  if (!m[1] && !/^\d{1,3}(?:\.\d{1,3})+$/.test(r)) return undefined; // without a word before it, only a dotted number is a section
  return { pre: m[1], tokens: r.toUpperCase().match(/[A-Z]|\d+/g)!, text: r.toUpperCase() };
}

const sections = (o: Entry[]) => o.filter((e) => e.kind === "section");
const same = (a: string[], b: string[]) => a.length === b.length && a.every((t, k) => t === b[k]);

/** The level that counts as "a section" (as opposed to a subsection): the shallowest level with at least two headings. */
export function topLevel(o: Entry[]): number {
  const s = sections(o);
  const levels = [...new Set(s.map((e) => e.level))].sort((a, b) => a - b);
  return levels.find((l) => s.filter((e) => e.level === l).length >= 2) ?? levels[0] ?? 2;
}

/** The nearest section at or before item index `at` (a figure or paragraph belongs to the heading above it). */
export function here(o: Entry[], at: number): Entry | undefined {
  let best: Entry | undefined;
  for (const e of o) if (e.kind === "section" && e.i <= at) best = e;
  return best;
}

/** Direct subsections of a heading: the following headings one level deeper, up to the next heading at or above it. */
export function kids(o: Entry[], e: Entry): Entry[] {
  const out: Entry[] = [];
  for (const x of sections(o)) {
    if (x.i <= e.i) continue;
    if (x.level <= e.level) break;
    out.push(x);
  }
  const min = Math.min(...out.map((x) => x.level));
  return out.filter((x) => x.level === min);
}

/** The heading one level above. */
export function parent(o: Entry[], e: Entry): Entry | undefined {
  let p: Entry | undefined;
  for (const x of sections(o)) {
    if (x.i >= e.i) break;
    if (x.level < e.level) p = x;
  }
  return p;
}

const top = (o: Entry[], e: Entry): Entry => {
  let t = e;
  for (let p = parent(o, t); p; p = parent(o, t)) t = p;
  return t;
};

const words = (s: string, n: number) => {
  const w = s.replace(/\s+/g, " ").trim().split(" ");
  return w.length > n ? `${w.slice(0, n).join(" ")}...` : w.join(" ");
};
/** A heading as spoken in a list: its own number if the list has numbers, else its place in the list ("1, Overview"). */
// A heading as spoken: "1. Introduction" is said "1 Introduction". The dot after its number ended the sentence for the voice
// ("Abstract; 1." / "Introduction; 2."), so a list of headings was read in broken pieces.
const heading = (label: string, n: number) => words(label, n).replace(/^(\d+(?:\.\d+)*)\.(?=\s)/, "$1");
const said = (e: Entry, k: number, l: Entry[], nums?: Map<string, string>) =>
  `${l.some((x) => x.num) ? "" : `${nums?.get(e.id) ?? k + 1}, `}${heading(e.label, 7)}`;

const pick = (e: Entry): Found => ({ id: e.id });
const nth = (l: Entry[], k: number): Found | undefined => (l[k] ? pick(l[k]) : undefined);

/** Disambiguation: one short line, and the candidates so "first" or "second" picks one. */
export function which(c: Entry[], heard?: string, what = "sections"): Found {
  const shown = c.slice(0, 4);
  const ord = ["first", "second", "third", "fourth"].slice(0, shown.length);
  const count = c.length > 4 ? `${c.length} ${what}` : (["", "One", "Two", "Three", "Four"][c.length] ?? "Several") + ` ${what}`;
  return {
    say: `${heard ? `I heard ${heard}. ` : ""}${count} fit: ${shown.map((e) => heading(e.label, 7)).join("; ")}${c.length > 4 ? "; and more" : ""}. Say ${ord.slice(0, -1).join(", ")} or ${ord[ord.length - 1]}.`,
    list: shown,
  };
}

/** A spoken section reference to a heading, by the outline numbers (lib/outline.ts numbering): its own, or made from levels. */
export function findRef(o: Entry[], ref: Ref, at: number): Found {
  const s = sections(o);
  const cur = here(o, at);
  if (ref.pre === "subsection" && ref.tokens.length === 1 && /^\d+$/.test(ref.tokens[0])) {
    const subs = cur ? kids(o, top(o, cur)) : [];
    return nth(subs, Number(ref.tokens[0]) - 1) ?? { say: `There is no subsection ${ref.tokens[0]} here.` };
  }
  const nums = numbering(o);
  const tok = (e: Entry) => (e.num && numbered(o) ? e.num : (nums.get(e.id)?.split(".") ?? []));
  let hit = s.filter((e) => tok(e).length && same(tok(e), ref.tokens));
  if (!hit.length) hit = s.filter((e) => e.num && same(e.num, ref.tokens)); // a page with a few numbered headings among many
  if (ref.pre === "appendix" || ref.pre === "chapter" || ref.pre === "part") hit = hit.filter((e) => e.pre === ref.pre).length ? hit.filter((e) => e.pre === ref.pre) : hit;
  if (hit.length === 1) return pick(hit[0]);
  if (hit.length > 1) return which(hit);
  return { say: `I could not find ${ref.pre === "appendix" || ref.pre === "chapter" ? ref.pre : "section"} ${ref.text}. Say contents to hear the sections.` };
}

/** "next section" and friends. Returns undefined when the words are not a relation. */
export function relate(o: Entry[], at: number, what: "nextSection" | "prevSection" | "nextSub" | "prevSub" | "firstSub" | "up"): Found {
  const s = sections(o);
  const cur = here(o, at);
  if (!cur) return what === "nextSection" || what === "firstSub" ? (s[0] ? pick(s[0]) : { say: "There are no sections." }) : { say: "You are before the first section." };
  const k = s.indexOf(cur);
  if (what === "nextSection" || what === "prevSection") {
    const d = what === "nextSection" ? 1 : -1;
    for (let j = k + d; j >= 0 && j < s.length; j += d) {
      if (s[j].level === cur.level) return pick(s[j]);
      if (s[j].level < cur.level) break; // left the parent: no sibling that way
    }
    const any = s[k + d];
    return any ? pick(any) : { say: d > 0 ? "That is the last section." : "That is the first section." };
  }
  if (what === "up") {
    const p = parent(o, cur);
    return p ? pick(p) : { say: "This is already a top level section." };
  }
  const own = kids(o, cur);
  if (what === "firstSub") {
    const pool = own.length ? own : parent(o, cur) ? kids(o, parent(o, cur)!) : [];
    return nth(pool, 0) ?? { say: "This section has no subsections." };
  }
  // next or previous subsection: from a subsection, its sibling; from a section with subsections, its first one
  const p = parent(o, cur);
  if (what === "nextSub") {
    if (own.length && (!p || cur.level <= topLevel(o))) return pick(own[0]);
    const sibs = p ? kids(o, p) : [];
    const n = sibs[sibs.indexOf(cur) + 1];
    return n ? pick(n) : p ? { say: "That is the last subsection." } : { say: "This section has no subsections." };
  }
  const sibs = p ? kids(o, p) : [];
  const b = sibs[sibs.indexOf(cur) - 1];
  return b ? pick(b) : p ? { say: "That is the first subsection." } : { say: "You are not in a subsection." };
}

/** "contents": the top level headings with their numbers, briefly; deep: with the level below ("say more" after contents). */
export function contents(o: Entry[], deep = false): Found {
  const t = topLevel(o);
  const all = sections(o);
  const l = all.filter((e) => e.level === t || (deep && e.level === t + 1));
  if (!l.length) return { say: "This page has no sections." };
  const subs = all.some((e) => e.level > t);
  const shown = l.slice(0, deep ? 16 : 8);
  const nums = numbering(o);
  const n = l.filter((e) => e.level === t).length;
  const what = deep ? `${n} main section${n === 1 ? "" : "s"} and ${l.length - n} under them` : `${n} ${subs ? "main " : ""}section${n === 1 ? "" : "s"}`;
  const tail = subs && !deep ? " Say more for the subsections, or say section and a number." : " Say section and a number, or the second one.";
  return { say: `${what}: ${shown.map((e, k) => said(e, k, l, nums)).join("; ")}${l.length > shown.length ? `; and ${l.length - shown.length} more` : ""}.${tail}`, list: shown };
}

/** "what is in this section": its subsections. */
export function inside(o: Entry[], at: number): Found {
  const cur = here(o, at);
  if (!cur) return contents(o);
  const l = kids(o, cur);
  if (!l.length) return { say: `${heading(cur.label, 7)} has no subsections.` };
  const shown = l.slice(0, 8);
  const nums = numbering(o);
  return { say: `${heading(cur.label, 7)} has ${l.length} subsection${l.length === 1 ? "" : "s"}: ${shown.map((e, k) => said(e, k, l, nums)).join("; ")}${l.length > shown.length ? `; and ${l.length - shown.length} more` : ""}.`, list: shown };
}

/** "where am i": the section and the one it sits in, and the paragraph. Numbers are the outline's ("section 3 of 5"). */
export function path(o: Entry[], at: number, para?: { at: number; of: number }): string | undefined {
  const cur = here(o, at);
  if (!cur) return undefined;
  const p = parent(o, cur);
  const nums = numbering(o);
  const n = nums.get(cur.id);
  const own = !!cur.num && numbered(o); // the label already says its number
  const tops = counted(o);
  const place = p
    ? `${n && !own ? `, section ${n}` : ""}, inside ${heading(p.label, 10)}`
    : n && /^\d+$/.test(n) && tops.length ? `, section ${n} of ${tops.length}` : "";
  return `${heading(cur.label, 10)}${place}.${para && para.of > 0 ? ` Paragraph ${para.at} of ${para.of}.` : ""}`;
}

/** The heading a list of spoken names points to: "the second one", "second", "3", "last". */
export function ordinal(utterance: string, list: Entry[]): Entry | undefined {
  const s = utterance.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
  const m = s.match(/^(?:(?:go to|open|take me to|pick|choose|select|read) )?(?:the )?(?:number )?(\w+)(?: (?:one|section|subsection|item))?$/);
  if (!m) return undefined;
  if (m[1] === "last") return list[list.length - 1];
  const n = ORD[m[1]] ?? (/^\d+$/.test(m[1]) ? Number(m[1]) : WORDS[m[1]] ? Number(WORDS[m[1]]) : undefined);
  return n && n >= 1 ? list[n - 1] : undefined;
}

/** Words that say nothing about which heading is meant. */
const STOP = new Set(["go", "to", "the", "a", "an", "of", "section", "subsection", "part", "chapter", "take", "me", "show", "open", "jump", "please", "on", "about", "page"]);
const stem = (w: string) => w.replace(/(?:ies|es|s)$/, "");

/** Headings that a spoken name fits when it names no single one exactly (two sections share a word). */
export function labelMatches(o: Entry[], query: string): Entry[] {
  const q = query.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
  if (!q.length) return [];
  const norm = (l: string) => l.toLowerCase().replace(/^\s*(?:(?:appendix|chapter|section|part)\s+)?[\d.]+[.)]?\s*|^\s*(?:(?:appendix|chapter|section|part)\s+)?[a-z]\.\s+/, "").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
  const s = sections(o);
  const exact = s.filter((e) => norm(e.label) === q.join(" "));
  if (exact.length) return exact.length === 1 ? [] : exact; // one exact heading is not ambiguous
  return s.filter((e) => {
    const w = norm(e.label).split(" ").map(stem);
    return q.every((t) => w.includes(stem(t)));
  });
}

// ---- by name: "go to the hardware section", "conclusions", "the confusion matrix figure", "figure 8.2", "table 2" ----

/** Words that say nothing about which heading is meant when a student names one. */
const NAME_STOP = new Set([
  ...STOP, "and", "for", "in", "with", "part", "parts", "bit", "where", "it", "talks", "talk", "say", "says", "is", "are", "heading", "headings",
  "jump", "skip", "move", "navigate", "bring", "can", "you", "i", "want", "need", "let's", "lets", "back", "now", "there", "that", "this", "one", "sections", "please",
]);
// shortcut: plural and -ing endings only (conclusions, methods, results, testing); upgrade to a real stemmer if odd misses are heard.
const root = (w: string) => w.replace(/'s$/, "").replace(/(?:ies)$/, "y").replace(/(?:sses)$/, "ss").replace(/(?<=\w{3})(?:es|s)$/, "").replace(/(?<=\w{4})ing$/, "");
const tokens = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter(Boolean);
const bare = (label: string) => label.replace(/^\s*(?:(?:appendix|chapter|section|part)\s+)?(?:\d{1,3}(?:\.\d{1,3})*|[A-Z](?:\.\d{1,3})*)[.:)]?\s+/i, "");

/** The content words of a request naming a heading, in root form ("go to the hardware section" -> ["hardware"]). */
export const nameWords = (q: string) => tokens(q).filter((w) => !NAME_STOP.has(w)).map(root);

/**
 * A heading named by its words: case, plurals, stop words and the heading's own number ignored. One fit: its id. Several: one
 * short question listing at most four ("Two sections fit: 2.1. Hardware; 3.1. Hardware. Say first or second."). None: undefined,
 * so a better reader (the decision model) may still place a request like "the part about how accurate it is".
 */
export function byName(o: Entry[], query: string): Found | undefined {
  const q = nameWords(query);
  if (!q.length || q.length > 6) return undefined;
  const s = sections(o);
  const hw = (e: Entry) => tokens(bare(e.label)).filter((w) => !NAME_STOP.has(w)).map(root);
  // Several headings holding the words: ask, the one named exactly first ("attention": 3.2 Attention, then 3.2.1 ... Attention).
  const exact = s.filter((e) => hw(e).join(" ") === q.join(" "));
  const rest = s.filter((e) => !exact.includes(e) && q.every((t) => hw(e).includes(t)));
  const under = (e: Entry) => exact.some((x) => { for (let p = parent(o, e); p; p = parent(o, p)) if (p === x) return true; return false; });
  const all = [...exact, ...rest.filter(under), ...rest.filter((e) => !under(e))]; // the named one's own subsections next
  if (all.length === 1) return pick(all[0]);
  if (all.length > 1) return which(all);
  return undefined;
}

/** "figure 3", "go to figure 8.2", "table two": the kind and the printed number ("8.2"), or undefined. */
export function figureRef(utterance: string): { kind: "figure" | "table"; n: string } | undefined {
  const s = utterance.toLowerCase().replace(/[?!,;:]+$/, "").replace(/\.$/, "").replace(/\s+/g, " ").trim();
  const m = s.match(/^(?:(?:go|jump|skip|take me|bring me|show me|move|navigate|open|read)\s+)?(?:to\s+)?(?:the\s+)?(figure|fig\.?|table|tab\.?)\s+(\S+)$/);
  if (!m) return undefined;
  const n = m[2].split(/\s+/).join(" ").replace(/^(\w+) point (\w+)$/, "$1.$2");
  const w: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };
  const v = n.split(".").map((x) => w[x] ?? x).join(".");
  if (!/^\d{1,3}(?:\.\d{1,3})?[a-z]?$/.test(v)) return undefined;
  return { kind: m[1].startsWith("t") ? "table" : "figure", n: v };
}

/** Figures whose caption holds every content word of "the confusion matrix figure" (the word "figure" itself aside). */
export function figureByWords(o: Entry[], query: string): Entry[] {
  const q = nameWords(query).filter((w) => !/^(?:figure|fig|image|picture|chart|graph|diagram|photo)$/.test(w));
  if (!q.length) return [];
  return o.filter((e) => e.figure && q.every((t) => tokens(`${e.label} ${e.cap ?? ""}`).map(root).includes(t)));
}

// ---- finding words in the open document ----

/** One place the reader can stop: a block of a section (block id set), a whole PDF paragraph, or a figure's caption. */
export interface Unit {
  id: string; // node id
  block?: string; // block id ("n05.b02"), for the reader to land on that block
  b: number; // block index in its node, -1 for a figure or a node read whole
  where: string; // the heading it sits under, as spoken ("2.1. Hardware", "Figure 3")
  text: string;
}

/**
 * The places holding the words: those with the exact phrase if any, else those with every content word in any order (plural
 * and case aside). In document order.
 */
export function findText(units: Unit[], query: string): Unit[] {
  const phrase = tokens(query).join(" ");
  if (!phrase) return [];
  const exact = units.filter((u) => ` ${tokens(u.text).join(" ")} `.includes(` ${phrase} `));
  if (exact.length) return exact;
  const q = tokens(query).filter((w) => !["the", "a", "an", "of", "to", "and", "in", "on", "for", "is"].includes(w));
  if (!q.length) return [];
  return units.filter((u) => {
    const w = tokens(u.text);
    return q.every((t) => w.some((x) => sameWord(t, x)));
  });
}

/**
 * Whole words by stem, from the word's start: "accurate" meets "accuracy" and "accurately", never "inaccurately". Two roots meet
 * when they share their first six letters (a five-letter root: when the other starts with it); a shorter root must match whole ("rate" is not "rated").
 * shortcut: six letters stand for a stem; a real stemmer if odd matches show up.
 */
export function sameWord(a: string, b: string): boolean {
  const x = root(a.toLowerCase()), y = root(b.toLowerCase());
  if (x === y) return true;
  const [lo, hi] = x.length <= y.length ? [x, y] : [y, x];
  if (lo.length === 5) return hi.startsWith(lo); // "sampl" (sampling) and "sample"
  if (lo.length < 6) return false;
  return x.slice(0, 6) === y.slice(0, 6);
}

/** Words that do not say what a topic request is about ("go to where they talk about how accurate it is" -> "accurate"). */
const TOPIC_STOP = new Set(["where", "they", "them", "talk", "talks", "talking", "about", "how", "it", "is", "its", "it's", "what", "which", "who", "discuss", "discusses", "mention", "mentions", "mentioned", "explain", "explains", "describe", "describes", "say", "says", "place", "bit", "thing", "stuff", "something", "anything", "do", "does", "did", "was", "were", "be", "been", "their", "there", "go", "find", "show", "take"]);
export const topicWords = (q: string) => nameWords(q).filter((w) => !TOPIC_STOP.has(w));

/** Where in a found place to start reading: the sentence holding the most of the words, the earliest such (0 when none holds any). */
export function sentenceWith(sentences: string[], query: string): number {
  const words = topicWords(query);
  let best = 0, top = 0;
  sentences.forEach((s, i) => {
    const w = tokens(s);
    const n = words.filter((t) => w.some((x) => sameWord(t, x))).length;
    if (n > top) [best, top] = [i, n];
  });
  return best;
}

/**
 * A topic named in a request, over the page's words: the places holding the most of its words (at least half), more of the
 * words first, then page order. `matched`: the words the first place holds.
 * For "where they talk about how accurate it is" or "find the part about Bluetooth and how the data is sent".
 */
export function findTopic(units: Unit[], query: string, words = topicWords(query)): { words: string[]; matched: string[]; list: Unit[] } {
  if (!words.length) return { words, matched: [], list: [] };
  const scored = units.map((u, k) => {
    const w = tokens(u.text);
    const has = words.filter((t) => w.some((x) => sameWord(t, x)));
    return { u, k, has };
  });
  const need = Math.max(1, Math.ceil(words.length / 2));
  const list = scored.filter((x) => x.has.length >= need).sort((a, b) => b.has.length - a.has.length || a.k - b.k);
  return { words, matched: list[0]?.has ?? [], list: list.map((x) => x.u) };
}
