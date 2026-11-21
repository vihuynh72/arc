// YouTube link handling and oEmbed (public, no key). Callers: app/api/preview/route.ts (youtubeOembed), lib/server/video.ts (all).
import { cleanTitle } from "../parse/title";

/** The 11-character video id of any YouTube link form (watch?v=, youtu.be/, /shorts/, /embed/, /live/, /v/; m., music., www.); null otherwise. */
export function youtubeId(link: string): string | null {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, "");
  let id: string | null | undefined;
  if (host === "youtu.be") id = u.pathname.split("/")[1];
  else if (host === "youtube.com") id = /^\/(shorts|embed|live|v)\/([^/]+)/.exec(u.pathname)?.[2] ?? (u.pathname === "/watch" ? u.searchParams.get("v") : null);
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/** One address per video: the cache key, the length check, the title lookup and the model call all use this. */
export const youtubeCanonical = (id: string) => `https://www.youtube.com/watch?v=${id}`;

export async function youtubeOembed(url: string, signal: AbortSignal): Promise<{ title: string; author: string } | null> {
  const id = youtubeId(url);
  const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(id ? youtubeCanonical(id) : url)}&format=json`, { signal });
  if (!res.ok) return null;
  const d = (await res.json()) as { title?: string; author_name?: string };
  return d.title ? { title: cleanTitle(d.title), author: d.author_name ?? "" } : null;
}
