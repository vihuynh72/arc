// Raw Bright Data Web Unlocker call. Callers: lib/server/fetch.ts, app/api/search/route.ts.
const ENDPOINT = "https://api.brightdata.com/request";

export class UnlockerError extends Error {}

/** Fetch `url` through the Web Unlocker zone. Markdown by default; `markdown: false` returns the raw page text (HTML). */
export async function unlock(url: string, opts: { markdown?: boolean; signal?: AbortSignal } = {}): Promise<string> {
  const { BRIGHTDATA_API_TOKEN: token, BRIGHTDATA_UNLOCKER_ZONE: zone } = process.env;
  if (!token || !zone) throw new UnlockerError("Bright Data token or zone is not configured");
  const body: Record<string, string> = { zone, url, format: "raw", country: "us" };
  if (opts.markdown !== false) body.data_format = "markdown";
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  const text = await res.text();
  if (!res.ok) throw new UnlockerError(`Web Unlocker returned ${res.status}: ${text.slice(0, 200)}`);
  return text;
}
