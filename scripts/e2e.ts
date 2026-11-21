// End to end check of the running app, in a headless Chrome, through what a student would do and hear:
//   npm run e2e [-- --base http://localhost:3000] [--only <name>] [--live] [--headed]
// Needs the app running at --base (it is never started, stopped or restarted here) and Google Chrome (playwright-core, channel "chrome").
// DEFAULT = OFFLINE, SPENDS NOTHING: pages, PDFs, lectures and tours come from the app's stored results (.cache); the live fetch the page asks for
// next is answered with the stored copy, the second voice (Gemini Live relay) and the server's search are answered inside the page, and no
// typed request goes to a model. A page that is not stored would be fetched (and a tour built) by the server, so keep the pages below stored.
// --live adds ONE scenario ("live") that asks the models: about 6 Gemini Live question sessions, 1 narrowing call and the decisions that go
// with them (a few cents at most). Run it rarely. Exit code 1 on any FAIL; KNOWN rows are product bugs the suite documents.
// On failure a screenshot and the event log of that scenario are saved under a temp folder, printed at the end.
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fail, launch, type Opts } from "./e2e/lib";
import { scenarios, type Scenario } from "./e2e/scenarios";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const flag = (k: string) => argv.includes(`--${k}`);
const base = opt("base", "http://localhost:3000").replace(/\/$/, "");
const only = opt("only", "");
const live = flag("live");
const out = mkdtempSync(join(tmpdir(), "arc-e2e-"));
const o: Opts = { base, headed: flag("headed"), out };

const budget = async () => {
  try {
    const d = await (await fetch(`${base}/api/budget`, { signal: AbortSignal.timeout(5000) })).json();
    const by = Object.fromEntries(Object.entries(d.byFeature as Record<string, { calls: number }>).map(([k, v]) => [k, v.calls]));
    return { gemini: Number(d.geminiUsd), calls: Object.values(by).reduce((n, c) => n + c, 0), by, bd: Number(d.brightData?.unlocker ?? 0) + Number(d.brightData?.serp ?? 0) + Number(d.brightData?.browserNav ?? 0) };
  } catch {
    return null;
  }
};

/** Proves what is being tested: the address, and the folder of the process that listens on its port. */
async function prove(): Promise<boolean> {
  const u = new URL(base);
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  console.log(`base: ${base}   mode: ${live ? "LIVE (the \"live\" scenario asks the models and costs a few cents)" : "offline (spends nothing; add --live for the model checks)"}`);
  try {
    const res = await fetch(base, { signal: AbortSignal.timeout(8000) });
    const html = await res.text();
    if (!res.ok || !/Ask Arc anything/.test(html)) throw new Error(`answered ${res.status} but it does not look like Arc (no "Ask Arc anything" on the start page)`);
  } catch (e) {
    console.error(`FAIL: nothing answers at ${base}: ${e instanceof Error ? e.message : e}`);
    return false;
  }
  try {
    const pid = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t | head -1`, { encoding: "utf8" }).trim();
    const cwd = pid ? execSync(`lsof -a -p ${pid} -d cwd -Fn | grep '^n' | cut -c2-`, { encoding: "utf8" }).trim() : "";
    console.log(`listener on port ${port}: pid ${pid || "?"}, working folder ${cwd || "unknown (not a local process?)"}`);
  } catch {
    console.log(`listener on port ${port}: unknown (lsof found nothing)`);
  }
  return true;
}

const ico = { pass: "pass", FAIL: "FAIL", skip: "skip", known: "KNOWN" } as const;

(async () => {
  if (!(await prove())) process.exit(2);
  const picked = scenarios.filter((s) => (only ? s.name === only : true) && (s.live ? live || only === s.name : true));
  if (only && !picked.length) {
    console.error(`no scenario named "${only}". Names: ${scenarios.map((s) => s.name).join(", ")}`);
    process.exit(2);
  }
  const before = await budget();
  const browser = await launch(o);
  const rows: { s: Scenario; state: keyof typeof ico; sec: number; why: string; where?: string }[] = [];
  const t0 = Date.now();
  try {
    for (const s of picked) {
      const t = Date.now();
      let state: keyof typeof ico = "pass", why = "", where: string | undefined;
      const ctl = { sess: null as import("./e2e/lib").Sess | null };
      try {
        const r = await Promise.race([
          s.run({ browser, o, base, live, attach: (x) => void (ctl.sess = x) }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Fail("the scenario to finish", `still running after ${s.limit ?? 90} s`)), (s.limit ?? 90) * 1000)),
        ]);
        if (r && typeof r === "object" && "skip" in r) (state = "skip"), (why = String(r.skip));
        if (r && typeof r === "object" && "note" in r) why = `note: ${String(r.note)}`;
        if (ctl.sess?.posts.length) throw new Fail("no request to move the real pointer (a POST to /api/pointer)", `${ctl.sess.posts.length} were made (all aborted here)`);
        if (s.known && state === "pass") why = "known failure no longer fails: remove the mark";
      } catch (e) {
        const msg = e instanceof Fail ? `expected ${e.expected}\n        saw ${e.saw}` : e instanceof Error ? `error: ${e.message.split("\n")[0]}` : String(e);
        state = s.known ? "known" : "FAIL";
        why = s.known ? `${s.known}\n        (now: ${msg.replace(/\n\s+/g, "; ")})` : msg;
        if (ctl.sess && state === "FAIL") where = await ctl.sess.dump(s.name);
      } finally {
        await ctl.sess?.close();
      }
      const sec = (Date.now() - t) / 1000;
      rows.push({ s, state, sec, why, where });
      console.log(`${ico[state].padEnd(5)} ${s.name.padEnd(12)} ${sec.toFixed(1).padStart(6)}s  ${s.title}${why ? `\n        ${why}` : ""}`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  const after = await budget();
  const n = (st: string) => rows.filter((r) => r.state === st).length;
  console.log(`\n${rows.length} scenarios in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${n("pass")} pass, ${n("FAIL")} FAIL, ${n("known")} known failures, ${n("skip")} skipped`);
  if (before && after) {
    const d = { usd: after.gemini - before.gemini, calls: after.calls - before.calls, bd: after.bd - before.bd };
    const feat = Object.keys(after.by).map((k) => [k, after.by[k] - (before.by[k] ?? 0)] as const).filter(([, n]) => n).map(([k, n]) => `${k} +${n}`).join(", ");
    console.log(`budget during the run: Gemini +$${d.usd.toFixed(5)} (${d.calls} calls${feat ? `: ${feat}` : ""}), Bright Data +${d.bd} requests${!live && (d.calls || d.bd) ? "  <- WARNING: a default run should pay for nothing (another user of the app can be the cause)" : ""}`);
  }
  const bad = rows.filter((r) => r.where);
  if (bad.length) console.log(`screenshots and event logs: ${out}\n${bad.map((r) => `  ${r.where}.png`).join("\n")}`);
  process.exit(n("FAIL") ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
