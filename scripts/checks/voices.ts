// Offline check for the multilingual voices: the language -> engine table (lib/server/voices.ts), phonemes and ids against fixed
// vectors (lib/server/g2p.mjs, the misaki and piper1-gpl rules), the stop-word detector (lib/parse/lang.ts) and sentence
// splitting for Chinese, Japanese, Arabic and Hindi punctuation (lib/client/reader.ts).
import assert from "node:assert";
import { VOICES, voiceFor } from "../../lib/server/voices";
import { kokoroPhonemes, piperIds, piperPhonemes } from "../../lib/server/g2p.mjs";
import { langInfo, wordLang } from "../../lib/parse/lang";
import { splitSentences } from "../../lib/client/reader";

const EN_LATIN =
  "The genus Escherichia includes Escherichia coli, while Bacillus subtilis and Saccharomyces cerevisiae are model organisms. Homo sapiens, Arabidopsis thaliana and Drosophila melanogaster are studied in labs, and Mus musculus is used in medicine. These species are named in Latin, but the text around them is English and must be read in English.";
const EN_FRENCH =
  "The chef served the hors d'oeuvre with a certain joie de vivre, and the critics called the menu a tour de force. It was, par excellence, the place to be; a rendezvous for the avant-garde, where déjà vu was the only cliché and the raison d'être of the café was good coffee for everyone.";
const PASSAGES: [string, string][] = [
  ["es", "La fotosíntesis es el proceso por el cual las plantas, las algas y algunas bacterias convierten la energía de la luz en energía química. Este proceso ocurre en los cloroplastos y produce oxígeno como subproducto, que es liberado a la atmósfera."],
  ["fr", "La photosynthèse est le processus par lequel les plantes, les algues et certaines bactéries captent l'énergie de la lumière. Cette énergie est ensuite utilisée pour fabriquer des sucres à partir du dioxyde de carbone et de l'eau, et l'oxygène est libéré."],
  ["de", "Die Photosynthese ist ein Prozess, bei dem Pflanzen, Algen und einige Bakterien die Energie des Lichts nutzen. Dabei wird aus Kohlendioxid und Wasser Zucker gebildet, und als Nebenprodukt wird Sauerstoff an die Umgebung abgegeben, der für die Atmung wichtig ist."],
  ["pt", "A fotossíntese é o processo pelo qual as plantas, as algas e algumas bactérias captam a energia da luz. Essa energia é usada para produzir açúcares a partir do dióxido de carbono e da água, e o oxigênio é liberado para a atmosfera como subproduto."],
  ["it", "La fotosintesi è il processo con cui le piante, le alghe e alcuni batteri catturano l'energia della luce. Questa energia viene usata per produrre zuccheri a partire dall'anidride carbonica e dall'acqua, e l'ossigeno viene liberato nell'atmosfera come prodotto."],
  ["nl", "Fotosynthese is het proces waarbij planten, algen en sommige bacteriën de energie van het licht gebruiken. Daarbij wordt uit koolstofdioxide en water suiker gemaakt, en als bijproduct komt er zuurstof vrij die voor de ademhaling van dieren van belang is."],
  ["tr", "Fotosentez, bitkilerin ve bazı bakterilerin ışık enerjisini kimyasal enerjiye dönüştürdüğü bir süreçtir. Bu süreç sırasında karbondioksit ve su kullanılarak şeker üretilir ve bir yan ürün olarak oksijen atmosfere verilir, bu da canlılar için çok önemlidir."],
  ["pl", "Fotosynteza to proces, w którym rośliny, glony i niektóre bakterie wykorzystują energię światła. W trakcie tego procesu z dwutlenku węgla i wody powstaje cukier, a jako produkt uboczny do atmosfery jest uwalniany tlen, który jest potrzebny do oddychania."],
  ["id", "Fotosintesis adalah proses yang dilakukan oleh tumbuhan, alga, dan beberapa bakteri untuk mengubah energi cahaya menjadi energi kimia. Dalam proses ini karbon dioksida dan air diubah menjadi gula, dan oksigen dilepaskan ke udara sebagai hasil sampingan yang penting."],
  ["vi", "Quang hợp là quá trình mà thực vật, tảo và một số vi khuẩn sử dụng năng lượng ánh sáng để tạo ra chất hữu cơ. Trong quá trình này, khí cacbonic và nước được chuyển thành đường, và khí oxy được thải ra môi trường, điều này rất quan trọng cho sự sống của các loài."],
];

