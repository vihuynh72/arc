// One Bright Data Browser API session kept on globalThis. Read-only: it navigates, scrolls and screenshots, never clicks.
import { chromium, type Browser, type Page } from "playwright-core";

type Remote = { browser: Browser; page: Page; url: string | null; timer: NodeJS.Timeout };
const g = globalThis as unknown as { __arcRemote?: Promise<Remote>; __arcRemoteQueue?: Promise<unknown>; __arcRemoteSeq?: number };

export type RemoteShot = {
  shot: string; // jpeg base64
  viewport: { w: number; h: number };
  box: { x: number; y: number; w: number; h: number } | null;
  label: "live";
  found: boolean;
  ms: number;
};

export type RemoteTarget = { kind: "figure"; n: number } | { kind: "heading"; text: string } | { kind: "top" };

export class Superseded extends Error {}

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

/** Opens the page once per url and returns it, ready to scroll. */
async function ready(url: string): Promise<Page> {
  const r = await session();
  if (r.url !== url) {
    await r.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await r.page.waitForLoadState("load", { timeout: 8_000 }).catch(() => {}); // the article re-renders around here
    // The site scrolls smoothly, which makes boxes move under us; jump instantly instead. The cookie banner is hidden, not clicked, so it does not cover the page.
    await r.page.addStyleTag({ content: "html,body{scroll-behavior:auto !important} #usercentrics-root,#usercentrics-cmp-ui{display:none !important}" });
    r.url = url;
  }
  return r.page;
}

const FOUND_WITHIN = 2_500; // a missing element must not hold the student for long

// Page-side finders are strings, not functions: tsx/esbuild injects helpers into functions that do not exist in the remote page.
// Find, centre and measure in one call, because MDPI re-renders the article after load and a held element handle goes stale.
const finder = (t: Exclude<RemoteTarget, { kind: "top" }>) => {
  const pick =
    t.kind === "heading"
      ? `const n = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
         const w = n(${JSON.stringify(t.text)});
         let hs = [...document.querySelectorAll(".html-body h2,.html-body h3,.html-body h4")];
         if (!hs.length) hs = [...document.querySelectorAll("h2,h3,h4")];
         const el = w && (hs.find((e) => n(e.textContent) === w) || hs.find((e) => n(e.textContent).startsWith(w)));`
      : `const wraps = [...document.querySelectorAll(".html-fig-wrap")];
         const wrap = wraps.find((e) => (e.id || "").endsWith("-f" + String(${t.n}).padStart(3, "0"))) || wraps[${t.n - 1}];
         const el = wrap && (wrap.querySelector("img") || wrap);`;
  return `(() => {
    ${pick}
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, loaded: !(el instanceof HTMLImageElement) || (el.complete && el.naturalWidth > 0) };
  })()`;
};

type Hit = { x: number; y: number; w: number; h: number; loaded: boolean };

async function go(url: string, t: RemoteTarget): Promise<RemoteShot> {
  const t0 = Date.now();
  const page = await ready(url);
  let box: RemoteShot["box"] = null;
  let found = false;
  if (t.kind === "top") {
    await page.evaluate("window.scrollTo(0, 0)");
    found = true;
  } else {
    const src = finder(t);
    const hit = await page.waitForFunction(src, undefined, { timeout: FOUND_WITHIN }).then((h) => h.jsonValue() as Promise<Hit>, () => null);
    if (hit) {
      found = true;
      // Lazy images start loading on a real scroll event, so give them real wheel input.
      await page.mouse.move(300, 300);
      await page.mouse.wheel(0, 1);
      await page.mouse.wheel(0, -1);
      if (t.kind === "figure" && !hit.loaded) await page.waitForFunction(`(${src}).loaded`, undefined, { timeout: 8_000 }).catch(() => {});
      await page.waitForTimeout(250); // let layout settle, then measure again
      const again = (await page.evaluate(src).catch(() => null)) as Hit | null;
      const b = again ?? hit;
      box = b.w > 0 ? { x: b.x, y: b.y, w: b.w, h: b.h } : null;
    }
  }
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  const jpeg = await page.screenshot({ type: "jpeg", quality: 60 });
  return { shot: jpeg.toString("base64"), viewport: { w: vp.width, h: vp.height }, box, label: "live", found, ms: Date.now() - t0 };
}

/** Calls run one at a time: a single page cannot serve two navigations. */
function queue<T>(job: () => Promise<T>): Promise<T> {
  const next = (g.__arcRemoteQueue ?? Promise.resolve()).then(job);
  g.__arcRemoteQueue = next.catch(() => {});
  return next;
}

export const remoteShot = (url: string, figure: number) => queue(() => go(url, { kind: "figure", n: figure }));

/** Follows the cursor. A call that a newer one has overtaken while waiting its turn is dropped (throws Superseded). */
export function remoteGo(url: string, target: RemoteTarget): Promise<RemoteShot> {
  const mine = (g.__arcRemoteSeq = (g.__arcRemoteSeq ?? 0) + 1);
  return queue(() => {
    if (mine !== g.__arcRemoteSeq) throw new Superseded();
    return go(url, target);
  });
}

/** Opens the session and the page so the first real request is fast. */
export const remoteWarm = (url: string) => queue(async () => void (await ready(url)));
