#!/usr/bin/env node
// The one way to verify a change before it is merged (README: CONTRIBUTING.md). Plain Node, no dependencies, no keys, no spend.
//
//   npm run check                 quick gate: typecheck, lint, selfcheck
//   npm run factory               quick gate, then a scratch copy: build there, start the production server there offline,
//                                 run the e2e suite against it, stop that server, delete the copy
//   node scripts/factory.mjs --ci build and serve in THIS folder (a CI checkout has no dev server) and run e2e only
//
// Flags: --quick (gate only)  --skip-e2e  --only <scenario>  --keep (leave the scratch copy)  --ci  --retries <n> (default 1)
//        --no-check (skip the quick gate, for e2e work)  --artifacts <dir> (logs and e2e screenshots; default: a temp folder, kept only when something failed)
//        --cache <dir|none> (where stored pages come from; default: this repo's .cache, else the main checkout's)
//        --cache-dirs a,b (which .cache folders to copy into the scratch copy; default: the ones the e2e scenarios read)
// Exit code 1 when any step failed. A scenario that fails, then passes when run alone again, is reported FLAKY and does not fail the
// gate (it is listed so it can be fixed); one that fails twice does.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(`--${k}`);
const opt = (k, d = "") => (flag(k) ? argv[argv.indexOf(`--${k}`) + 1] ?? d : d);
const CI = flag("ci");
const KEEP = flag("keep");
const RETRIES = Number(opt("retries", "1"));
const darwin = process.platform === "darwin";

// What the offline production server needs. Nothing else is passed on: no key of the caller's shell reaches it, so nothing can call out.
//  ARC_OFFLINE=1  stored copies only, no live fetch (lib/server/fetch.ts)       ARC_LIMITS=off / ARC_BUDGET=off  the guard is for a hosted copy
//  ARC_KOKORO=off no local voice model (e2e answers /api/speak with silent audio in the page; the model is 600 MB and would be downloaded)
const serverEnv = (port) => ({
  ...Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "SHELL", "USER"].filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
  NODE_ENV: "production", PORT: String(port), ARC_OFFLINE: "1", ARC_LIMITS: "off", ARC_BUDGET: "off", ARC_KOKORO: "off", NEXT_TELEMETRY_DISABLED: "1",
});

// Stored pages the e2e scenarios read (.cache is gitignored, so a fresh checkout has none; fixtures/ travels with the code).
// Found by copying folders in turn: `pdf` holds the PDF of the pdf scenario, `video` the lecture of the two lecture scenarios; the other 15 need none.
const CACHE_DIRS = opt("cache-dirs") ? opt("cache-dirs").split(",") : ["pdf", "video"];

const rows = []; // { name, state: PASS|FAIL|FLAKY|SKIP, sec, note }
// Scenarios that open a PDF or a lecture the app has stored (found by running the suite with no .cache: these three, and only these, fail).
// Without stored pages they cannot pass, so they are reported SKIP, not FAIL: a missing fixture is not a regression.
const NEEDS_STORED = new Set(["pdf", "lecture", "lecture-k"]);
let stored = false;
let work, scratch, server, listenPort;
const t0 = Date.now();
const fmt = (ms) => (ms / 1000).toFixed(1);
const say = (s = "") => console.log(s);

function add(name, state, sec, note = "") {
  rows.push({ name, state, sec, note });
  say(`${state.padEnd(5)} ${name.padEnd(28)} ${sec.toFixed(1).padStart(6)}s${note ? `  ${note}` : ""}`);
}

