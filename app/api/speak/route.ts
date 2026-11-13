import { Busy, MAX_CHARS, DEFAULT_VOICE, speak } from "@/lib/server/kokoro";

export const runtime = "nodejs";

export async function GET(req: Request) {
  // ARC_KOKORO=off: a small host cannot run the model. No model work, and the client learns to stop asking.
  if (process.env.ARC_KOKORO === "off") return Response.json({ error: "kokoro off" }, { status: 503, headers: { "x-arc-kokoro": "off" } });
  const q = new URL(req.url).searchParams;
  const text = (q.get("text") ?? "").trim();
  const voice = q.get("voice") ?? DEFAULT_VOICE;
  if (!text || text.length > MAX_CHARS) return Response.json({ error: `text must be 1 to ${MAX_CHARS} characters` }, { status: 400 });
  if (!/^[a-z]{2}_[a-z]+$/.test(voice)) return Response.json({ error: "bad voice" }, { status: 400 });
  try {
    const wav = await speak(text, voice, req.signal);
    return new Response(new Uint8Array(wav), { headers: { "content-type": "audio/wav", "cache-control": "public, max-age=86400" } });
  } catch (e) {
    if (e instanceof Busy) return Response.json({ error: e.message }, { status: 503 });
    return Response.json({ error: e instanceof Error ? e.message : "speech failed" }, { status: 500 });
  }
}
