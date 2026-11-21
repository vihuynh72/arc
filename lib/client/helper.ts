"use client";
// Talks to the Arc helper extension (extension/background.js) from Arc's own page: is it installed, may it read this site, and
// "read this link through the student's own browser". The extension announces itself on Arc's pages (extension/arc-page.js sets
// data-arc-helper to its id); only Arc's origins can message it (manifest externally_connectable). Also receives a page from the
// no-install bookmarklet (/?receive=1, window.open plus postMessage). Used by components/Twin.tsx.

export const LINES = {
  missing: "That page needs you to sign in, so I can't open it from here. If someone shared it with you, ask them to make it public, or ask whoever set up Arc to add the Arc helper to this browser.",
  consent: "That page needs your sign-in. Your browser will ask if Arc may read it: press Enter to allow.",
  reading: "Reading that page from your own browser.",
  failed: "The helper did not answer. Try again in a moment.",
  gone: "The page did not arrive. Go back to it and send it again.",
  nothing: "That page had nothing Arc could read.",
  from: (r: { origin: string | null; host: string }) => (r.origin ? `A page was sent to Arc from ${r.host}.` : `A page was sent to Arc from ${r.host}, according to the page.`),
  privateFirst: "This page came from your own account. Arc keeps it only while you use it, and descriptions and answers about it are made by Gemini.",
  assessment: "This looks like a quiz or test. I will read it to you, but I will not answer its questions.",
};

/** The sign-in line app/api/load answers with (lib/server/fetch.ts MESSAGES.signIn, status 403). */
export const isSignInError = (status: number, message: unknown) => status === 403 && typeof message === "string" && /needs you to sign in/i.test(message);

type Reply = { ok?: boolean; id?: string; error?: string; code?: string; allowed?: boolean; refused?: string };
type Runtime = { sendMessage: (id: string, msg: unknown, cb: (r: Reply | undefined) => void) => void; lastError?: unknown };
const runtime = () => (globalThis as unknown as { chrome?: { runtime?: Runtime } }).chrome?.runtime;
export const helperId = () => (typeof document === "undefined" ? null : document.documentElement.dataset.arcHelper || null);

function send(msg: unknown, ms: number): Promise<Reply> {
  const id = helperId();
  const rt = runtime();
  if (!id || !rt?.sendMessage) return Promise.resolve({ code: "missing" });
  return new Promise((done) => {
    const t = setTimeout(() => done({ code: "timeout", error: LINES.failed }), ms);
    try {
      rt.sendMessage(id, msg, (r) => {
        clearTimeout(t);
        done(rt.lastError || !r ? { code: "missing" } : r);
      });
    } catch {
      clearTimeout(t);
      done({ code: "missing" });
    }
  });
}

/** Whether the helper may already read that site (no prompt needed). */
export const helperAllowed = (url: string) => send({ type: "allowed", url }, 4000);
/** Reads the link through the student's browser; resolves with the private document id, or a plain error line. Up to 4 minutes
 * (the consent page waits for the student). */
export const helperRead = (url: string) => send({ type: "read", url }, 4 * 60_000);

// ---- the bookmarklet's hand-off (scripts/bookmarklet.mjs) ----
const MAX_JSON = 40 * 1024 * 1024; // the same cap as /api/ingest
/** The page when it has the shape /api/ingest takes, is not too big, and names the site that sent it; the server checks everything again. */
function checked(raw: string, origin: string | null): Received | null {
  if (raw.length > MAX_JSON) return null;
  try {
    const p = JSON.parse(raw) as { url?: unknown; html?: unknown; pdf?: unknown };
    if (typeof p.url !== "string" || !/^https?:\/\//i.test(p.url) || (typeof p.html !== "string" && !p.pdf)) return null;
    const claimed = new URL(p.url);
    if (origin && claimed.origin !== origin) return null; // a page that claims to be another site than the one that sent it
    return { page: raw, origin, host: claimed.hostname.replace(/^www\./, "") };
  } catch {
    return null;
  }
}

/** On /?receive=name: the page left in window.name by the same tab. On /?receive=1: tells the opener Arc is ready, takes one page from it, checks its shape and size. Null after 60 s or on junk. */
/** A page handed over without the extension, and where it came from: `origin` is the sender's real origin (postMessage); null for
 * the window.name route, where only the page's own claim (its url) is known. */
export type Received = { page: string; origin: string | null; host: string };
/** Null when nothing usable arrived, or the page claims another site than the one that sent it. */
export function receivePage(mode: string | null, ms = 60_000): Promise<Received | null> {
  if (mode === "name") {
    // Same-tab hand-off: the page set window.name, then navigated here (scripts/bookmarklet.mjs, the console steps).
    const raw = window.name;
    window.name = "";
    return Promise.resolve(raw.startsWith('{"arc":1,') ? checked(raw, null) : null);
  }
  const opener = window.opener as Window | null;
  if (!opener) return Promise.resolve(null);
  return new Promise((done) => {
    const t = setTimeout(() => end(null), ms);
    const end = (v: Received | null) => {
      clearTimeout(t);
      window.removeEventListener("message", on);
      done(v);
    };
    const on = (e: MessageEvent) => {
      if (e.source !== opener) return; // only the tab that opened this one
      const d = e.data as { type?: unknown; page?: unknown };
      if (d?.type !== "arc:page" || typeof d.page !== "string") return;
      end(checked(d.page, e.origin));
    };
    window.addEventListener("message", on);
    opener.postMessage({ type: "arc:ready" }, "*"); // carries nothing; the page comes back only to this window
  });
}