export default async function check() {
  // The table: which engine reads which language, and what is refused.
  assert.deepEqual(voiceFor("es"), { engine: "kokoro", voice: "ef_dora", espeak: "es" });
  assert.equal(voiceFor("de")?.engine, "piper");
  assert.equal(voiceFor("ja")?.engine, "gemini");
  assert.equal(voiceFor("en")?.voice, "af_bella");
  assert.equal(voiceFor("th"), undefined, "no voice for Thai: the route keeps its honest refusal");
  for (const [lang, v] of Object.entries(VOICES)) {
    if (v.engine !== "piper") continue;
    const f = v.file!;
    assert.ok(f.path.endsWith(`/${v.voice}.onnx`) && f.path.startsWith(`${lang}/`), lang);
    assert.ok(/^[0-9a-f]{32}$/.test(f.md5) && /^[0-9a-f]{32}$/.test(f.jsonMd5) && f.size > 1e7, lang);
  }

  // Kokoro phonemes as misaki's EspeakG2P writes them: E2M diphthongs (aɪ -> I, eɪ -> A), punctuation kept, parentheses kept.
  assert.equal(await kokoroPhonemes("La fotosíntesis es el proceso (vital), ¿no?", "es"), "la fˌotosˈintesis ˈes el pɾoθˈeso (bitˈal), ¿nˈo?");
  assert.equal(await kokoroPhonemes("Hay seis tipos.", "es"), "ˈI sˈAs tˈipos.");
  assert.equal(await kokoroPhonemes("Les enfants ont un ordinateur.", "fr"), "lez ɑ̃fˈɑ̃z ˈɔ̃t œ̃n ɔʁdinatˈœʁ.");
  // Piper: NFD codepoints, clause terminator then a space after a comma, known vowel clusters merged; ids ^ _ p _ ... $.
  const cl = [["a", "ɪ"], ["a", "ʊ"], ["e", "ɪ"], ["o", "ʊ"], ["ɔ", "ɪ"]];
  assert.deepEqual(await piperPhonemes("Bei der Photosynthese, frei.", "de", cl), ["b", "aɪ", " ", "d", "ɛ", "ɾ", " ", "f", "ˌ", "o", "ː", "t", "o", "ː", "z", "ˈ", "ʏ", "n", "t", "ə", "s", "ə", ",", " ", "f", "r", "ˈ", "aɪ", "."]);
  assert.deepEqual(piperIds(["a", "b", "ɪ"], { "^": [1], _: [0], $: [2], a: [14], b: [15] }), [1, 0, 14, 0, 15, 0, 2], "a phoneme missing from the map is skipped");
  // Hanja in Korean text is dropped, not read as "Chinese letter".
  assert.ok(!(await piperPhonemes("이 화학 에너지(光合成)는", "ko")).join("").includes("tʃ"));

  // The detector: undeclared Latin-script pages in each voiced language, and English that must stay English.
  for (const [lang, text] of PASSAGES) assert.equal(wordLang(text), lang, lang);
  assert.equal(wordLang(EN_LATIN), undefined, "Latin scientific names stay English");
  assert.equal(wordLang(EN_FRENCH), undefined, "French loanwords stay English");
  assert.equal(wordLang("La fotosíntesis es un proceso."), undefined, "too short to tell");
  assert.deepEqual(langInfo(undefined, null, PASSAGES[0][1]), { lang: "es", dir: "ltr" });
  assert.deepEqual(langInfo("en", null, PASSAGES[0][1]), {}, "a declared language is never second-guessed by word counts");
  assert.deepEqual(langInfo(undefined, null, EN_FRENCH), {});

  // Sentences in scripts without spaces or capitals.
  assert.deepEqual(splitSentences("光合作用是植物把光能转换成化学能的过程。这是一个很重要的生物学概念，学生都要学习。叶绿体在细胞里面。"), [
    "光合作用是植物把光能转换成化学能的过程。这是一个很重要的生物学概念，学生都要学习。",
    "叶绿体在细胞里面。",
  ]);
  assert.equal(splitSentences("光合成は、光エネルギーを化学エネルギーに変換する反応である。植物や藻類が行う。").length, 2);
  assert.equal(splitSentences("التمثيل الضوئي هو عملية تحويل الطاقة الضوئية إلى طاقة كيميائية. تقوم بها النباتات والطحالب وبعض البكتيريا.").length, 2);
  assert.equal(splitSentences("प्रकाश-संश्लेषण एक बहुत महत्वपूर्ण प्रक्रिया है। पौधे सूर्य के प्रकाश से भोजन बनाते हैं।").length, 2);
  assert.equal(splitSentences("La fotosíntesis ocurre en las hojas verdes. ¿Por qué es importante para la vida?").length, 2);
  assert.equal(splitSentences("Photosynthesis happens in leaves, e.g. in the chloroplasts. It makes sugar from light.").length, 2, "English unchanged");
}