/** Runs a command quietly into a log file; shows the tail of the log only when it failed. Returns true on success. */
function step(name, cmd, args, { cwd = ROOT, env, show = false, quiet = false } = {}) {
  const t = Date.now();
  const log = join(work, `${name.replace(/\W+/g, "-")}.log`);
  return new Promise((done) => {
    const p = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const take = (d) => {
      out += d;
      if (show) process.stdout.write(d);
    };
    p.stdout.on("data", take);
    p.stderr.on("data", take);
    p.on("error", (e) => take(`${e.message}\n`));
    p.on("close", (code) => {
      writeFileSync(log, out);
      const ok = code === 0;
      if (!quiet) add(name, ok ? "PASS" : "FAIL", (Date.now() - t) / 1000, ok ? "" : `exit ${code}, log ${log}`);
      if (!ok && !show) say(out.trim().split("\n").slice(-25).map((l) => `    | ${l}`).join("\n"));
      done(ok);
    });
  });
}

const gate = async () => {
  // typegen writes the route types tsc needs (LayoutProps and friends) into .next/types; it touches nothing a dev server reads.
  const a = await step("typecheck", "sh", ["-c", "npx next typegen && npx tsc --noEmit"]);
  const b = await step("lint (errors only)", "npm", ["run", "lint"]);
  const c = await step("selfcheck", "npm", ["run", "selfcheck"]);
  return a && b && c;
};

const freePort = () =>
  new Promise((ok, no) => {
    const s = createServer();
    s.on("error", no);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => (port === 3000 ? freePort().then(ok, no) : ok(port)));
    });
  });

