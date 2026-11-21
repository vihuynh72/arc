// Offline check for the Arc helper's own rules and background logic (extension/rules.js, extension/background.js), with every
// chrome.* call replaced by a stub: who may message it, which addresses it refuses, that an unallowed site opens the consent page
// and fetches nothing, and that a background tab is always closed.
import assert from "node:assert";
import { makeHelper } from "../../extension/background.js";
import { allowedSites, isArcOrigin, LINES, matchFrames, refuseUrl } from "../../extension/rules.js";

type Call = [string, ...unknown[]];
type R = { id?: string; code?: string; error?: string; ok?: boolean; version?: string };
function stub(o: { allowed?: string[]; consent?: boolean; finalUrl?: string; page?: unknown; throwOnRun?: boolean; clock?: { t: number } } = {}) {
  const calls: Call[] = [];
  const allowed = new Set(o.allowed ?? []);
  const layer = {
    version: "test",
    now: o.clock ? () => o.clock!.t : undefined,
    log: () => {},
    hasPermission: async (p: string) => (calls.push(["has", p]), allowed.has(p)),
    arcOrigin: async () => "http://localhost:3000",
    fetch: async (u: string, init: { body: string }) => (calls.push(["fetch", u, JSON.parse(init.body).url]), { ok: true, json: async () => ({ id: "f".repeat(32) }) }),
    openTab: async (u: string) => void calls.push(["openTab", u]),
    openConsent: async (origin: string) => {
      calls.push(["consent", origin]);
      if (o.consent) allowed.add(`${origin}/*`);
      setTimeout(() => helper.consented(origin, !!o.consent), 5);
      return 7;
    },
    onTabClosed: () => {},
    openHidden: async (u: string) => (calls.push(["openHidden", u]), 42),
    loaded: async () => true,
    tabUrl: async () => o.finalUrl ?? "https://canvas.example.edu/courses/1/pages/intro",
    closeTab: async (id: number) => void calls.push(["close", id]),
    run: async (_id: number, what: string) => {
      calls.push(["run", what]);
      if (o.throwOnRun) throw new Error("boom");
      return what === "frames" ? [] : (o.page ?? { url: "https://canvas.example.edu/courses/1/pages/intro", html: "<p>x</p>" });
    },
  };
  const h = makeHelper(layer);
  // The background returns several reply shapes; the checks read them loosely.
  const helper = h as unknown as { external: (m: unknown, s: unknown) => Promise<R | undefined>; read: (u: string, a: string) => Promise<R>; sendTab: typeof h.sendTab; consented: typeof h.consented };
  return { helper, calls, names: () => calls.map((c) => c[0]) };
}

