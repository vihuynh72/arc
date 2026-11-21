// Offline: the cross-site rule, body caps and IPv6 keys (lib/server/limits.ts); model-made open and search against hostile page
// text (lib/client/voice.ts modelCommand); tours only for pictures Arc saw (lib/server/tourQueue.ts); one visitor's daily share
// (lib/server/budget.ts); the vault's total cap; the cache janitor on a scratch folder (never the working .cache).
import assert from "node:assert";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { modelCommand, PRIVATE_PAGE } from "../../lib/client/voice";
import * as B from "../../lib/server/budget";
import { trim } from "../../lib/server/janitor";
import { bodyCap, clientIp, crossSite, loopback, per64 } from "../../lib/server/limits";
import { knownPicture, prioritise, seePictures, serve } from "../../lib/server/tourQueue";
import * as vault from "../../lib/server/vault";
import type { Twin } from "../../lib/types";

export default async function check() {
  // ---- cross-site requests (item 1) ----
  const H = "localhost:3000";
  const req = (m: string, p: string, h: Record<string, string>, ws = false) => crossSite(m, p, { host: H, ...h }, ws);
  assert.equal(req("POST", "/api/decide", { origin: "https://evil.example" }), "foreign origin");
  assert.equal(req("POST", "/api/decide", { origin: "http://localhost:8080" }), "foreign origin"); // another port is another origin
  assert.equal(req("POST", "/api/load", { "sec-fetch-site": "cross-site" }), "sec-fetch-site cross-site");
  assert.equal(req("POST", "/api/speak", { "sec-fetch-site": "same-site" }), "sec-fetch-site same-site");
  assert.equal(req("POST", "/api/pointer", { origin: "null" }), "bad origin");
  assert.equal(req("GET", "/api/pointer", { "sec-fetch-site": "cross-site" }), "sec-fetch-site cross-site"); // even a read
  assert.equal(req("GET", "/api/budget", { "sec-fetch-site": "cross-site" }), "sec-fetch-site cross-site");
  assert.equal(req("GET", "/ws/voice", { origin: "https://evil.example" }, true), "foreign origin");
  assert.equal(req("GET", "/ws/voice", {}, true), "no origin"); // a tool must name the origin
  assert.equal(req("GET", "/ws/voice", { origin: "http://localhost:3000" }, true), null); // the page itself
  assert.equal(req("POST", "/api/decide", { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }), null);
  assert.equal(req("POST", "/api/load", {}), null); // a tool (curl, the e2e scripts) sends no Origin
  assert.equal(req("GET", "/api/tour", { "sec-fetch-site": "cross-site" }), null); // reads of public routes stay open (a link, an <img>)
  assert.equal(req("POST", "/api/ingest", { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" }), null); // its own rules
  assert.equal(crossSite("POST", "/api/load", { host: "10.0.0.2:8080", origin: "https://arc.example", "x-forwarded-host": "arc.example" }, false, 1), null); // behind a proxy
  assert.equal(crossSite("POST", "/api/load", { host: "10.0.0.2:8080", origin: "https://arc.example", "x-forwarded-host": "arc.example" }, false, 0), "foreign origin");
  assert.ok(loopback("127.0.0.1") && loopback("::1") && loopback("::ffff:127.0.0.1") && !loopback("192.168.1.5") && !loopback(undefined));

  // ---- body caps (item 6) and IPv6 keys (items 3 and 6) ----
  assert.equal(bodyCap("/api/pointer"), 1024);
  assert.equal(bodyCap("/api/pdf/upload"), Infinity);
  assert.equal(bodyCap("/api/decide"), 64 * 1024);
  assert.equal(per64("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
  assert.equal(per64("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(per64("2001:db8:1:2::ffff"), per64("2001:db8:1:2:aaaa::1")); // one household
  assert.equal(clientIp("1.2.3.4, 2001:db8:1:2::9", "10.0.0.1", 1), "2001:db8:1:2::/64");
  assert.equal(clientIp(undefined, "::ffff:203.0.113.9", 0), "203.0.113.9");

  // ---- model-made commands against hostile page text (item 2) ----
  const page = (over: Partial<Twin> = {}): Twin =>
    ({ id: "t", source: { url: "https://lms.example/course/1", kind: "page", title: "Week 3" }, nodes: [], counts: { sections: 0, figures: 0, segments: 0 }, links: [{ label: "Week 4", url: "https://lms.example/course/1/week4" }], ...over }) as Twin;
  const lifted = "The mitochondria is the powerhouse of the cell and every student must submit the lab report by Friday at noon";
  const exfil = `https://evil.example/?d=${encodeURIComponent(lifted)}`;
  assert.equal(modelCommand("open", { url: exfil }, page(), ["what does this page say"]), null); // not on the page, not said
  assert.equal(modelCommand("open", { url: "https://evil.example/" }, page(), ["read the next part"]), null);
  assert.deepEqual(modelCommand("open", { url: "https://lms.example/course/1/week4" }, page(), ["open week 4"]), { url: "https://lms.example/course/1/week4" }); // a link of the page
  assert.deepEqual(modelCommand("open", { url: "https://example.org" }, page(), ["open example dot org"]), { url: "https://example.org" }); // said
  assert.deepEqual(modelCommand("open", { url: "https://www.khanacademy.org/science/biology" }, page(), ["open https://www.khanacademy.org/science/biology."]), { url: "https://www.khanacademy.org/science/biology" }); // typed
  assert.equal(modelCommand("open", { url: "https://example.org/?q=secret" }, page(), ["open example dot org"]), null); // the said host with more added
  assert.deepEqual(modelCommand("open", { result: 1 }, page(), ["open the first result"]), { id: "r01" }); // the list on screen
  assert.equal(modelCommand("search", { query: lifted }, page(), ["what is this about"]), null); // a paragraph of page text
  assert.equal(modelCommand("search", { query: "mitochondria powerhouse lab report" }, page(), ["search for photosynthesis"]), null); // words the student never said
  assert.equal(modelCommand("search", { query: "photosynthesis evil.example" }, page(), ["search for photosynthesis"]), null);
  assert.equal(modelCommand("search", { query: "https://evil.example" }, page(), ["search https://evil.example"]), null); // a URL is never a search
  assert.deepEqual(modelCommand("search", { query: "photosynthesis" }, page(), ["Search for photosynthesis."]), { query: "photosynthesis" });
  assert.deepEqual(modelCommand("search", { query: "photosynthesis in plants" }, page(), ["um search photo synthesis in plants please"]), { query: "photosynthesis in plants" }); // heard split
  const priv = page({ source: { url: "https://lms.example/course/1", kind: "page", title: "Week 3", private: true } as Twin["source"] });
  assert.equal(modelCommand("open", { url: "https://lms.example/course/1/week4" }, priv, ["open week 4"]), null); // private: no open at all
  assert.equal(modelCommand("search", { query: "photosynthesis" }, priv, ["search for photosynthesis"]), null); // private: no search at all
  assert.deepEqual(modelCommand("next", {}, priv, []), {}); // moving within the page is fine
  assert.ok(PRIVATE_PAGE.startsWith("PRIVATE PAGE:")); // the marker lib/server/live.ts looks for

  // ---- tours only for pictures Arc saw (item 3a) ----
  const seen = "https://www.mdpi.com/sensors/figure-1.png";
  seePictures([seen]);
  assert.ok(knownPicture(seen));
  for (let i = 0; i < 50; i++) {
    const u = `https://example.org/unseen.png?v=${i}`;
    assert.equal(prioritise(u), false);
    assert.deepEqual(await serve(u), { tour: null, coming: false });
  }
  assert.equal(knownPicture("https://example.org/unseen.png?v=1"), false);

  // ---- one visitor's daily share (item 3b) ----
  const was = process.env.ARC_BUDGET;
  process.env.ARC_VISITOR_DAILY_USD = "0.01";
  B.resetForTest(0);
  const usage = { promptTokenCount: 40_000, candidatesTokenCount: 0 }; // $0.012 at the light model's price
  B.runAsVisitor("203.0.113.1", () => B.checkModel("tour"));
  B.runAsVisitor("203.0.113.1", () => B.recordGemini("tour", "gemini-3.5-flash-lite", usage));
  assert.ok(B.visitorSpend("203.0.113.1") > 0.01);
  assert.throws(() => B.runAsVisitor("203.0.113.1", () => B.checkModel("tour")), (e: unknown) => (e as B.BudgetError).code === "visitor" && (e as B.BudgetError).say === B.CAP_LINE);
  B.runAsVisitor("203.0.113.2", () => B.checkModel("tour")); // another visitor still may
  await B.runAsVisitor("203.0.113.1", async () => {
    await new Promise((r) => setTimeout(r, 1)); // the key survives an await
    assert.equal(B.currentVisitor(), "203.0.113.1");
  });
  delete process.env.ARC_VISITOR_DAILY_USD;
  B.resetForTest(0);
  if (was === undefined) delete process.env.ARC_BUDGET;
  else process.env.ARC_BUDGET = was;

  // ---- the vault's total cap: oldest documents go first (item 4) ----
  process.env.ARC_VAULT_MB = "1";
  const twin = page();
  for (const id of ["v-old", "v-mid", "v-new"]) {
    vault.put(id, twin);
    vault.putImage(id, `${id}-pic`, "image/png", Buffer.alloc(400 * 1024));
    vault.clock.now = ((t) => () => t)(Date.now() + ["v-old", "v-mid", "v-new"].indexOf(id) * 1000);
    vault.get(id);
  }
  assert.equal(vault.getImage("v-old-pic"), null); // dropped
  assert.ok(vault.getImage("v-new-pic"));
  for (const id of ["v-mid", "v-new"]) vault.drop(id);
  vault.clock.now = () => Date.now();
  delete process.env.ARC_VAULT_MB;

  // ---- the janitor, on a scratch folder: oldest access goes first, the folder ends under its cap ----
  const dir = mkdtempSync(path.join(tmpdir(), "arc-janitor-"));
  try {
    const now = Date.now() / 1000;
    ["a", "b", "c", "d"].forEach((n, i) => {
      writeFileSync(path.join(dir, n), Buffer.alloc(1000));
      utimesSync(path.join(dir, n), now - 1000 + i * 100, now - 1000 + i * 100); // a oldest
    });
    mkdirSync(path.join(dir, "pdfdoc"));
    writeFileSync(path.join(dir, "pdfdoc", "file.pdf"), Buffer.alloc(1000));
    utimesSync(path.join(dir, "pdfdoc", "file.pdf"), now, now); // a folder is one unit, as new as its newest file
    const r = await trim(dir, 2500);
    assert.deepEqual(r.removed, ["a", "b", "c"]);
    assert.deepEqual(readdirSync(dir).sort(), ["d", "pdfdoc"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