const sh = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });
const listeners = (port) => (sh("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).stdout ?? "").split("\n").filter(Boolean).map(Number);
const cwdOf = (pid) => (sh("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).stdout ?? "").split("\n").find((l) => l.startsWith("n"))?.slice(1);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findCache() {
  const given = opt("cache");
  if (given === "none") return null;
  if (given) return resolve(given);
  // This folder's .cache (selfcheck creates an empty one), else the main checkout's: a worktree has none of its own. The first with stored pages wins.
  const common = sh("git", ["-C", ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout?.trim();
  const list = [join(ROOT, ".cache"), common && join(dirname(common), ".cache")].filter((d) => d && existsSync(join(d, "pages")));
  return list[0] ?? null;
}

function makeScratch() {
  const t = Date.now();
  scratch = mkdtempSync(join(tmpdir(), "arc-factory-copy-"));
  const r = sh("rsync", ["-a", "--exclude=/.next", "--exclude=/node_modules", "--exclude=/.cache", "--exclude=/.git", "--exclude=.env*", "--exclude=/.claude", "--exclude=/arc-helper.zip", `${ROOT}/`, `${scratch}/`]);
  if (r.status !== 0) throw new Error(`rsync failed: ${r.stderr}`);
  const nm = join(ROOT, "node_modules");
  const tries = existsSync(nm)
    ? [darwin ? ["cp", ["-Rc", nm, join(scratch, "node_modules")]] : ["cp", ["-R", "--reflink=auto", nm, join(scratch, "node_modules")]], ["cp", ["-R", nm, join(scratch, "node_modules")]]]
    : [];
  let linked = false;
  for (const [c, a] of tries) {
    if (sh(c, a).status === 0) {
      linked = true;
      break;
    }
    rmSync(join(scratch, "node_modules"), { recursive: true, force: true });
  }
  const how = linked ? "node_modules cloned" : "npm ci";
  const cacheNote = (() => {
    const from = findCache();
    if (!from) return "no stored pages";
    let n = 0;
    for (const d of CACHE_DIRS) if (existsSync(join(from, d))) (cpSync(join(from, d), join(scratch, ".cache", d), { recursive: true }), n++);
    stored = n > 0;
    return `${n} stored-page folders from ${from}`;
  })();
  return { linked, how, cacheNote, sec: (Date.now() - t) / 1000 };
}

async function startServer(dir, port) {
  const logFile = join(work, "server.log");
  mkdirSync(work, { recursive: true });
  // `node --import tsx` and not `npm start`/`tsx`: no wrapper process, so the process started here is the one that listens.
  // (npm start also pins the CPUs with taskset, which a test does not need.)
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], { cwd: dir, env: serverEnv(port), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  let exited = null;
  child.on("exit", (c) => (exited = c ?? "signal"));
  server = { child, dir, port, log: () => writeFileSync(logFile, out) };
  const until = Date.now() + 90_000;
  for (;;) {
    if (exited !== null) throw new Error(`the server exited (${exited}) before it answered:\n${out.trim().split("\n").slice(-15).join("\n")}`);
    if (Date.now() > until) throw new Error(`the server did not answer on port ${port} within 90 s:\n${out.trim().split("\n").slice(-15).join("\n")}`);
    try {
      const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(3000) });
      if (res.ok && /Ask Arc anything/.test(await res.text())) break;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  // Prove what answers: the one process listening on the port is the one started here, and its working folder is the folder under test.
  const pids = listeners(port);
  if (!pids.length) {
    if (sh("which", ["lsof"]).status !== 0) return `answers on ${port} (lsof missing: listener pid not checked)`;
    throw new Error(`port ${port} answers but lsof sees no listener`);
  }
  if (pids.length !== 1 || pids[0] !== child.pid) throw new Error(`port ${port} is held by pid ${pids.join(",")}, not the server started here (pid ${child.pid})`);
  const cwd = cwdOf(child.pid);
  if (cwd && realpathSync(cwd) !== realpathSync(dir)) throw new Error(`the listener's working folder is ${cwd}, not ${dir}`);
  return `pid ${child.pid} listens on ${port}, cwd ${cwd ?? "unknown"}`;
}

/** Stops the server started above, by its process group (the pid this script spawned), and checks the port is free. */
async function stopServer() {
  if (!server) return null;
  const { child, port } = server;
  server.log();
  for (const sig of ["SIGTERM", "SIGKILL"]) {
    if (!alive(child.pid)) break;
    try {
      process.kill(-child.pid, sig);
    } catch {
      /* already gone */
    }
    for (let i = 0; i < 20 && alive(child.pid); i++) await sleep(250);
  }
  const left = listeners(port);
  server = null;
  return left.length ? `port ${port} still held by pid ${left.join(",")}` : null;
}

async function e2e(dir, port, only) {
  const base = `http://localhost:${port}`;
  const run = (args, name) =>
    new Promise((done) => {
      const p = spawn(process.execPath, ["--import", "tsx", "scripts/e2e.ts", "--base", base, ...args], { cwd: dir, env: { ...process.env, TMPDIR: work }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (d) => (out += d, process.stdout.write(d)));
      p.stderr.on("data", (d) => (out += d, process.stderr.write(d)));
      p.on("close", (code) => (writeFileSync(join(work, `e2e-${name}.log`), out), done({ code, out })));
    });
  const parse = (out) =>
    out.split(/^(?=(?:pass|FAIL|skip|KNOWN)\s+\S+\s+[\d.]+s)/m).flatMap((b) => {
      const m = b.match(/^(pass|FAIL|skip|KNOWN)\s+(\S+)\s+([\d.]+)s/);
      return m ? [{ state: m[1], name: m[2], sec: Number(m[3]), why: b.split("\n").slice(1, 4).join(" ") }] : [];
    });
  const t = Date.now();
  const first = await run(only ? ["--only", only] : [], "all");
  const got = parse(first.out);
  if (!got.length) return add("e2e", "FAIL", (Date.now() - t) / 1000, `no scenario ran (exit ${first.code}); see ${work}/e2e-all.log`);
  for (const r of got) {
    if (r.state !== "FAIL") add(`e2e ${r.name}`, r.state === "pass" ? "PASS" : r.state === "KNOWN" ? "KNOWN" : "SKIP", r.sec, r.state === "KNOWN" ? "a product bug the suite documents" : "");
  }
  for (const r of got.filter((x) => x.state === "FAIL")) {
    if (!stored && NEEDS_STORED.has(r.name)) {
      add(`e2e ${r.name}`, "SKIP", r.sec, "needs stored pages (.cache is not in git); not run as a failure");
      continue;
    }
    // The pdf scenario ends by starting a figure's tour. A tour is stored under the address of the server that made it (port included) and the
    // box the browser cropped, so on a fresh port it needs a model call, and with no key it cannot open. Only that last step is excused.
    if (r.name === "pdf" && /expected the figure tour to open/.test(r.why)) {
      add("e2e pdf", "SKIP", r.sec, "passed up to the figure tour, which needs a model call; run npm run e2e on :3000 to cover it");
      continue;
    }
    let state = "FAIL", note = "";
    for (let i = 1; i <= RETRIES && state === "FAIL"; i++) {
      say(`--- ${r.name} failed: running it alone again (${i} of ${RETRIES})`);
      const again = await run(["--only", r.name], `${r.name}-retry${i}`);
      if (again.code === 0 && parse(again.out).some((x) => x.name === r.name && x.state === "pass")) (state = "FLAKY"), (note = "failed once, passed alone on retry: fix its timing");
    }
    if (state === "FAIL") note = `failed twice; ${first.out.includes("screenshots and event logs") ? "screenshots and event logs under" : "see"} ${work}`;
    add(`e2e ${r.name}`, state, r.sec, note);
  }
}

async function main() {
  work = resolve(opt("artifacts") || mkdtempSync(join(tmpdir(), "arc-factory-")));
  mkdirSync(work, { recursive: true });
  say(`logs and artifacts: ${work}\n`);
  if (!CI && !flag("no-check") && !(await gate())) {
    /* keep going: every step runs, the table says which failed */
  }
  if (flag("quick") || flag("skip-e2e")) return;

  let dir = ROOT;
  if (CI) stored = existsSync(join(ROOT, ".cache", "pages"));
  if (!CI) {
    const s = makeScratch();
    dir = scratch;
    add("scratch copy", s.linked || existsSync(join(scratch, "node_modules")) ? "PASS" : "FAIL", s.sec, `${s.how}; ${s.cacheNote}; ${scratch}`);
    if (!s.linked) {
      if (!(await step("npm ci (scratch)", "npm", ["ci"], { cwd: dir }))) return;
    }
  }
  if (!(await step("next build", join(dir, "node_modules/.bin/next"), ["build"], { cwd: dir, env: { ...serverEnv(0), NODE_ENV: "production" } }))) return;
  listenPort = await freePort();
  const t = Date.now();
  try {
    const proof = await startServer(dir, listenPort);
    add("start server", "PASS", (Date.now() - t) / 1000, proof);
  } catch (e) {
    add("start server", "FAIL", (Date.now() - t) / 1000, "");
    say(String(e.message));
    return;
  }
  await e2e(dir, listenPort, opt("only"));
}

async function cleanup() {
  const left = await stopServer().catch((e) => `stopping the server failed: ${e.message}`);
  if (left) add("stop server", "FAIL", 0, left);
  if (scratch && !KEEP) rmSync(scratch, { recursive: true, force: true });
  if (scratch && KEEP) say(`\nscratch copy kept: ${scratch}`);
}

let finished = false;
const finish = async (code) => {
  if (finished) return;
  finished = true;
  await cleanup();
  const bad = rows.some((r) => r.state === "FAIL");
  say(`\n${"step".padEnd(34)} result   seconds`);
  for (const r of rows) say(`${r.name.padEnd(34)} ${r.state.padEnd(7)} ${r.sec.toFixed(1).padStart(7)}`);
  const flaky = rows.filter((r) => r.state === "FLAKY");
  if (flaky.length) say(`\nFLAKY (did not fail the gate, but should be fixed): ${flaky.map((r) => r.name).join(", ")}`);
  say(`\n${bad || code ? "FAILED" : "OK"} in ${fmt(Date.now() - t0)} s`);
  if (bad || code) say(`logs and e2e screenshots: ${work}`);
  else if (!opt("artifacts") && !KEEP) rmSync(work, { recursive: true, force: true });
  process.exit(bad || code ? 1 : 0);
};
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => finish(130));
main().then(() => finish(0), (e) => (console.error(e), add("factory", "FAIL", 0, String(e.message ?? e)), finish(1)));
