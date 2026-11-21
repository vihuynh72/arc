// Raw Bright Data calls: Web Unlocker (lib/server/fetch.ts, app/api/search/route.ts) and the Google SERP zone (search).
import { checkBrightData, recordBrightData } from "@/lib/server/budget";
import { BlockedUrl, checkUrl } from "@/lib/server/safeFetch";

const ENDPOINT = "https://api.brightdata.com/request";

export class UnlockerError extends Error {}

/** Fetch `url` through the Web Unlocker zone. Markdown by default; `markdown: false` returns the raw page text (HTML). */
export async function unlock(url: string, opts: { markdown?: boolean; signal?: AbortSignal } = {}): Promise<string> {
  const { BRIGHTDATA_API_TOKEN: token, BRIGHTDATA_UNLOCKER_ZONE: zone } = process.env;
  if (!token || !zone) throw new UnlockerError("Bright Data token or zone is not configured");
  const c = await checkUrl(url); // never hand Bright Data an address Arc itself would refuse
  if (!c.ok) throw new BlockedUrl(c.why);
  checkBrightData("unlocker"); // today's cap: throws BudgetError with a line the student can hear
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
  recordBrightData("unlocker"); // billed per successful request
  return text;
}

/** Google results through the Bright Data SERP zone (parsed JSON via brd_json=1). Caller: app/api/search/route.ts. */
export async function serp(query: string, signal?: AbortSignal): Promise<{ title: string; link: string; description?: string }[]> {
  const token = process.env.BRIGHTDATA_API_TOKEN;
  if (!token) throw new UnlockerError("Bright Data token is not configured");
  const zone = process.env.BRIGHTDATA_SERP_ZONE || "serp_api1";
  checkBrightData("serp");
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&gl=us&brd_json=1`;
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ zone, url, format: "raw" }),
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new UnlockerError(`SERP returned ${res.status}`);
  recordBrightData("serp");
  const organic = (JSON.parse(text) as { organic?: { title: string; link: string; description?: string }[] }).organic ?? []; // empty or non-JSON body throws
  if (!organic.length) throw new UnlockerError("SERP returned no results");
  return organic;
}

/** An image (or any binary) through the Web Unlocker, read up to `max` bytes. Caller: lib/server/images.ts. */
export async function unlockBytes(url: string, opts: { signal?: AbortSignal; max: number }): Promise<Uint8Array | null> {
  const { BRIGHTDATA_API_TOKEN: token, BRIGHTDATA_UNLOCKER_ZONE: zone } = process.env;
  if (!token || !zone || !(await checkUrl(url)).ok) return null;
  try {
    checkBrightData("unlocker");
  } catch {
    return null; // over today's cap: the image is simply not available
  }
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ zone, url, format: "raw", country: "us" }),
    signal: opts.signal,
  });
  if (!res.ok) {
    await res.body?.cancel();
    return null;
  }
  recordBrightData("unlocker");
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.length > opts.max ? null : buf;
}
