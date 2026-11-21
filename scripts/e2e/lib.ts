// Helpers for scripts/e2e.ts: one headless Chrome page per scenario, with what the student would hear (the page's own "arc:heard"
// events), what the app announced ("arc:command", "arc:cursor", "arc:block") and what a screen reader would be told (live regions),
// recorded with the page's own clock. Waits are polls with a stated reason and a timeout; a failure says what was expected and
// what was heard. Nothing here moves the real mouse pointer: every POST to /api/pointer is aborted and counted.
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

export type Ev = { at: number; type: string; [k: string]: unknown };
export type Utter = { voice: string; text: string; start: number; end?: number; cut?: boolean };

/** A failed expectation: `expected` is what the student should have met, `saw` what actually happened. */
export class Fail extends Error {
  constructor(public expected: string, public saw: string) {
    super(`expected ${expected}; saw ${saw}`);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export const SOUND_MS: Record<string, number> = { chime: 400, "listening-on": 400, "listening-off": 400, tick: 60, tone: 100, "wait-tone": 500 }; // as scripts/blind/session.mjs

/** What the page forwards: the app's own events (never DOM text of the page, except live regions, for scenario 15). Plain JS in a string:
 * a function passed to addInitScript is compiled by tsx with helpers that do not exist in the page. */
const PAGE_INIT = `(() => {
  window.__name = window.__name || ((f) => f); // tsx's keepNames wraps named functions in page.evaluate callbacks
  const emit = (o) => { try { window.__e2e && window.__e2e(o).catch(() => {}); } catch (e) {} };
  const ep = (t) => performance.timeOrigin + t;
  addEventListener("arc:heard", (e) => emit({ type: "heard", ...e.detail, at: ep(e.detail.t) }));
  for (const n of ["command", "cursor", "block"]) addEventListener("arc:" + n, (e) => emit({ type: n, ...JSON.parse(JSON.stringify(e.detail ?? {})), at: ep(performance.now()) }));
  // Whether a key's default action was cancelled (Command+Arrow is the browser's Back and Forward): read after the app has handled it.
  addEventListener("keydown", (e) => { setTimeout(() => emit({ type: "key", key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, prevented: e.defaultPrevented, target: (e.target && (e.target.id || e.target.tagName)) || "", at: Date.now() }), 0); }, true);
  // Every live region (aria-live other than off, role status, alert or log) that changes: its text is what a screen reader would speak.
  const LIVE = '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]';
  const seen = new Map();
  new MutationObserver((ms) => {
    const regions = new Set();
    for (const m of ms) {
      const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      const r = el && el.closest(LIVE);
      if (r) regions.add(r);
      for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.matches && n.matches(LIVE)) regions.add(n); else if (n.querySelectorAll) n.querySelectorAll(LIVE).forEach((x) => regions.add(x)); }
    }
    for (const r of regions) {
      const text = (r.textContent || "").replace(/\\s+/g, " ").trim();
      if (text && seen.get(r) !== text) { seen.set(r, text); emit({ type: "live", text, at: Date.now() }); }
    }
  }).observe(document, { subtree: true, childList: true, characterData: true });
})();`;

function silentWav(seconds: number) {
  const rate = 8000, n = Math.round(seconds * rate), h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + n * 2, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(n * 2, 40);
  return Buffer.concat([h, Buffer.alloc(n * 2)]);
}

export type Opts = { base: string; headed: boolean; out: string };

export async function launch(o: Opts): Promise<Browser> {
  return chromium.launch({ channel: "chrome", headless: !o.headed, args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
}

export class Sess {
  events: Ev[] = [];
  errors: string[] = [];
  posts: string[] = []; // POSTs to /api/pointer (always aborted)
  reqs: { at: number; method: string; url: string }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the app's JSON answers are read loosely here
  loads: { url: string; json: any }[] = []; // JSON of /api/load, /api/ingest and /api/pdf/page responses, for the figures' boxes
  mac = true;
  private constructor(public page: Page, public ctx: BrowserContext, public o: Opts) {}

  static async open(browser: Browser, o: Opts, { start = "/", init, realVoice = false }: { start?: string | null; init?: (ctx: BrowserContext) => Promise<void>; realVoice?: boolean } = {}): Promise<Sess> {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    // eslint-disable-next-line prefer-const -- assigned once further down, after the routes that close over it
    let s!: Sess; // the routes and bindings come first: a page made earlier does not get them reliably
    // The student's reading voice, as silent audio of the right length (scripts/blind/session.mjs --fast): the app's own events say what was said.
    await ctx.route(/\/api\/speak(\?|$)/, (r) => {
      let text = "";
      try { text = JSON.parse(r.request().postData() ?? "{}").text ?? ""; } catch {}
      return r.fulfill({ status: 200, headers: { "content-type": "audio/wav" }, body: silentWav(0.25 + text.length / 90) });
    });
    // The stored copy is the first view and the live fetch (Bright Data, paid) follows at once: it is answered here with the stored copy
    // (via "unlocker"), so no test pays for a page and the swap changes nothing on screen.
    await ctx.route(/\/api\/load$/, async (r) => {
      const req = r.request();
      let b: { live?: boolean } = {};
      try { b = JSON.parse(req.postData() ?? "{}"); } catch {}
      if (req.method() !== "POST" || !b.live) return r.continue();
      const res = await r.fetch({ postData: JSON.stringify({ ...b, live: false }) });
      const j = await res.json().catch(() => null);
      if (!j?.source) return r.fulfill({ response: res });
      return r.fulfill({ response: res, json: { ...j, source: { ...j.source, via: "unlocker" }, live: undefined } });
    });
    await ctx.route(/\/api\/pointer/, (r) => {
      if (r.request().method() === "GET") return r.continue();
      s.posts.push(r.request().postData() ?? "");
      return r.abort();
    });
    // The second voice (figure tours, spoken answers) is Gemini Live over the app's relay socket, which costs money per line: unless a scenario
    // asks for the real one, the socket is answered here, a line with silent audio of about its length (24 kHz, 16 bit).
    if (!realVoice)
      await ctx.routeWebSocket(/\/ws\/voice/, (ws) => {
        ws.onMessage((raw) => {
          let m: { type?: string; id?: string; text?: string } = {};
          try { m = JSON.parse(String(raw)); } catch { return; }
          if (m.type !== "say" || !m.id) return;
          const samples = Math.round((0.25 + String(m.text ?? "").length / 90) * 24000);
          for (let left = samples; left > 0; left -= 12_000) ws.send(JSON.stringify({ type: "audio", id: m.id, data: Buffer.alloc(Math.min(left, 12_000) * 2).toString("base64") }));
          ws.send(JSON.stringify({ type: "done", id: m.id, transcript: m.text, match: true }));
        });
      });
    await ctx.exposeBinding("__e2e", (_src, e: Ev) => void s.events.push(e));
    await ctx.addInitScript(PAGE_INIT);
    const page = await ctx.newPage();
    s = new Sess(page, ctx, o);
    page.on("console", (m) => void (m.type() === "error" && s.errors.push(`console: ${m.text().slice(0, 300)}`)));
    page.on("pageerror", (e) => s.errors.push(`pageerror: ${String(e).slice(0, 300)}`));
    page.on("request", (r) => void (/\/api\//.test(r.url()) && s.reqs.push({ at: Date.now(), method: r.method(), url: r.url() })));
    page.on("response", async (r) => {
      if (!/\/api\/(load|ingest|pdf\/page|video)/.test(r.url()) || !(r.headers()["content-type"] ?? "").includes("json")) return;
      const j = await r.json().catch(() => null);
      if (j) s.loads.push({ url: r.url(), json: j });
    });
    s.mac = await page.evaluate(() => /Mac/.test(navigator.platform));
    await init?.(ctx);
    if (start !== null) await page.goto(o.base + start, { waitUntil: "domcontentloaded" });
    return s;
  }

  async close() {
    await this.ctx.close().catch(() => {});
  }

  // ---- what was heard ----
  utterances(since = 0): Utter[] {
    const out: Utter[] = [];
    for (const e of this.events) {
      if (e.type !== "heard" || e.kind !== "speech") continue;
      const text = String(e.text ?? ""), voice = String(e.voice);
      if (e.phase === "start") out.push({ voice, text, start: e.at });
      else {
        const open = [...out].reverse().find((u) => u.end === undefined && u.voice === voice && (!u.text || !text || u.text === text));
        if (open) Object.assign(open, { end: e.at, cut: e.phase === "cut", text: open.text || text });
        else out.push({ voice, text, start: e.at, end: e.at, cut: e.phase === "cut" }); // an answer whose start was not seen
      }
    }
    return out.filter((u) => u.start >= since);
  }
  sounds(name?: string, since = 0) {
    return this.events.filter((e) => e.type === "heard" && e.kind === "sound" && (!name || e.name === name) && e.at >= since);
  }
  of(type: string, since = 0) {
    return this.events.filter((e) => e.type === type && e.at >= since);
  }
  /** A readable end of the log, for a failure message. */
  recent(since = 0, n = 8): string {
    const rows = this.events
      .filter((e) => e.at >= since && e.type === "heard")
      .map((e) => (e.kind === "speech" ? (e.phase === "start" ? `says "${String(e.text).slice(0, 90)}"` : `${e.phase} "${String(e.text).slice(0, 40)}"`) : `(${e.kind === "sound" ? e.name : e.kind})`) + ` +${((e.at - (since || this.events[0]?.at || 0)) / 1000).toFixed(1)}s`);
    return rows.length ? rows.slice(-n).join("; ") : "nothing heard";
  }
  clock() {
    return Date.now();
  }

  // ---- waiting ----
  /** Polls `fn` until it returns something truthy. On timeout: a Fail naming `what` and what was heard since `since`. */
  async until<T>(what: string, fn: () => T | Promise<T>, ms = 10_000, since = 0, poll = 25): Promise<NonNullable<T>> {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v as NonNullable<T>;
      if (Date.now() > end) throw new Fail(what, `${this.recent(since)} (after waiting ${ms} ms)`);
      await sleep(poll);
    }
  }
  /** The first line spoken after `since` that matches. */
  said(re: RegExp | ((t: string) => boolean), since: number, ms = 8000, what = String(re)): Promise<Utter> {
    const ok = typeof re === "function" ? re : (t: string) => re.test(t);
    return this.until(`speech matching ${what}`, () => this.utterances(since).find((u) => ok(u.text)), ms, since);
  }
  /** Asserts nothing starts speaking (and no chime plays) for `ms`. `except`: lines allowed. */
  async hush(ms: number, since = Date.now(), what = "silence", except?: RegExp) {
    await sleep(ms);
    const extra = this.utterances(since).filter((u) => !except?.test(u.text));
    const chimes = this.sounds("chime", since);
    if (extra.length || chimes.length) throw new Fail(what, extra.length ? `Arc said "${extra[0].text.slice(0, 120)}" ${((extra[0].start - since) / 1000).toFixed(1)}s in` : "a chime");
  }
  /** After an action: wait until the voice has been quiet this long (the line is over), then return what was said since. */
  async settle(since: number, quietMs = 800, max = 20_000): Promise<Utter[]> {
    const end = Date.now() + max;
    for (;;) {
      const u = this.utterances(since);
      const open = u.some((x) => x.end === undefined);
      const last = Math.max(since, ...u.map((x) => x.end ?? Date.now()), ...this.sounds(undefined, since).map((e) => e.at + (SOUND_MS[String(e.name)] ?? 200)));
      if (!open && Date.now() - last >= quietMs && Date.now() - since >= quietMs) return u;
      if (Date.now() > end) return u;
      await sleep(40);
    }
  }

  // ---- hands ----
  async press(key: string) {
    const t = Date.now();
    await this.page.keyboard.press(key);
    return t;
  }
  /** "/" (the ask box's own key), the text, Enter. Returns when it was sent. */
  async type(text: string) {
    await this.page.keyboard.press("/");
    await this.until("the ask box to take focus on /", () => this.page.evaluate(() => document.activeElement?.id === "command"), 2000);
    await this.page.keyboard.type(text, { delay: 8 });
    const t = Date.now();
    await this.page.keyboard.press("Enter");
    return t;
  }
  speedKeys(dir: "faster" | "slower") {
    return `${this.mac ? "Meta" : "Control"}+Arrow${dir === "faster" ? "Right" : "Left"}`;
  }
  /** Opens a public link as the student would: pasted in the ask box. Returns when it was sent. */
  async paste(url: string) {
    await this.page.keyboard.press("/");
    await this.until("the ask box to take focus on /", () => this.page.evaluate(() => document.activeElement?.id === "command"), 2000);
    await this.page.keyboard.insertText(url);
    const t = Date.now();
    await this.page.keyboard.press("Enter");
    return t;
  }
  /** Waits for a page to be open and its opening lines to be done. */
  async opened(titleRe: RegExp, since: number, ms = 45_000) {
    const t = await this.said(titleRe, since, ms, `the title ${titleRe}`);
    return t;
  }

  // ---- what is on screen ----
  async currentBlock() {
    return this.page.evaluate(() => {
      const el = document.querySelector('#content [aria-current="true"]');
      return el ? { text: (el.textContent ?? "").replace(/\s+/g, " ").trim(), kind: el.getAttribute("data-kind") ?? el.tagName, id: el.getAttribute("data-block-id") ?? el.closest("[data-node-id]")?.getAttribute("data-node-id") ?? "" } : null;
    });
  }
  async scrollY() {
    return this.page.evaluate(() => window.scrollY);
  }
  /** The tour's picture, ring and drawn pointer, in viewport pixels. Null when no tour is open. */
  async tourGeometry() {
    return this.page.evaluate(() => {
      const sec = document.querySelector("section[aria-label^='Figure tour']");
      const img = sec?.querySelector("img");
      if (!sec || !img) return null;
      const wrap = img.parentElement as HTMLElement;
      const ringEl = [...wrap.children].find((c) => c.tagName === "DIV" && c.getAttribute("aria-hidden") === "true") as HTMLElement | undefined;
      const ptr = wrap.querySelector(".tour-pointer") as HTMLElement | null;
      const rect = (e: Element | null | undefined) => {
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
      };
      const m = ptr ? getComputedStyle(ptr) : null;
      return {
        stop: sec.querySelector("p strong")?.textContent ?? null,
        img: rect(img),
        ring: rect(ringEl),
        ringOn: !!ringEl && getComputedStyle(ringEl).opacity === "1",
        pointer: rect(ptr),
        pointerOn: !!ptr && m!.opacity === "1",
        tipDx: m ? -parseFloat(m.marginLeft) : 0, // the arrow's tip sits this far inside its box (app/globals.css .tour-pointer margin)
        tipDy: m ? -parseFloat(m.marginTop) : 0,
      };
    });
  }
  /** The geometry once the ring and the pointer have stopped gliding (they move 0.7 s with different easing). */
  async tourSettled(ms = 3000) {
    let last = "";
    let still = 0;
    const end = Date.now() + ms;
    for (;;) {
      const g = await this.tourGeometry();
      const key = JSON.stringify(g && [g.ring, g.pointer, g.img]);
      still = key === last ? still + 1 : 0;
      last = key;
      if (g && still >= 3) return g;
      if (Date.now() > end) throw new Fail("the ring and pointer to stop moving", g ? "they were still moving" : "no tour open");
      await sleep(70);
    }
  }
  /** The page's own text, for "this was read from the page" checks. */
  async docText() {
    return norm(await this.page.evaluate(() => (document.querySelector("#content") as HTMLElement | null)?.innerText ?? ""));
  }

  // ---- on failure ----
  async dump(name: string) {
    mkdirSync(this.o.out, { recursive: true });
    const base = `${this.o.out}/${name.replace(/[^\w-]+/g, "-")}`;
    await this.page.screenshot({ path: `${base}.png` }).catch(() => {});
    writeFileSync(`${base}.events.json`, JSON.stringify({ url: this.page.url(), errors: this.errors, pointerPosts: this.posts, requests: this.reqs.slice(-60), events: this.events }, null, 1));
    return base;
  }
}
