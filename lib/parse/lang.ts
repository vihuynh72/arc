// Language and direction of a page, for source.lang / source.dir. Deterministic: what the page declares (<html lang dir>,
// content-language), else the script of the text, else (Latin script, nothing declared) a stop-word count that must beat
// English clearly; otherwise unset (English).
// Callers: lib/parse/html.ts, text.ts, markdown.ts, lib/server/pdf.ts, video.ts, app/api/speak. Checked by scripts/checks/lang.ts.
import type { Twin } from "@/lib/types";

const RTL = new Set(["ar", "he", "fa", "ur", "yi", "ps", "sd", "ug", "dv", "ckb", "iw"]);
// Letter ranges, in the order they are tried when text is mixed; the language is the usual one for that script.
const SCRIPTS: [RegExp, string][] = [
  [/[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g, "ar"],
  [/[֐-׿יִ-ﭏ]/g, "he"],
  [/[぀-ヿㇰ-ㇿ]/g, "ja"], // kana: Japanese even when most letters are Han
  [/[가-힯ᄀ-ᇿ]/g, "ko"],
  [/[一-鿿㐀-䶿]/g, "zh"],
  [/[ऀ-ॿ]/g, "hi"],
  [/[฀-๿]/g, "th"],
  [/[Ѐ-ӿ]/g, "ru"],
  [/[Ͱ-Ͽ]/g, "el"],
];
const LETTER = /\p{L}/gu;

/** The language of the dominant non-Latin script in the text, or undefined (Latin, too little text, or mixed). */
export function scriptLang(text: string): string | undefined {
  const sample = text.slice(0, 4000);
  const letters = sample.match(LETTER)?.length ?? 0;
  if (letters < 20) return undefined;
  const hits = SCRIPTS.map(([re, lang]) => [lang, sample.match(re)?.length ?? 0] as const);
  const han = hits.find(([l]) => l === "zh")![1];
  const kana = hits.find(([l]) => l === "ja")![1];
  const best = hits.filter(([l]) => l !== "zh" || !kana).sort((a, b) => b[1] - a[1])[0];
  if (kana && han + kana >= letters * 0.3) return "ja";
  return best && best[1] >= letters * 0.3 ? best[0] : undefined;
}

// The commonest short words of each Latin-script language Arc can voice. Words shared with English ("in", "a") are left out of
// the others; words shared between them ("de", "en") count for each, and the totals still tell them apart.
const STOP: Record<string, string> = {
  en: "the of and to is that for are with as by this it from which be on or an was were these their its can has have not",
  es: "el la los las de del que y en un una es por con para se su sus al como más son lo pero este esta también entre sobre",
  fr: "le la les des de du et est un une en que qui dans pour par sur au aux ce cette sont pas ne avec se il elle ou",
  de: "der die das und ist den dem des ein eine einer von zu mit sich auf für nicht im werden wird auch als bei oder sind",
  pt: "o os as de do da dos das e em um uma que é para por com no na nos se ao mais são pelo pela também",
  it: "il lo la gli le di del della e è un una che per con non si sono dei delle al alla da nel nella anche",
  nl: "de het een en van is dat op te voor met zijn die niet aan door worden wordt ook als bij om er",
  tr: "ve bir bu ile için da de olarak olan gibi daha çok ya ise kadar sonra her tarafından veya",
  pl: "i w z na się do nie jest to że o od przez jak po oraz ich są dla jego czy także",
  id: "yang dan di ini itu dengan untuk dari dalam adalah pada ke tidak akan oleh atau juga sebagai karena",
  vi: "và của là các có được trong cho không những một này với người đã để khi từ như cũng",
};
const STOPS = Object.entries(STOP).map(([l, w]) => [l, new Set(w.split(" "))] as const);

/** A Latin-script language from its common words, or undefined. Needs 30+ words, the best language on at least 15% of
 * them and at least twice English's share: a few loanwords or Latin names in an English text never switch it. */
export function wordLang(text: string): string | undefined {
  const words = text.slice(0, 4000).toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 30) return undefined;
  const share = STOPS.map(([l, set]) => [l, words.filter((w) => set.has(w)).length / words.length] as const).sort((a, b) => b[1] - a[1]);
  const en = share.find(([l]) => l === "en")![1];
  const [best, s] = share[0];
  return best !== "en" && s >= 0.15 && s >= 2 * en ? best : undefined;
}

/** "es-MX", "zh_Hans", "EN" -> "es", "zh", "en". */
export const primary = (tag?: string | null) => (/^[a-z]{2,3}(?=$|[-_])/i.exec((tag ?? "").trim())?.[0] ?? "").toLowerCase() || undefined;

/** What to put in source: nothing for English pages that read left to right. `declared`: <html lang>, content-language or og:locale. */
export function langInfo(declared: string | null | undefined, dirAttr: string | null | undefined, text: string): { lang?: string; dir?: "ltr" | "rtl" } {
  const guess = scriptLang(text);
  let lang = primary(declared);
  if (guess && (!lang || lang === "en" || (RTL.has(guess) && !RTL.has(lang)))) lang = guess; // an English tag on an Arabic page is a template default
  if (!lang) lang = wordLang(text); // nothing declared and Latin script: Spanish read in an English accent is worse than asking
  if (lang === "iw") lang = "he";
  const d = (dirAttr ?? "").trim().toLowerCase();
  const dir = d === "rtl" || d === "ltr" ? d : lang && RTL.has(lang) ? "rtl" : "ltr";
  if ((!lang || lang === "en") && dir === "ltr") return {};
  return { ...(lang && lang !== "en" ? { lang } : {}), dir };
}

/** The twin's own text, for the script test. */
export const sampleOf = (nodes: Twin["nodes"]) =>
  nodes
    .slice(0, 12)
    .map((n) => `${n.heading ?? ""} ${n.text ?? ""}`)
    .join(" ")
    .slice(0, 4000);

/** Set source.lang and source.dir from the declared values and the text. Returns the twin. */
export function withLang<T extends Twin>(twin: T, declared?: string | null, dirAttr?: string | null): T {
  Object.assign(twin.source, langInfo(declared, dirAttr, `${twin.source.title} ${sampleOf(twin.nodes)}`));
  return twin;
}

const NAMES = typeof Intl !== "undefined" && "DisplayNames" in Intl ? new Intl.DisplayNames(["en"], { type: "language" }) : null;
/** "Arabic" for "ar". */
export const languageName = (lang: string) => {
  try {
    return NAMES?.of(lang) ?? lang;
  } catch {
    return lang;
  }
};

/** English (or no language). Other languages: app/api/speak asks lib/server/voices.ts; one with no voice gets notReadable. */
export const readableAloud = (lang?: string | null) => !primary(lang) || primary(lang) === "en";
export const notReadable = (lang: string) => `This page is in ${languageName(lang)}. Arc can show it but cannot read it aloud yet.`;
