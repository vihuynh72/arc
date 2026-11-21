// What the Arc helper will and will not do, as plain functions (no chrome.* here), so scripts/checks/extension.ts can test them.

/** The only pages that may message the helper (also listed in manifest.json externally_connectable and host_permissions). */
export const ARC_ORIGINS = ["http://localhost:3000", "https://arc-production-815e237c.up.railway.app"];
export const isArcOrigin = (o) => typeof o === "string" && ARC_ORIGINS.includes(o);

export const LINES = {
  scheme: "Arc reads web pages only.",
  browser: "Chrome does not let extensions read that page.",
  arc: "That is Arc itself.",
  attempt: "Arc will not open a quiz or test for you, because opening it can start your attempt. Start it yourself, then press the Arc shortcut on the quiz page, and Arc will read it to you.",
  declined: "Arc may not read pages from that site yet. You can allow it the next time Arc asks.",
  signIn: "That site asked you to sign in. Sign in to it in your browser, then try again.",
  slow: "That page took too long to open.",
  busy: "Arc is already reading a page from that site.",
  tooFast: "One moment: Arc is still opening the last page from that site.",
  tooMany: "Arc has opened many pages from that site in the last few minutes. Wait a little, then try again.",
  inactive: "Arc reads pages for you only from the Arc tab you are on.",
};

// Addresses whose mere opening starts or continues a quiz attempt. A request for one is refused before any tab opens.
const ATTEMPT = [
  /\/courses\/\d+\/quizzes\/\d+\/take\b/i, // Canvas classic quizzes
  /\/quizzes\/\d+\/take\b/i,
  /\/mod\/quiz\/(?:attempt|startattempt|processattempt|summary)\.php/i, // Moodle
  /\/webapps\/assessment\/take\//i, // Blackboard Learn original
  /\/ultra\/.*\/assessment\/.*\/attempt/i, // Blackboard Ultra
  /\/d2l\/lms\/quizzing\/user\/(?:attempt|quiz_submissions)/i, // D2L Brightspace
  /\/mod\/(?:lesson|hvp)\/.*attempt/i,
];
export const startsAttempt = (u) => ATTEMPT.some((re) => re.test(u.pathname + u.search));

/** A plain line when the helper must not open this address in a background tab; null when it may (if the site is allowed). */
export function refuseUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return LINES.scheme;
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return LINES.scheme; // file:, chrome:, javascript:, data: ...
  if (/^(chrome\.google\.com|chromewebstore\.google\.com)$/.test(u.hostname) && /webstore|detail/.test(u.pathname + u.hostname)) return LINES.browser;
  if (isArcOrigin(u.origin)) return LINES.arc;
  if (startsAttempt(u)) return LINES.attempt;
  return null;
}

/** The permission pattern for one site, as chrome.permissions takes it. */
export const originPattern = (origin) => `${origin}/*`;

/** Sites the student allowed: every granted origin except Arc's own. */
export const allowedSites = (origins = []) =>
  origins.filter((p) => !ARC_ORIGINS.some((a) => p === `${a}/*`)).map((p) => p.replace(/\/\*$/, ""));

/** Pairs cross-site frame reads with the markers the page read left: same origin and path. */
export function matchFrames(markers = [], reads = []) {
  const key = (s) => {
    try {
      const u = new URL(s);
      return u.origin + u.pathname;
    } catch {
      return "";
    }
  };
  const out = [];
  for (const m of markers) {
    const r = reads.find((x) => x && key(x.url) === key(m.src));
    if (r?.html) out.push({ n: m.n, html: r.html });
  }
  return out;
}
