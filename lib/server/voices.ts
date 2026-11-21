// Which voice reads which language. Dependency-free table (no imports), used by app/api/speak and lib/server/kokoro.ts.
// Chosen by round trip (synthesise 9 Wikipedia photosynthesis sentences, transcribe with Gemini, character error rate), Nov 2026:
// local beats paid unless the local CER is over 0.05 and over twice the paid one. Kokoro beats Piper when within 0.01 (on disk
// already, same voice family as English). Measured CER: es kokoro .004 (piper .001), fr .015 (.025), it .022 (.036),
// pt .011 (.021), hi .042 (.045); piper de .039, ru .039, ko .016, tr .011, nl .039, pl .011, uk .049, id .007;
// paid: ja .030, ar .017 (piper .107, no diacritics), vi .011 (piper .107), zh .049 (piper huayan .089, licence unknown).
// The paid languages keep their Piper voice as a fallback (huayan: licence unknown; kareem: dataset licence "see URL").
// Kokoro zh through espeak was unusable (.61): Kokoro's Chinese needs its Python G2P. Checked by scripts/checks/voices.ts.
export interface PiperFile {
  path: string; // under https://huggingface.co/rhasspy/piper-voices/resolve/main/
  size: number;
  md5: string; // size and md5 as rhasspy/piper-voices voices.json lists them
  jsonSize: number;
  jsonMd5: string;
}
export interface Voice {
  engine: "kokoro" | "piper" | "gemini";
  voice: string; // Kokoro voice, Piper voice name, or Gemini prebuilt voice
  espeak?: string; // Kokoro in another language: the espeak-ng language for its phonemes
  file?: PiperFile; // Piper: downloaded on first use into .cache/voices/
  fallback?: Voice; // paid voice only: the weaker local voice used when Gemini fails (quota, spending cap, network)
}

export const ENGLISH: Voice = { engine: "kokoro", voice: "af_bella" };
const kokoro = (voice: string, espeak: string): Voice => ({ engine: "kokoro", voice, espeak });
const piper = (voice: string, path: string, size: number, md5: string, jsonSize: number, jsonMd5: string): Voice => ({
  engine: "piper",
  voice,
  file: { path, size, md5, jsonSize, jsonMd5 },
});
const PAID: Voice = { engine: "gemini", voice: "Sulafat" }; // the voice Arc's Live answers use

export const VOICES: Record<string, Voice> = {
  en: ENGLISH,
  es: kokoro("ef_dora", "es"),
  fr: kokoro("ff_siwis", "fr"),
  it: kokoro("if_sara", "it"),
  pt: kokoro("pf_dora", "pt-br"), // Brazilian: Kokoro has no European Portuguese voice
  hi: kokoro("hf_alpha", "hi"),
  // Piper. Licences (MODEL_CARD): thorsten CC0, denis CC0, kss CC BY-NC-SA 4.0, dfki CC BY-NC-SA 4.0, pim CC0, gosia CC0,
  // ukrainian_tts CC0, news_tts "see URL" (doubtful).
  de: piper("de_DE-thorsten-medium", "de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx", 63221984, "e2fe077168bfe802e951e717dfa85873", 6455, "dac4f7530c978753aeb40f214245659f"),
  ru: piper("ru_RU-denis-medium", "ru/ru_RU/denis/medium/ru_RU-denis-medium.onnx", 63221984, "0fdddcfaf23c01e9804bab8004e7d725", 6196, "f4932d114829349b68007cbf4ee5147e"),
  ko: piper("ko_KR-kss-medium", "ko/ko_KR/kss/medium/ko_KR-kss-medium.onnx", 63221984, "5af4e532e1845ff15d856c2cb05f5c3d", 6222, "4bf2dd167ed2f8b971da24a9c4cb2891"),
  tr: piper("tr_TR-dfki-medium", "tr/tr_TR/dfki/medium/tr_TR-dfki-medium.onnx", 63201294, "f51287b350a042dd8d67b2b215145e5a", 4960, "683c97d5bf7588abb4d7b9ff556c9466"),
  nl: piper("nl_NL-pim-medium", "nl/nl_NL/pim/medium/nl_NL-pim-medium.onnx", 63221984, "c494ac660a19ab87c7099ca66f619328", 6288, "0ead1c021e41c7c3a3889010c5357c75"),
  pl: piper("pl_PL-gosia-medium", "pl/pl_PL/gosia/medium/pl_PL-gosia-medium.onnx", 63221984, "5c52ba9b689945eb1b4efa7531d6cb49", 6131, "5fc8335375e53d5bee8bb99363a78fe0"),
  uk: piper("uk_UA-ukrainian_tts-medium", "uk/uk_UA/ukrainian_tts/medium/uk_UA-ukrainian_tts-medium.onnx", 76735663, "3366c3d4f31cb77966fb14d042956b4f", 2002, "3bf9b2b1fcc8e599947cdda4af130498"),
  id: piper("id_ID-news_tts-medium", "id/id_ID/news_tts/medium/id_ID-news_tts-medium.onnx", 62950044, "17de01db7ac654655436b6e509893c72", 5050, "c023cfa031cc9ed4cf5dd8d2ef1e48ed"),
  // Paid (gemini-3.8-flash-lite-tts, about 25 output tokens per second of speech): no acceptable local voice.
  ja: PAID,
  zh: { ...PAID, fallback: piper("zh_CN-huayan-medium", "zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx", 63201294, "40cdb7930ff91b81574d5f0489e076ea", 4822, "1fda3ec1d0d3a5a74064397ea8fe0af0") },
  ar: { ...PAID, fallback: piper("ar_JO-kareem-medium", "ar/ar_JO/kareem/medium/ar_JO-kareem-medium.onnx", 63201294, "c0697df8a7fb180079cc5ac523f91a8e", 5024, "dd70b31eb5a395907241b1e5367ace3a") },
  vi: { ...PAID, fallback: piper("vi_VN-vais1000-medium", "vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx", 63221984, "8a5a85614964fd22ff77694a99048d12", 6197, "e134ef2bd72ef0a316de9b7285c52c93") },
};

/** The voice for a primary language subtag ("es"), or undefined when Arc has none (the route then refuses with one line). */
export const voiceFor = (lang?: string | null): Voice | undefined => (lang ? VOICES[lang.toLowerCase()] : undefined);
