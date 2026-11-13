// YouTube oEmbed (public, no key): title and channel in well under a second. Caller: app/api/preview/route.ts.
export async function youtubeOembed(url: string, signal: AbortSignal): Promise<{ title: string; author: string } | null> {
  const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, { signal });
  if (!res.ok) return null;
  const d = (await res.json()) as { title?: string; author_name?: string };
  return d.title ? { title: d.title, author: d.author_name ?? "" } : null;
}
