import { languageName, notReadable, primary, scriptLang } from "@/lib/parse/lang";
import { Busy, MAX_CHARS, speak, spokenBy, voiceReady } from "@/lib/server/kokoro";
import { ENGLISH, voiceFor } from "@/lib/server/voices";

export const runtime = "nodejs";

/** What to say, from the JSON body only (POST, lib/client/clip.ts): a page's sentences must never sit in a URL, which every
 * request log, proxy and browser history records. A GET is refused. */
type Ask = { text?: unknown; voice?: unknown; lang?: unknown; prio?: unknown };
const str = (v: unknown) => (typeof v === "string" ? v : null);

export function GET() {
  return Response.json({ error: "POST the text as JSON: {text}." }, { status: 405, headers: { allow: "POST" } });
}

async function post(req: Request) {
  if (Number(req.headers.get("content-length")) > 8192) return Response.json({ error: "too large" }, { status: 413 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ error: "JSON body expected" }, { status: 400 });
  return answer(req, body as Ask);
}

// The visitor's browser may read English with its own Kokoro (lib/client/localVoice.ts): by default only when this server has none.
// Opt-in: a first visit downloads about 331 MB of voice model onto the visitor's machine, so the owner chooses it at deploy.
const browserVoice = () => process.env.ARC_BROWSER_VOICE === "on";

export async function POST(req: Request) {
  const r = await post(req);
  if (browserVoice()) r.headers.set("x-arc-browser-voice", "on");
  return r;
}

async function answer(req: Request, a: Ask) {
  // ARC_KOKORO=off: a small host cannot run the model. No model work, and the client learns to stop asking (the Gemini voice reads instead).
  if (process.env.ARC_KOKORO === "off") return Response.json({ error: "kokoro off" }, { status: 503, headers: { "x-arc-kokoro": "off" } });
  const text = (str(a.text) ?? "").trim();
  const asked = str(a.voice) ?? ENGLISH.voice;
  if (!text || text.length > MAX_CHARS) return Response.json({ error: `text must be 1 to ${MAX_CHARS} characters` }, { status: 400 });
  if (!/^[a-z]{2}_[a-z]+$/.test(asked)) return Response.json({ error: "bad voice" }, { status: 400 });
  // `lang` is source.lang, sent only for the page's own words; without it the script of the text decides. The voice for that
  // language comes from lib/server/voices.ts; a language with none is refused with one sentence the client speaks instead.
  const lang = primary(str(a.lang)) ?? scriptLang(text);
  const voice = !lang || lang === "en" ? { ...ENGLISH, voice: asked } : voiceFor(lang);
  if (!voice) return Response.json({ error: "language", lang, say: notReadable(lang!) }, { status: 422, headers: { "x-arc-lang": "unsupported" } });
  const prio = Math.min(9, Math.max(0, Number(a.prio) || 0)); // 0 = playing next; prefetches send 1, 2, ...
  // The paid voice makes only what is about to be read: a warm-up or language probe (prio 3 and up) costs nothing.
  if (voice.engine === "gemini" && prio > 2) return new Response(null, { status: 204 });
  // A voice still downloading: one English line for the student, and the client asks again.
  if (!voiceReady(voice))
    return Response.json({ loading: true, lang, say: `Getting the ${languageName(lang!)} voice. One moment.` }, { status: 202, headers: { "x-arc-voice": "loading" } });
  try {
    const wav = await speak(text, voice, req.signal, prio);
    const by = spokenBy.get(wav) ?? voice;
    return new Response(new Uint8Array(wav), { headers: { "content-type": "audio/wav", "cache-control": "public, max-age=86400", "x-arc-voice": `${by.engine}/${by.voice}` } });
  } catch (e) {
    if (e instanceof Busy) return Response.json({ error: e.message }, { status: 503 });
    // The paid voice is down and this language has no local one: refuse once, like a language with no voice, instead of silence.
    if (voice.engine === "gemini" && !voice.fallback && !req.signal.aborted)
      return Response.json({ error: "language", lang, say: `This page is in ${languageName(lang!)}. Arc's ${languageName(lang!)} voice is not available right now.` }, { status: 422, headers: { "x-arc-lang": "unsupported" } });
    return Response.json({ error: e instanceof Error ? e.message : "speech failed" }, { status: 500 });
  }
}
