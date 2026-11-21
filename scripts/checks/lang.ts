// Offline check for lib/parse/lang.ts: source.lang and source.dir from the declared values and the script of the text.
import assert from "node:assert";
import { langInfo, notReadable, readableAloud, scriptLang } from "../../lib/parse/lang";
import { parseHtml } from "../../lib/parse/html";
import { parseText } from "../../lib/parse/text";

const AR = "التمثيل الضوئي هو عملية تحويل الطاقة الضوئية إلى طاقة كيميائية تقوم بها النباتات والطحالب.";
const JA = "光合成は、光エネルギーを化学エネルギーに変換して生体に必要な有機物を作る反応である。";
const ES = "La fotosíntesis es el proceso por el cual las plantas convierten la luz solar en energía química.";
const EN = "Photosynthesis is the process by which plants turn sunlight into chemical energy for growth.";

export default function check() {
  assert.equal(scriptLang(AR), "ar");
  assert.equal(scriptLang("לימוד פוטוסינתזה בבית הספר הוא חשוב מאוד לכל תלמיד וגם למורה"), "he");
  assert.equal(scriptLang(JA), "ja");
  assert.equal(scriptLang("光合作用是植物把光能转换成化学能的过程这是一个很重要的生物学概念"), "zh");
  assert.equal(scriptLang("광합성은 식물이 빛 에너지를 화학 에너지로 바꾸는 과정이며 매우 중요합니다"), "ko");
  assert.equal(scriptLang(ES), undefined, "a Latin-script language is only known when declared");
  assert.equal(scriptLang(EN + " " + AR.slice(0, 20)), undefined, "a little foreign script in English text is not a language");

  assert.deepEqual(langInfo("en-US", null, EN), {});
  assert.deepEqual(langInfo(undefined, null, EN), {});
  assert.deepEqual(langInfo("es", null, ES), { lang: "es", dir: "ltr" });
  assert.deepEqual(langInfo("es_MX", "", ES), { lang: "es", dir: "ltr" });
  assert.deepEqual(langInfo("ar", "rtl", AR), { lang: "ar", dir: "rtl" });
  assert.deepEqual(langInfo("ar", null, AR), { lang: "ar", dir: "rtl" }, "rtl follows the language when dir is not set");
  assert.deepEqual(langInfo("en", null, AR), { lang: "ar", dir: "rtl" }, "an English tag on an Arabic page is a template default");
  assert.deepEqual(langInfo(null, null, JA), { lang: "ja", dir: "ltr" });
  assert.deepEqual(langInfo("en", "rtl", EN), { dir: "rtl" });

  const page = (attrs: string, body: string) => `<html ${attrs}><head><title>T</title></head><body><main><h1>Title</h1><p>${body.repeat(4)}</p></main></body></html>`;
  assert.deepEqual(parseHtml(page('lang="ar" dir="rtl"', AR), "https://ar.example.org/a").source.dir, "rtl");
  assert.equal(parseHtml(page('lang="es"', ES), "https://es.example.org/a").source.lang, "es");
  assert.equal(parseHtml(page("", JA), "https://x.example.org/a").source.lang, "ja");
  assert.equal(parseHtml(page("", ES), "https://x.example.org/a", "es-ES").source.lang, "es", "the content-language header");
  const en = parseHtml(page('lang="en"', EN), "https://x.example.org/a").source;
  assert.ok(!("lang" in en) && !("dir" in en));
  assert.equal(parseText(AR + "\n\n" + AR, "https://x.example.org/a.txt").source.dir, "rtl");

  assert.ok(readableAloud(undefined) && readableAloud("en") && readableAloud("en-GB") && !readableAloud("es") && !readableAloud("ar"));
  assert.equal(notReadable("ar"), "This page is in Arabic. Arc can show it but cannot read it aloud yet.");
}
