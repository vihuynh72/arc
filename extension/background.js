// The Arc helper. Two ways in, both reading pages through the student's own browser so their sign-in applies, and Arc never
// sees a password, cookie or token:
// 1. "Send this tab" (toolbar button or Alt+Shift+A): the open tab is read in place (activeTab: a deliberate key press).
// 2. An Arc page asks for a link that needs sign-in (lib/client/helper.ts, chrome.runtime.sendMessage; only Arc's own origins can
//    message this extension: manifest externally_connectable, checked again here). The helper reads only sites the student
//    allowed once on the consent page (optional host permissions), in a background tab that is closed afterwards.
// The chrome.* calls sit behind one small layer (`chromeLayer`) so scripts/checks/extension.ts can drive makeHelper() with stubs.
import { LINES, allowedSites, isArcOrigin, matchFrames, originPattern, refuseUrl } from "./rules.js";

const SETTLE_MS = 30_000; // the tab's own load; extract.js then waits for a quiet spell of its own
const CONSENT_MS = 3 * 60_000;
// Consent is per site, not per read: background reads are also rate-limited per site, and only asked for from the Arc tab the
// student is looking at, so a page in Arc's origin cannot quietly walk an allowed site.
export const RATE = { gapMs: 2000, windowMs: 10 * 60_000, perWindow: 30 };

export function makeHelper(c) {
  const pending = new Map(); // origin -> answer(granted) while the consent page is open
  const reading = new Set(); // origins being read now: one background tab per site at a time

  const allowed = (origin) => c.hasPermission(originPattern(origin));
  const recent = new Map(); // origin -> times of background reads
  const now = () => (c.now ? c.now() : Date.now());
  /** A plain line when this site has been read too often just now; records the read otherwise. */
  function limited(origin) {
    const t = now();
    const times = (recent.get(origin) ?? []).filter((x) => t - x < RATE.windowMs);
    if (times.length && t - times[times.length - 1] < RATE.gapMs) return LINES.tooFast;
    if (times.length >= RATE.perWindow) return LINES.tooMany;
    recent.set(origin, [...times, t]);
    return null;
  }

  /** Opens the consent page and waits for the student's answer (closing the page is "not now"). */
  function ask(origin) {
    return new Promise((done) => {
      const finish = (granted) => {
        if (pending.get(origin) !== finish) return;
        pending.delete(origin);
        clearTimeout(timer);
        done(granted);
      };
      pending.get(origin)?.(false);
      pending.set(origin, finish);
      const timer = setTimeout(() => finish(false), CONSENT_MS);
      c.openConsent(origin).then((tabId) => c.onTabClosed(tabId, () => finish(false)), () => finish(false));
    });
  }

  /** The consent page's answer (internal message from this extension's own page only). */
  function consented(origin, granted) {
    pending.get(origin)?.(!!granted);
  }

  /** Reads one tab with extract.js, plus any cross-site frames the granted permissions cover. */
  async function extract(tabId) {
    const page = await c.run(tabId, "page");
    if (page?.frames?.length) {
      const reads = await c.run(tabId, "frames").catch(() => []);
      page.frames = matchFrames(page.frames, reads);
    }
    return page;
  }

  async function post(arc, page) {
    const res = await c.fetch(`${arc}/api/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(page) });
    const body = await res.json().catch(() => ({}));
    return res.ok && body.id ? { id: body.id } : { error: body.error || "Arc could not read that page.", code: body.code };
  }

  /** A link from an Arc page. Never fetches a site the student has not allowed. */
  async function read(url, arc) {
    const why = refuseUrl(url);
    if (why) return { error: why, code: "refused" };
    const origin = new URL(url).origin;
    if (!(await allowed(origin))) {
      const granted = await ask(origin);
      if (!granted || !(await allowed(origin))) return { error: LINES.declined, code: "declined" };
    }
    if (reading.has(origin)) return { error: LINES.busy, code: "busy" };
    const slow = limited(origin);
    if (slow) return { error: slow, code: "rate" };
    reading.add(origin);
    let tabId;
    try {
      tabId = await c.openHidden(url);
      if (!(await c.loaded(tabId, SETTLE_MS))) return { error: LINES.slow, code: "slow" };
      const at = await c.tabUrl(tabId);
      // Sent to a sign-in page on another site (single sign-on), or somewhere that starts a quiz: stop here.
      const there = (() => {
        try {
          return new URL(at);
        } catch {
          return null;
        }
      })();
      if (!there || refuseUrl(at)) return { error: there && refuseUrl(at) === LINES.attempt ? LINES.attempt : LINES.signIn, code: "signin" };
      if (there.origin !== origin && !(await allowed(there.origin))) return { error: LINES.signIn, code: "signin" };
      const page = await extract(tabId);
      if (!page) return { error: "Arc could not read that page.", code: "empty" };
      return await post(arc, page);
    } catch (e) {
      c.log("read failed", e);
      return { error: "Arc could not read that page.", code: "failed" };
    } finally {
      reading.delete(origin);
      if (tabId != null) await c.closeTab(tabId).catch(() => {});
    }
  }

  /** Messages from web pages. Anything not from Arc's own origins gets no answer at all. */
  async function external(msg, sender) {
    if (!isArcOrigin(sender?.origin)) return undefined;
    if (msg?.type === "ping") return { ok: true, version: c.version };
    if (msg?.type === "allowed" && typeof msg.url === "string") {
      if (refuseUrl(msg.url)) return { allowed: false, refused: refuseUrl(msg.url) };
      return { allowed: await allowed(new URL(msg.url).origin) };
    }
    if (msg?.type === "read" && typeof msg.url === "string") {
      if (!sender.tab?.active) return { error: LINES.inactive, code: "inactive" }; // only the Arc tab the student is on
      return read(msg.url, sender.origin);
    }
    return { error: "Unknown request." };
  }

  /** The toolbar button or the shortcut on the open tab. */
  async function sendTab(tab) {
    const arc = (await c.arcOrigin()).replace(/\/+$/, "");
    if (!tab?.id || tab.url?.startsWith(`${arc}/`)) return; // a second press lands on the Arc tab the first one opened
    if (reading.has(`tab:${tab.id}`)) return;
    reading.add(`tab:${tab.id}`);
    try {
      let page;
      try {
        page = await extract(tab.id);
      } catch (e) {
        // chrome:// pages, the Web Store, the New Tab page cannot be read by any extension.
        c.log("Chrome did not let the extension read this tab.", e);
        return void (await c.openTab(`${arc}/?notice=restricted`));
      }
      const r = await post(arc, page).catch(() => ({ error: "unreachable" }));
      await c.openTab(r.id ? `${arc}/#doc=${r.id}` : `${arc}/?notice=failed`); // a fragment: never in a request log
    } finally {
      reading.delete(`tab:${tab.id}`);
    }
  }

  return { read, external, sendTab, consented, pending };
}