export default async function check() {
  // Addresses: web pages only; the browser's own pages, Arc itself and quiz attempts are refused before any tab opens.
  for (const u of ["file:///etc/passwd", "chrome://settings", "javascript:alert(1)", "data:text/html,hi", "about:blank", "chrome-extension://abc/x.html", "https://user:pw@canvas.example.edu/", "not a url"]) assert.equal(refuseUrl(u), LINES.scheme, u);
  assert.equal(refuseUrl("https://chromewebstore.google.com/detail/x"), LINES.browser);
  assert.equal(refuseUrl("http://localhost:3000/?doc=1"), LINES.arc);
  for (const u of ["https://school.instructure.com/courses/12/quizzes/34/take", "https://moodle.example.edu/mod/quiz/attempt.php?attempt=5", "https://moodle.example.edu/mod/quiz/startattempt.php?cmid=3", "https://bb.example.edu/webapps/assessment/take/launch.jsp?course_assessment_id=_1_1", "https://d2l.example.edu/d2l/lms/quizzing/user/attempt/quiz_start_frame_auto.d2l?qi=1"]) assert.equal(refuseUrl(u), LINES.attempt, u);
  for (const u of ["https://canvas.example.edu/courses/1/pages/intro", "https://canvas.example.edu/courses/1/quizzes/34", "https://moodle.example.edu/mod/quiz/view.php?id=3", "http://127.0.0.1:8765/course/pages/cells"]) assert.equal(refuseUrl(u), null, u);
  assert.ok(isArcOrigin("http://localhost:3000") && isArcOrigin("https://arc-production-815e237c.up.railway.app"));
  for (const o of ["https://evil.example", "http://localhost:3001", "http://localhost", "null", undefined]) assert.equal(isArcOrigin(o), false, String(o));
  assert.deepEqual(allowedSites(["http://localhost:3000/*", "https://canvas.example.edu/*"]), ["https://canvas.example.edu"]);
  assert.deepEqual(matchFrames([{ n: 0, src: "https://tool.example/a?x=1" }, { n: 1, src: "https://other.example/" }], [{ url: "https://tool.example/a?x=2", html: "<p>t</p>" }]), [{ n: 0, html: "<p>t</p>" }]);

  // A page that is not Arc gets no answer at all, and nothing is done.
  {
    const s = stub({ allowed: ["https://canvas.example.edu/*"] });
    for (const sender of [{ origin: "https://evil.example" }, { origin: "http://localhost:3001" }, {}])
      assert.equal(await s.helper.external({ type: "read", url: "https://canvas.example.edu/courses/1/pages/intro" }, sender), undefined);
    assert.deepEqual(s.calls, []);
    assert.deepEqual(await s.helper.external({ type: "ping" }, { origin: "http://localhost:3000", tab: { active: true } }), { ok: true, version: "test" });
  }
  // A site not yet allowed: the consent page opens; "not now" fetches nothing and opens no tab.
  {
    const s = stub();
    const r = await s.helper.external({ type: "read", url: "https://canvas.example.edu/courses/1/pages/intro" }, { origin: "http://localhost:3000", tab: { active: true } });
    assert.equal(r?.code, "declined");
    assert.deepEqual(s.names(), ["has", "consent"]);
  }
  // Allowed on the consent page: read in a background tab, posted to the Arc that asked, the tab closed.
  {
    const s = stub({ consent: true });
    const r = await s.helper.external({ type: "read", url: "https://canvas.example.edu/courses/1/pages/intro" }, { origin: "https://arc-production-815e237c.up.railway.app", tab: { active: true } });
    assert.equal(r?.id, "f".repeat(32));
    assert.deepEqual(s.names(), ["has", "consent", "has", "openHidden", "run", "fetch", "close"]);
    assert.equal(s.calls.find((c) => c[0] === "fetch")![1], "https://arc-production-815e237c.up.railway.app/api/ingest");
  }
  // Sent to a sign-in page on another site: nothing read, tab closed. A failure inside the tab: tab closed too.
  {
    const s = stub({ allowed: ["https://canvas.example.edu/*"], finalUrl: "https://sso.example.edu/login" });
    assert.equal((await s.helper.read("https://canvas.example.edu/courses/1/pages/intro", "http://localhost:3000")).code, "signin");
    assert.ok(!s.names().includes("run") && s.names().includes("close"));
    const t = stub({ allowed: ["https://canvas.example.edu/*"], throwOnRun: true });
    assert.equal((await t.helper.read("https://canvas.example.edu/courses/1/pages/intro", "http://localhost:3000")).code, "failed");
    assert.ok(t.names().includes("close"));
    const q = stub({ allowed: ["https://canvas.example.edu/*"], finalUrl: "https://canvas.example.edu/courses/1/quizzes/3/take" });
    assert.equal((await q.helper.read("https://canvas.example.edu/courses/1/quizzes/3", "http://localhost:3000")).error, LINES.attempt);
    assert.ok(!q.names().includes("run"));
  }
  // file:, chrome:, javascript: and quiz attempts from Arc: refused with no permission check and no tab.
  {
    const s = stub({ allowed: ["https://canvas.example.edu/*"] });
    for (const u of ["file:///x", "chrome://history", "javascript:alert(1)", "https://canvas.example.edu/courses/1/quizzes/3/take"]) assert.equal((await s.helper.external({ type: "read", url: u }, { origin: "http://localhost:3000", tab: { active: true } }))?.code, "refused");
    assert.deepEqual(s.calls, []);
  }
  // Rate limit per site, and only from the Arc tab the student is on.
  {
    const clock = { t: 0 };
    const s = stub({ allowed: ["https://canvas.example.edu/*"], clock });
    const ask = () => s.helper.read("https://canvas.example.edu/courses/1/pages/intro", "http://localhost:3000");
    assert.ok((await ask()).id);
    clock.t += 500;
    assert.equal((await ask()).code, "rate", "two reads within two seconds");
    for (let k = 0; k < 29; k++) {
      clock.t += 2500;
      assert.ok((await ask()).id, `read ${k + 2}`);
    }
    clock.t += 2500;
    assert.equal((await ask()).error, LINES.tooMany, "the thirty-first read in ten minutes");
    clock.t += 10 * 60_000;
    assert.ok((await ask()).id, "allowed again later");
    const hidden = await s.helper.external({ type: "read", url: "https://canvas.example.edu/courses/1/pages/intro" }, { origin: "http://localhost:3000", tab: { active: false } });
    assert.equal(hidden?.code, "inactive");
  }
  // "Send this tab": read in place (no consent), posted to the configured Arc, opened there.
  {
    const s = stub();
    await s.helper.sendTab({ id: 3, url: "https://canvas.example.edu/courses/1/quizzes/3/take" });
    assert.deepEqual(s.names(), ["run", "fetch", "openTab"]);
    assert.equal(s.calls.at(-1)![1], `http://localhost:3000/#doc=${"f".repeat(32)}`);
  }
}
