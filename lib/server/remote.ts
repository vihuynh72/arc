// One Bright Data Browser API session kept on globalThis. Read-only: it navigates, scrolls and screenshots, never clicks.
import { chromium, type Browser, type Page } from "playwright-core";

type Remote = { browser: Browser; page: Page; url: string | null; timer: NodeJS.Timeout };
const g = globalThis as unknown as { __arcRemote?: Promise<Remote>; __arcRemoteQueue?: Promise<unknown> };

export type RemoteShot = {
  shot: string; // jpeg base64
  viewport: { w: number; h: number };
  box: { x: number; y: number; w: number; h: number } | null;
  label: "live";
};

async function open(): Promise<Remote> {
  const wss = process.env.BRIGHTDATA_BROWSER_WSS;
  if (!wss) throw new Error("Bright Data browser is not configured");
  const browser = await chromium.connectOverCDP(wss, { timeout: 45_000 });
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  // The session dies after ~5 idle minutes; only real input counts (evaluate does not).
  let flip = 1;
  const timer = setInterval(() => {
    page.mouse.move(300 + flip * 40, 300).then(() => page.mouse.wheel(0, flip)).catch(() => {});
    flip = -flip;
  }, 90_000);
  timer.unref();
  const r: Remote = { browser, page, url: null, timer };
  browser.on("disconnected", () => {
    clearInterval(timer);
    if (g.__arcRemote) g.__arcRemote = undefined;
  });
  return r;
}

const session = () => {
  g.__arcRemote ??= open().catch((e) => {
    g.__arcRemote = undefined;
    throw e;
  });
  return g.__arcRemote;
};

async function run(url: string, figure: number): Promise<RemoteShot> {
  const r = await session();
  const { page } = r;
  if (r.url !== url) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // The site scrolls smoothly, which makes boxes move under us; jump instantly instead.
    await page.addStyleTag({ content: "html,body{scroll-behavior:auto !important}" });
    r.url = url;
  }
  // MDPI ids look like <journal>-<vol>-<no>-f001; fall back to the Nth wrapper.
  const byId = page.locator(`.html-fig-wrap[id$="-f${String(figure).padStart(3, "0")}"]`);
  const wrap = (await byId.count()) ? byId.first() : page.locator(".html-fig-wrap").nth(figure - 1);
  await wrap.waitFor({ state: "attached", timeout: 30_000 });
  const img = wrap.locator("img").first();
  await img.evaluate((el) => el.scrollIntoView({ block: "center" }));
  // Lazy images start loading on a real scroll event, so give them real wheel input.
  await page.mouse.move(300, 300);
  await page.mouse.wheel(0, 1);
  await page.mouse.wheel(0, -1);
  await page.waitForFunction(
    (el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0,
    await img.elementHandle(),
    { timeout: 40_000 },
  );
  await page.waitForTimeout(300); // let layout settle before measuring
  const b = await img.boundingBox();
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  const jpeg = await page.screenshot({ type: "jpeg", quality: 70 });
  return {
    shot: jpeg.toString("base64"),
    viewport: { w: vp.width, h: vp.height },
    box: b && b.width > 0 ? { x: b.x, y: b.y, w: b.width, h: b.height } : null,
    label: "live",
  };
}

/** Calls run one at a time: a single page cannot serve two navigations. */
export function remoteShot(url: string, figure: number): Promise<RemoteShot> {
  const next = (g.__arcRemoteQueue ?? Promise.resolve()).then(() => run(url, figure));
  g.__arcRemoteQueue = next.catch(() => {});
  return next;
}
