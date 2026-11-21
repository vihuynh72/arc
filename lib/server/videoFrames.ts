// Pictures from a lecture video. The YouTube player is a cross-origin iframe in the student's browser, so its pixels cannot be
// read there; instead a browser on the server opens the video's embed page, seeks the <video> element to the moment, pauses,
// and screenshots that element alone (player controls, captions and consent dialogs hidden with CSS, never clicked).
// Route: local Chrome first (measured on this laptop: page 1.7 s, then about 0.4 s a frame); the Bright Data Browser API when
// there is no local Chrome (a small Linux host) or it fails (page about 11 s, then 1.2 to 2.3 s a frame).
// Frames land in .cache/video/<id>/frames/<node>.jpg with index.json beside them. Caller: lib/server/videoQueue.ts.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright-core";
import { navigation, remoteBrowser } from "./remote";

export type FrameInfo = { at: number; visual: string };
type Open = { page: Page; route: "local chrome" | "bright data"; timer?: NodeJS.Timeout };
type State = { local?: Promise<Browser>; pages: Map<string, Promise<Open>>; chain: Promise<unknown> };
const g = globalThis as unknown as { __arcFrames?: State };
const F: State = (g.__arcFrames ??= { pages: new Map(), chain: Promise.resolve() });

/** A plain sentence for the student (the video cannot be shown, an advert will not end, and so on). */
export class FrameError extends Error {}

const dir = (vid: string) => `.cache/video/${vid}/frames`;
export const framePath = (vid: string, node: string) => `${dir(vid)}/${node}.jpg`;

export async function frameIndex(vid: string): Promise<Record<string, FrameInfo>> {
  try {
    return JSON.parse(await readFile(`${dir(vid)}/index.json`, "utf8"));
  } catch {
    return {};
  }
}

// Everything over the picture: player chrome, captions, end screens, the new controls host, the cookie consent dialog.
const HIDE = `#movie_player > :not(.html5-video-container), #player-controls, .ytPlayerControlsContainerHost, #bottom-sheet-wrapper,
  ytd-consent-bump-v2-lightbox, tp-yt-iron-overlay-backdrop { display: none !important }`;

const localBrowser = () => {
  F.local ??= chromium.launch({ channel: "chrome", headless: true }).then(
    (b) => (b.on("disconnected", () => (F.local = undefined)), b),
    (e) => ((F.local = undefined), Promise.reject(e)),
  );
  return F.local;
};

async function openOn(browser: Browser, vid: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    // An embed opened with no referrer shows "Error 153"; any referrer is enough.
    await page.goto(`https://www.youtube.com/embed/${vid}?autoplay=1&mute=1&controls=0&rel=0&cc_load_policy=0&iv_load_policy=3&playsinline=1`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
      referer: "https://arc.local/",
    });
    // Polled with evaluate: waitForFunction compiles its string with eval, which the embed's Trusted Types policy blocks.
    // A private, removed, age-restricted or embedding-disabled video shows a message instead of playing (seen: "This video is
    // private ... Sign in"); the <video> element is there but never loads.
    let state: string | false = false;
    // The message test waits 5 s, so a title that happens to contain "error" cannot stop a video that is still loading.
    for (const t0 = Date.now(); !state && Date.now() - t0 < 20_000; await page.waitForTimeout(250))
      state = (await page.evaluate(`((late) => { const v = document.querySelector("video"); if (v && v.readyState >= 1) return "ok";
        const t = (document.body.innerText || "").trim();
        return late && /\\b(private|unavailable|sign in|confirm your age|age-restricted|playback on other websites|error \\d+)\\b/i.test(t) ? "refused: " + t.slice(0, 120).replace(/\\s+/g, " ") : false; })(${Date.now() - t0 > 5_000})`)) as string | false;
    if (state !== "ok") {
      console.log(`[frames] ${vid}: ${state || "no video after 20 s"}`);
      throw new FrameError("YouTube will not play this video outside its own site, so Arc cannot take a picture from it.");
    }
    await page.addStyleTag({ content: HIDE }); // after the check: it hides the player's own error panel too
    return page;
  } catch (e) {
    await page.close().catch(() => {});
    if (e instanceof FrameError) throw e;
    throw new Error(`embed did not load: ${(e as Error).message.slice(0, 120)}`);
  }
}

/** One open page per video, reused for every frame of it; closed after two idle minutes. */
function pageFor(vid: string): Promise<Open> {
  let p = F.pages.get(vid);
  if (!p) {
    p = (async (): Promise<Open> => {
      try {
        if (process.env.ARC_FRAMES === "remote") throw new Error("ARC_FRAMES=remote"); // testing the fallback route
        return { page: await openOn(await localBrowser(), vid), route: "local chrome" };
      } catch (e) {
        if (e instanceof FrameError) throw e;
        console.log(`[frames] local chrome unavailable (${(e as Error).message.slice(0, 80)}); using Bright Data`);
        navigation(); // one embed page per video; its frames are seeks on that page
        return { page: await openOn(await remoteBrowser(), vid), route: "bright data" };
      }
    })();
    p.catch(() => F.pages.delete(vid));
    F.pages.set(vid, p);
  }
  return p;
}

const SEEK = (t: number) => `(async () => {
  const v = document.querySelector("video");
  const player = document.querySelector("#movie_player");
  // An advert plays in the same element: wait it out (muted), up to 40 s.
  for (let k = 0; k < 160 && player && player.classList.contains("ad-showing"); k++) { if (v.paused) v.play().catch(() => {}); await new Promise((r) => setTimeout(r, 250)); }
  if (player && player.classList.contains("ad-showing")) return { ad: true };
  v.muted = true;
  v.pause();
  if (Math.abs(v.currentTime - ${t}) > 0.25) await new Promise((r) => { v.addEventListener("seeked", r, { once: true }); v.currentTime = ${t}; setTimeout(r, 15000); });
  for (let k = 0; k < 100 && v.readyState < 2; k++) await new Promise((r) => setTimeout(r, 100));
  return { at: v.currentTime, ready: v.readyState, w: v.videoWidth };
})()`;

/** Seek, pause, screenshot the <video> element. Frames of all videos are taken one at a time. */
export function capture(vid: string, node: string, at: number, visual: string): Promise<{ ms: number; route: string; at: number }> {
  const run = F.chain.then(async () => {
    const t0 = Date.now();
    const open = await pageFor(vid);
    clearTimeout(open.timer);
    const r = (await open.page.evaluate(SEEK(at))) as { ad?: boolean; at: number; ready: number; w: number };
    if (r.ad) throw new FrameError("An advert is playing on this video, so the picture is not ready yet.");
    if (r.ready < 2 || !r.w) throw new Error(`no frame at ${at}s (readyState ${r.ready})`);
    await mkdir(dir(vid), { recursive: true });
    await open.page.locator("video").first().screenshot({ path: framePath(vid, node), type: "jpeg", quality: 85 });
    const index = await frameIndex(vid);
    index[node] = { at: Math.round(r.at * 10) / 10, visual };
    await writeFile(`${dir(vid)}/index.json`, JSON.stringify(index));
    open.timer = setTimeout(() => {
      F.pages.delete(vid);
      open.page.close().catch(() => {});
    }, 120_000);
    open.timer.unref();
    return { ms: Date.now() - t0, route: open.route, at: index[node].at };
  });
  F.chain = run.catch(() => {});
  return run;
}
