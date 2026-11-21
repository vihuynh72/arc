// The one way the app asks /api/speak for a clip. POST with the text in the body, never GET with it in the URL: Arc reads
// private pages, and a URL is written to every request log (Next's, a proxy's, a host's). Used by reader.ts and voice.ts.
export const postSpeak = (text: string, o: { voice?: string; prio?: number; lang?: string } = {}, signal?: AbortSignal) =>
  fetch("/api/speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, ...o }), signal });
