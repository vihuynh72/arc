// Text to model input ids for the non-English voices (lib/server/voices.ts), run inside lib/server/kokoro-worker.mjs.
// espeak-ng comes from @echogarden/espeak-ng-emscripten: the `phonemizer` package kokoro-js ships has only en_dict compiled in
// and refuses every other language. This build has all espeak-ng languages and writes "_" between phonemes, which gives the
// phoneme boundaries that the reference pipelines get from a tie character.
// Plain .mjs: the worker loads it as is (see kokoro-worker.mjs). Checked by scripts/checks/voices.ts against fixed vectors.
import Module from "@echogarden/espeak-ng-emscripten";

let es; // { m, w, voice }
async function espeak() {
  if (!es) {
    es = Module().then((m) => ({ m, w: new m.eSpeakNGWorker(), voice: "" }));
  }
  return es;
}

/** espeak-ng IPA for one stretch of text without punctuation: words split by spaces, phonemes by "_". */
export async function espeakIpa(text, voice) {
  const e = await espeak();
  if (e.voice !== voice) {
    if (e.w.set_voice(voice) !== 0) throw new Error(`espeak voice ${voice} missing`);
    e.voice = voice;
  }
  const p = e.w.text_to_phonemes(text, 1).ptr;
  let end = p;
  while (e.m.HEAPU8[end]) end++;
  return new TextDecoder()
    .decode(e.m.HEAPU8.subarray(p, end))
    .replace(/\([a-z-]+\)/g, "") // language switch flags, e.g. "(en)" around an English word: phonemes kept, flag removed
    .replace(/\|/g, " ") // espeak's own clause marks: punctuation is handled by the caller
    .replace(/\s+/g, " ")
    .trim();
}

// The punctuation the reference phonemizers keep (phonemizer's default marks, as kokoro-js uses).
const PUNCT = /(\s*[;:,.!?¡¿—…"«»“”(){}[\]]+\s*)+/g;
// Han characters in a Korean or Vietnamese text (hanja glosses, "quang hợp (光合)") come out of espeak as the English words
// "Chinese letter" for each one: they are dropped, and so are brackets left empty.
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
/** Pieces of text, punctuation runs kept apart: [{ text, punct }]. */
function pieces(text, voice) {
  if (voice !== "cmn") text = text.replace(HAN, " ").replace(/[(（]\s*[,、]?\s*[)）]/g, " ");
  const out = [];
  let at = 0;
  for (const m of text.matchAll(PUNCT)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), punct: false });
    out.push({ text: m[0], punct: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), punct: false });
  return out;
}

// misaki EspeakG2P (Kokoro's reference G2P for es, fr, hi, it, pt-br), Kokoro v1.0 settings: tie-joined pairs to single symbols.
const E2M = [
  ["a^ɪ", "I"], ["a^ʊ", "W"], ["d^z", "ʣ"], ["d^ʒ", "ʤ"], ["e^ɪ", "A"], ["o^ʊ", "O"], ["ə^ʊ", "Q"], ["s^s", "S"], ["t^s", "ʦ"], ["t^ʃ", "ʧ"], ["ɔ^ɪ", "Y"],
].sort((a, b) => (a[0] < b[0] ? -1 : 1));
/** One espeak phoneme ("ˈaɪ") as misaki writes it: ties between its letters, then E2M, then ties removed. */
const kokoroUnit = (u) => {
  let s = [...u].join("^");
  for (const [a, b] of E2M) s = s.replaceAll(a, b);
  return s.replaceAll("^", "").replaceAll("-", ""); // v1.0 drops hyphens
};

/** Kokoro phoneme string for text in an espeak language, as misaki's EspeakG2P makes it (preserve_punctuation, with_stress). */
export async function kokoroPhonemes(text, voice) {
  // Angles to curly quotes, parentheses to angles (and back at the end), as misaki does.
  const t = text.replace(/«/g, "“").replace(/»/g, "”").replace(/\(/g, "«").replace(/\)/g, "»");
  let out = "";
  for (const p of pieces(t, voice)) {
    if (p.punct) out += p.text;
    else out += (await espeakIpa(p.text, voice)).split(" ").map((w) => w.split("_").map(kokoroUnit).join("")).join(" ");
  }
  return out.replace(/«/g, "(").replace(/»/g, ")").replace(/\s+/g, " ").trim();
}

