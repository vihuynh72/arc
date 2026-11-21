// Khan Academy video page -> the YouTube video it plays, plus Khan's own title. Caller: lib/server/video.ts.
// The page itself sits behind a JavaScript challenge (plain fetch and Web Unlocker both get "Client Challenge"), so the first
// try is the GraphQL query the page runs; the last is the Bright Data Browser API, which renders the page (about 13 s).
import { chromium } from "playwright-core";
import { navigation, timed } from "./remote";

export const isKhanVideo = (url: string) => /^https?:\/\/(www\.)?khanacademy\.org\/.+\/v\/[^/?#]+/i.test(url);

// shortcut: a persisted-query hash read from the live site in Nov 2026; Khan can rotate it on a deploy, then the browser route runs.
const HASH = "183983073";

/** undefined: the query itself failed (stale hash, network); null: Khan answered and the path has no video. */
async function viaGraphql(path: string): Promise<{ id: string; title: string } | null | undefined> {
  const q = new URLSearchParams({ hash: HASH, lang: "en", variables: JSON.stringify({ path, countryCode: "US" }) });
  const res = await fetch(`https://www.khanacademy.org/api/internal/graphql/ContentRouteLessonAndContentData?${q}`, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) return undefined;
  const route = (await res.json())?.data?.contentRoute;
  if (!route) return undefined;
  const c = route.listedPathData?.content ?? route.unlistedPathData?.content;
  const id = c?.translatedYoutubeId || c?.youtubeId;
  return typeof id === "string" && /^[\w-]{11}$/.test(id) ? { id, title: c.translatedTitle ?? "" } : null;
}

async function viaBrowser(url: string): Promise<{ id: string; title: string } | null> {
  const wss = process.env.BRIGHTDATA_BROWSER_WSS;
  if (!wss) return null;
  navigation();
  const browser = timed(await chromium.connectOverCDP(wss, { timeout: 30_000 })); // its own session: the remote view's page is not touched
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    for (let k = 0; k < 20; k++) {
      const id = /(?:youtube(?:-nocookie)?\.com\/embed\/|"youtubeId":")([\w-]{11})/i.exec(await page.content())?.[1];
      if (id) return { id, title: (await page.title()).replace(/\s*\(video\)\s*\|\s*Khan Academy\s*$/i, "") };
      await page.waitForTimeout(1000);
    }
    return null;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** null when the page names no video. */
export async function khanVideo(url: string): Promise<{ id: string; title: string } | null> {
  const path = new URL(url).pathname.replace(/^\/|\/$/g, "");
  const found = await viaGraphql(path).catch(() => undefined);
  return found !== undefined ? found : await viaBrowser(url).catch(() => null);
}
