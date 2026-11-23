// The real Arc helper (extension/), loaded in a browser, sending a signed-in page to a running Arc:
//   npx tsx scripts/extension-e2e.ts [arc origin, default http://localhost:3000]
// Needs Arc running at that origin, and Playwright's own Chromium (npx playwright-core install chromium): branded Chrome ignores
// --load-extension. Spends nothing. What it cannot do: press the real shortcut. A test cannot give the "activeTab" grant a key
// press gives, so the copy under test gets the fixture's address as a host permission and the toolbar click is dispatched in the
// service worker. Everything after that click is the shipped code: extract.js in the tab, the POST to /api/ingest, the Arc tab.
import assert from "node:assert";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { start } from "./private-fixture.mjs";

const ARC = (process.argv.find((a) => /^https?:\/\//.test(a)) ?? "http://localhost:3000").replace(/\/$/, "");
const PORT = Number(process.env.FIXTURE_PORT) || 8776;
const SITE = `http://127.0.0.1:${PORT}`;
// The extension's own global, inside its service worker; the repo has no Chrome typings.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const chrome: any;

(async () => {
  const dir = mkdtempSync(join(tmpdir(), "arc-ext-"));
  const ext = join(dir, "extension");
  cpSync("extension", ext, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
  manifest.host_permissions.push(`${SITE}/*`, `${ARC}/*`); // stands in for the key press's activeTab grant (see the header)
  manifest.content_scripts[0].matches.push(`${ARC}/*`);
  writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest));

  const fixture = await start(PORT);
  const ctx = await chromium.launchPersistentContext(join(dir, "profile"), {
    headless: true,
    channel: "chromium",
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  try {
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 15_000 }));
    const version = await sw.evaluate(() => chrome.runtime.getManifest().version);
    console.log(`1. the helper's service worker started (version ${version})`);
    await sw.evaluate((origin) => chrome.storage.sync.set({ origin }), ARC);

    const page = await ctx.newPage();
    await page.goto(`${SITE}/login`); // sets the fixture's cookie and shows the Cells page
    await page.waitForLoadState("networkidle");
    const arcTab = ctx.waitForEvent("page", { timeout: 60_000 });
    await sw.evaluate(async (site) => {
      const [tab] = await chrome.tabs.query({ url: `${site}/*` });
      chrome.action.onClicked.dispatch(tab);
    }, SITE);
    const arc = await arcTab;
    await arc.waitForURL((u) => u.href.startsWith(`${ARC}/`), { timeout: 60_000 });
    assert.match(arc.url(), /#doc=/, `the helper opened ${arc.url()}, not a handed-over page`);
    console.log("2. the click read the signed-in tab and opened Arc with the page handed over (the id is in the fragment)");

    const title = arc.locator("#twin-title");
    await title.waitFor({ timeout: 90_000 });
    assert.match(await title.innerText(), /cells/i);
    console.log(`3. Arc shows the page: "${(await title.innerText()).trim()}"`);

    const home = await ctx.newPage();
    await home.goto(`${ARC}/`);
    await home.locator(".lp-helper-on").waitFor({ timeout: 30_000 });
    console.log("4. the start page says the helper is installed");
    console.log("extension e2e ok");
  } finally {
    await ctx.close();
    fixture.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exit(1);
});
