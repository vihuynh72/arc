// The no-install routes against the fixture and a running Arc (default http://localhost:3000), in headless Chrome:
// the bookmarklet (window.open + postMessage), the console hand-off (window.name, same tab), and the structure-only probe.
//   npx tsx scripts/handoff-e2e.ts [arc origin, default http://localhost:3000]
import assert from "node:assert";
import { execSync } from "node:child_process";
import { chromium } from "playwright-core";
import { start } from "./private-fixture.mjs";

const ARC = (process.argv[2] ?? "http://localhost:3000").replace(/\/+$/, "");
const gen = (arg = "") => execSync(`node scripts/bookmarklet.mjs ${ARC} ${arg}`).toString().trim();
(async () => {
  const fx = await start(8786);
  const b = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const ctx = await b.newContext();
    const tab = await ctx.newPage();
    await tab.goto("http://127.0.0.1:8786/login");
    await tab.goto("http://127.0.0.1:8786/course/pages/cells");
    await tab.waitForSelector("article");

    // 1. Bookmarklet: a click runs it (a real user gesture, as on the bookmarks bar).
    const code = decodeURIComponent(gen().slice("javascript:".length));
    await tab.evaluate((c) => {
      const btn = document.createElement("button");
      btn.id = "bm";
      btn.onclick = () => (0, eval)(c);
      document.body.append(btn);
    }, code);
    const [arcTab] = await Promise.all([ctx.waitForEvent("page"), tab.click("#bm")]);
    await arcTab.waitForSelector("#twin-title", { timeout: 30_000 });
    const t1 = await arcTab.textContent("#twin-title");
    const figs = await arcTab.locator("img[src*='/api/ingest?img=']").count();
    console.log(`1. bookmarklet: Arc opened "${t1}", ${figs} picture(s) from memory, address now ${new URL(arcTab.url()).pathname}${new URL(arcTab.url()).search}`);
    assert.match(t1 ?? "", /Cells and membranes/);
    assert.equal(new URL(arcTab.url()).search, "", "the private id left the address bar");

    // 2. Console, same tab, window.name.
    await tab.evaluate(gen("--console"));
    await tab.waitForURL((u) => u.origin === ARC, { timeout: 30_000 });
    await tab.waitForTimeout(4000);
    console.log("   status:", await tab.textContent(".status"), "| name:", await tab.evaluate(() => window.name.slice(0, 20)));
    await tab.waitForSelector("#twin-title", { timeout: 30_000 });
    console.log(`2. console hand-off: "${await tab.textContent("#twin-title")}", window.name now ${(await tab.evaluate(() => window.name.length))} chars`);

    // 2b. A page that claims to be another site than the one sending it is refused.
    await tab.goto("http://127.0.0.1:8786/course/pages/energy");
    await tab.evaluate(`(() => { const b = document.createElement("button"); b.id = "fake"; b.onclick = () => { const w = window.open("${ARC}/?receive=1"); addEventListener("message", (e) => { if (e.source === w && e.data && e.data.type === "arc:ready") w.postMessage({ type: "arc:page", page: JSON.stringify({ url: "https://school.instructure.com/courses/1/pages/x", html: "<main><h1>Fake</h1><p>Words.</p></main>" }) }, "${ARC}"); }); }; document.body.append(b); })()`);
    const [fake] = await Promise.all([ctx.waitForEvent("page"), tab.click("#fake")]);
    await fake.waitForFunction(() => /did not arrive/.test(document.querySelector(".status")?.textContent ?? ""), null, { timeout: 15_000 });
    console.log(`2b. page claiming another site: "${await fake.textContent(".status")}", title shown: ${await fake.locator("#twin-title").count()}`);
    await fake.close();

    // 3. The probe: structure only.
    const p = await ctx.newPage();
    await p.goto("http://127.0.0.1:8786/course/pages/cells");
    await p.waitForSelector("article");
    const out = await p.evaluate(gen("--probe"));
    const text = JSON.stringify(out);
    console.log("3. probe:", text.slice(0, 700));
    for (const words of ["membrane", "Cells and", "ZEBRAQUARTZ", "Biology", "?", "=", "&"]) assert.ok(!text.includes(words), `probe leaked: ${words}`);
  } finally {
    await b.close();
    fx.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