/** Piper phoneme list (piper1-gpl phonemize_espeak): IPA per clause + its terminator, NFD codepoints, known vowel clusters merged. */
export async function piperPhonemes(text, voice, clusters) {
  const chars = [];
  for (const p of pieces(text, voice)) {
    if (p.punct) {
      // espeak reports one terminator per clause; Piper appends it, plus a space after , : ;
      const term = /[.]/.test(p.text) ? "." : /[?¿]/.test(p.text) ? "?" : /[!¡]/.test(p.text) ? "!" : /;/.test(p.text) ? ";" : /:/.test(p.text) ? ":" : /[,—…]/.test(p.text) ? "," : "";
      if (!chars.length) continue;
      if (chars.at(-1) === " ") chars.pop();
      if (term) chars.push(term);
      chars.push(" ");
      continue;
    }
    const ipa = (await espeakIpa(p.text, voice)).replaceAll("_", "");
    if (ipa) chars.push(...ipa.normalize("NFD"));
  }
  while (chars.at(-1) === " ") chars.pop();
  if (!clusters?.length) return chars;
  const max = Math.max(...clusters.map((c) => c.length));
  const set = new Set(clusters.map((c) => c.join("\u0000")));
  const out = [];
  for (let i = 0; i < chars.length; ) {
    let n = Math.min(max, chars.length - i);
    for (; n > 1 && !set.has(chars.slice(i, i + n).join("\u0000")); n--);
    out.push(n > 1 ? chars.slice(i, i + n).join("") : chars[i]);
    i += Math.max(1, n);
  }
  return out;
}

/** Piper ids: ^ _ p _ p _ ... $ (phonemes missing from the map are skipped, as Piper does). */
export function piperIds(phonemes, map) {
  const ids = [...map["^"], ...map["_"]];
  for (const p of phonemes) if (map[p]) ids.push(...map[p], ...map["_"]);
  ids.push(...map["$"]);
  return ids;
}

// --- synthesis (onnxruntime-node is the runtime @huggingface/transformers already installs for Kokoro) ---

/** Kokoro in another espeak language: misaki phonemes, Kokoro's own tokenizer, that language's voice style. Over 510 phonemes
 * (Kokoro's context) is cut at a pause or a space and made in parts, rather than truncated as the reference does. */
export async function kokoroSpeak(tts, text, voice, espeakVoice) {
  const parts = [];
  for (let ps = await kokoroPhonemes(text, espeakVoice); ps; ) {
    let cut = ps.length;
    if (ps.length > 500) {
      const head = ps.slice(0, 500);
      cut = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "), head.lastIndexOf(". "));
      if (cut < 200) cut = head.lastIndexOf(" ");
      if (cut < 1) cut = 500;
      cut++;
    }
    const { input_ids } = tts.tokenizer(ps.slice(0, cut), { truncation: true });
    parts.push((await tts.generate_from_ids(input_ids, { voice })).audio);
    ps = ps.slice(cut).trim();
  }
  return { audio: join(parts), rate: 24000 };
}

const join = (parts) => {
  if (parts.length === 1) return parts[0];
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, at), (at += p.length);
  return out;
};

/** A Piper voice: { session, config }. */
export async function piperLoad(ort, onnxPath, configJson, threads) {
  const session = await ort.InferenceSession.create(onnxPath, { intraOpNumThreads: threads || 0, executionProviders: ["cpu"] });
  return { session, config: configJson };
}

/** Piper VITS (piper1-gpl voice.py): one run over the sentence, scales from the voice's config, audio peak-normalised. */
export async function piperSpeak(ort, { session, config }, text) {
  const ph =
    config.phoneme_type === "text" ? [...text.normalize("NFD")] : await piperPhonemes(text, config.espeak.voice, config.vowel_clusters);
  const ids = piperIds(ph, config.phoneme_id_map);
  const inf = config.inference ?? {};
  const feeds = {
    input: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor("float32", Float32Array.from([inf.noise_scale ?? 0.667, inf.length_scale ?? 1, inf.noise_w ?? 0.8]), [3]),
  };
  if (config.num_speakers > 1) feeds.sid = new ort.Tensor("int64", BigInt64Array.from([BigInt(config.default_speaker_id ?? 0)]), [1]);
  const out = await session.run(feeds);
  const audio = Float32Array.from(out[session.outputNames[0]].data);
  let peak = 0;
  for (const v of audio) peak = Math.max(peak, Math.abs(v));
  if (peak > 1e-8) for (let i = 0; i < audio.length; i++) audio[i] /= peak;
  return { audio, rate: config.audio?.sample_rate ?? 22050 };
}