/** The real chrome.* layer. */
export function chromeLayer() {
  const ch = globalThis.chrome;
  return {
    version: ch.runtime.getManifest().version,
    log: (...a) => console.warn("Arc:", ...a),
    hasPermission: (pattern) => ch.permissions.contains({ origins: [pattern] }),
    arcOrigin: async () => (await ch.storage.sync.get({ origin: "http://localhost:3000" })).origin,
    fetch: (u, init) => fetch(u, init),
    openTab: (url) => ch.tabs.create({ url }),
    openConsent: async (origin) => (await ch.tabs.create({ url: ch.runtime.getURL(`consent.html?origin=${encodeURIComponent(origin)}`), active: true })).id,
    onTabClosed: (tabId, fn) => {
      const l = (id) => id === tabId && (ch.tabs.onRemoved.removeListener(l), fn());
      ch.tabs.onRemoved.addListener(l);
    },
    openHidden: async (url) => (await ch.tabs.create({ url, active: false })).id,
    loaded: (tabId, ms) =>
      new Promise((done) => {
        const t = setTimeout(() => end(false), ms);
        const end = (ok) => (clearTimeout(t), ch.tabs.onUpdated.removeListener(l), done(ok));
        const l = (id, info) => id === tabId && info.status === "complete" && end(true);
        ch.tabs.onUpdated.addListener(l);
        ch.tabs.get(tabId).then((tab) => tab.status === "complete" && end(true), () => end(false));
      }),
    tabUrl: async (tabId) => (await ch.tabs.get(tabId)).url ?? "",
    closeTab: (tabId) => ch.tabs.remove(tabId),
    run: async (tabId, what) => {
      const all = what === "frames";
      await ch.scripting.executeScript({ target: { tabId, allFrames: all }, files: ["extract.js"] });
      const out = await ch.scripting.executeScript({ target: { tabId, allFrames: all }, func: all ? () => globalThis.__arcFrame() : () => globalThis.__arcExtract() });
      return all ? out.filter((r) => r.frameId !== 0).map((r) => r.result) : out[0]?.result;
    },
  };
}

// Wired only inside Chrome; the checks import makeHelper without it.
if (globalThis.chrome?.runtime?.id) {
  const ch = globalThis.chrome;
  const helper = makeHelper(chromeLayer());
  ch.action.onClicked.addListener((tab) => void helper.sendTab(tab));
  ch.runtime.onMessageExternal.addListener((msg, sender, reply) => {
    helper.external(msg, sender).then((r) => r !== undefined && reply(r), () => reply({ error: "Arc could not read that page." }));
    return isArcOrigin(sender?.origin); // keep the channel open only for Arc
  });
  ch.runtime.onMessage.addListener((msg, sender) => {
    // Only this extension's own consent page may answer for the student.
    if (sender.id !== ch.runtime.id || !sender.url?.startsWith(ch.runtime.getURL("consent.html"))) return;
    if (msg?.type === "consent" && typeof msg.origin === "string") helper.consented(msg.origin, msg.granted);
  });
  void allowedSites; // listed on the options page (options.js)
}
