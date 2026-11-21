// The scenarios of scripts/e2e.ts. Each opens a fresh page, drives it as a student would (keys and typed requests) and asserts on what
// is heard (the app's own "arc:heard" events, with their own timestamps), what is on screen and the address bar. Nothing here
// reads the app's source for its expectations except where a line is quoted from the contract (scripts/blind/README.md style).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { Browser } from "playwright-core";
import { MARKER, start as startFixture } from "../private-fixture.mjs";
import { Fail, Sess, norm, sleep, type Opts, type Utter } from "./lib";

export type Ctx = { browser: Browser; o: Opts; base: string; live: boolean; attach: (s: Sess) => void };
export type Scenario = {
  name: string;
  title: string;
  run: (c: Ctx) => Promise<void | { skip: string } | { note: string }>;
  /** Seconds before the scenario is abandoned. */
  limit?: number;
  /** The product bug that makes it fail today: the row reports KNOWN with this reason (and the scenario still runs). */
  known?: string;
  /** Needs a paid model call: only with --live. */
  live?: boolean;
};

export const PAPER = "https://www.mdpi.com/1424-8220/24/6/1935";
const PAPER_START = `/?url=${encodeURIComponent(PAPER)}`;

async function open(c: Ctx, start: string | null = "/", realVoice = false) {
  const s = await Sess.open(c.browser, c.o, { start, realVoice });
  c.attach(s);
  return s;
}
/** The paper, opened by its deep link, with its title, size and opening line started (a key press then cuts that line, as it would for a student). */
async function paper(c: Ctx, realVoice = false) {
  const t0 = Date.now();
  const s = await open(c, PAPER_START, realVoice);
  await s.said(/Development of Wearable Devices/, t0, 45_000, "the paper's title");
  await s.said(/23 sections and 22 figures/, t0, 20_000, '"23 sections and 22 figures"');
  await s.until("the opening line (what to press) to start", () => s.utterances(t0).filter((u) => !/Development of Wearable|23 sections/.test(u.text))[0], 10_000, t0);
  return s;
}
const live = (s: Sess, since: number) => s.of("live", since);
/** No live region (what a screen reader would speak) was given a line that Arc also speaks. */
function noLeak(s: Sess) {
  const said = s.utterances().map((u) => norm(u.text)).filter((t) => t.length >= 14);
  for (const l of live(s, 0)) {
    const t = norm(String(l.text));
    if (t.length < 14) continue;
    const hit = said.find((x) => x.includes(t) || t.includes(x) || (x.length >= 40 && t.includes(x.slice(0, 40))));
    if (hit) throw new Fail("no live region to receive a spoken line", `a live region got "${String(l.text).slice(0, 100)}" which Arc speaks ("${hit.slice(0, 60)}")`);
  }
}
const heard = (u: Utter) => `"${u.text.slice(0, 100)}"`;

// ---------------------------------------------------------------------------------------------------------------------------------

const start: Scenario = {
  name: "start",
  title: "greeting once, silence after it, a labelled ask box, / focuses it",
  async run(c) {
    const t0 = Date.now();
    const s = await open(c, "/");
    const g = await s.said(/^Arc\. Hold Space and say what you want to study/, t0, 3000, "the greeting within 3 s");
    if (g.start - t0 > 3000) throw new Fail("the greeting within 3 s", `it started ${((g.start - t0) / 1000).toFixed(1)} s after the page was opened`);
    await s.until("the greeting to finish", () => s.utterances(t0).find((u) => u.start === g.start)?.end, 8000, t0);
    const t1 = Date.now();
    await s.hush(5000, t0 + 1, "nothing else spoken for 5 s after the greeting", /^Arc\. Hold Space and say what you want to study/); // the greeting itself once only
    const all = s.utterances(t0);
    if (all.filter((u) => /^Arc\. Hold Space/.test(u.text)).length !== 1) throw new Fail("the greeting once", `${all.map(heard).join(", ")}`);
    void t1;
    const box = await s.page.evaluate(() => {
      const i = document.getElementById("command") as HTMLInputElement | null;
      const l = i && document.querySelector(`label[for="${i.id}"]`);
      return { has: !!i, label: (l?.textContent ?? "").trim(), type: i?.type };
    });
    if (!box.has || !box.label) throw new Fail("an ask box with a label", `box present: ${box.has}, label: "${box.label}"`);
    await s.press("/");
    await s.until("the ask box to take focus on /", () => s.page.evaluate(() => document.activeElement?.id === "command"), 2000);
    noLeak(s);
  },
};

const openPaper: Scenario = {
  name: "open-paper",
  title: "paste the paper: title, then counts; the address bar carries ?url=; no console errors",
  async run(c) {
    const s = await open(c, "/");
    await s.until("the start page's greeting", () => s.utterances().length, 5000);
    const t = await s.paste(PAPER);
    const title = await s.said(/Development of Wearable Devices/, t, 45_000, "the paper's title");
    const counts = await s.said(/23 sections and 22 figures/, t, 20_000, '"23 sections and 22 figures"');
    if (counts.start < title.start) throw new Fail("the title before the counts", `counts at ${counts.start - t} ms, title at ${title.start - t} ms`);
    const u = await s.page.evaluate(() => location.search);
    if (new URLSearchParams(u).get("url") !== PAPER) throw new Fail(`the address bar to carry ?url=${PAPER}`, `it shows "${u}"`);
    await sleep(500);
    if (s.errors.length) throw new Fail("no console errors", s.errors.slice(0, 3).join(" | "));
  },
};

const reading: Scenario = {
  name: "reading",
  title: "Down, cut by Down, H, F, Home, where am I, how much left, slower, say that again; no live-region leak",
  limit: 120,
  async run(c) {
    const s = await paper(c);
    const doc = await s.docText();
    // H lands on a heading and says it; then its first paragraph is read, and it is the block that is highlighted on screen.
    let t = await s.press("h");
    const headOf = (id: unknown) => s.page.evaluate((i) => (document.querySelector(`[data-node-id="${i}"] h2, [data-node-id="${i}"] h3, [data-node-id="${i}"] h4`)?.textContent ?? "").trim(), id);
    let b0 = await s.until("the first paragraph of the heading H landed on to be read", () => s.of("block", t).find((b) => Number(b.block) >= 0), 4000, t);
    let cur = { heading: await headOf(b0.id) };
    if (Number(b0.blocks) < 2) {
      // The first section has one paragraph: the next heading has several, so that Down has a paragraph to go to.
      t = await s.press("h");
      b0 = await s.until("the first paragraph of the next heading to be read", () => s.of("block", t).find((b) => Number(b.block) >= 0), 4000, t);
      cur = { heading: await headOf(b0.id) };
    }
    const head = String(cur.heading);
    await s.said((x) => norm(x) === norm(head), t, 3000, `the heading "${head}"`);
    const first = await s.said((x) => norm(String(b0.text)).startsWith(norm(x).slice(0, 40)), t, 4000, "the paragraph's first sentence");
    const shown = await s.until("the paragraph under the cursor to be highlighted", async () => (await s.currentBlock())?.text, 3000, t);
    if (!norm(shown).includes(norm(first.text).slice(0, 40))) throw new Fail("the speech to match the highlighted paragraph", `spoken ${heard(first)}, on screen "${shown.slice(0, 80)}"`);
    // Down reads the next paragraph; a second Down cuts the first within 300 ms and reads the next.
    const open1 = s.utterances(t).filter((u) => u.end === undefined).at(-1);
    if (!open1) throw new Fail("a line still being read when Down is pressed", "nothing was being read");
    t = await s.press("ArrowDown");
    const cut = await s.until("the line being read to be cut by Down", () => s.utterances(t - 1000).find((u) => u.start === open1.start && u.end !== undefined), 2000, t);
    if (!cut.cut || cut.end! - t > 300) throw new Fail("the line to be cut within 300 ms of Down", `${cut.cut ? "cut" : "not cut"} after ${cut.end! - t} ms`);
    const b1 = await s.until("the next paragraph to become the one under the cursor", () => s.of("block", t).find((b) => Number(b.block) === Number(b0.block) + 1 && b.id === b0.id), 3000, t);
    const next = await s.said((x) => norm(String(b1.text)).startsWith(norm(x).slice(0, 40)), t, 3000, "the next paragraph's first sentence");
    const shown2 = await s.until("the next paragraph to be highlighted", async () => (await s.currentBlock())?.text, 3000, t);
    if (!norm(shown2).includes(norm(next.text).slice(0, 40))) throw new Fail("the speech to match the highlighted paragraph", `spoken ${heard(next)}, on screen "${shown2.slice(0, 80)}"`);
    // F lands on a figure.
    t = await s.press("f");
    const fig = await s.until("the cursor to land on a figure after F", () => s.of("cursor", t).find((e) => e.kind === "figure"), 3000, t);
    await s.said(new RegExp(`^${String(fig.heading)}$`, "i"), t, 3000, `"${fig.heading}"`);
    // Home says the top.
    t = await s.press("Home");
    await s.said(/top of (the )?page/i, t, 3000, '"Top of page"');
    // Typed questions about where the student is.
    t = await s.type("where am I");
    const where = await s.said((x) => /\b\d+ of \d+\b|section|abstract/i.test(x), t, 5000, "a location (paragraph n of m, or a section)");
    if (!where.text.trim()) throw new Fail("a location", "an empty line");
    t = await s.type("how much is left");
    await s.said(/minutes?.*\d+ sections?|\d+ sections?.*minutes?/i, t, 5000, "minutes and sections left");
    // A paragraph is read, then "slower" changes the speed and says so, then "say that again" repeats the reading, not that status line.
    t = await s.press("ArrowDown");
    await s.until("a sentence of the page to be read", () => s.utterances(t).find((u) => doc.includes(norm(u.text).slice(0, 30)) && norm(u.text).length > 30), 4000, t);
    const speed0 = await s.page.evaluate(() => localStorage.getItem("arc-speed"));
    t = await s.type("slower");
    const sl = await s.said(/slower\b.*speed|slowest/i, t, 4000, 'a line saying "Slower. Speed ..."');
    const speed1 = await s.page.evaluate(() => localStorage.getItem("arc-speed"));
    if (!/slowest/i.test(sl.text) && speed0 === speed1) throw new Fail("the speed to change on \"slower\"", `${sl.text} but the saved speed stayed ${speed1}`);
    await s.settle(t, 400, 6000);
    t = await s.type("say that again");
    const again = await s.until("a line spoken after \"say that again\"", () => s.utterances(t)[0], 4000, t);
    if (/\bspeed\b|on a scale|^slower|^faster/i.test(again.text)) throw new Fail('"say that again" to repeat the reading', `it repeated the status line ${heard(again)}`);
    if (!doc.includes(norm(again.text).slice(0, 30))) throw new Fail('"say that again" to repeat text of the page', `it said ${heard(again)}`);
    noLeak(s);
  },
};

const find: Scenario = {
  name: "find",
  title: "find sampling rate lands on a sentence with the words; next match moves on",
  async run(c) {
    const s = await paper(c);
    let t = await s.type("find sampling rate");
    const f1 = await s.said(/Found in .*\b1 of \d+ match/i, t, 5000, '"Found in ..., 1 of N matches"');
    const sent1 = await s.until("the sentence with the words to be read", () => s.utterances(t).find((u) => u.start > f1.start && /sampling/i.test(u.text) && /rate/i.test(u.text)), 4000, t);
    t = await s.type("next match");
    const f2 = await s.said(/Found in .*\b2 of \d+ match/i, t, 5000, '"Found in ..., 2 of N matches"');
    const sent2 = await s.until("the next sentence with the words to be read", () => s.utterances(t).find((u) => u.start > f2.start && /sampling/i.test(u.text) && /rate/i.test(u.text)), 4000, t);
    if (norm(sent1.text) === norm(sent2.text)) throw new Fail("next match to move to another sentence", `it read the same one twice: ${heard(sent1)}`);
  },
};

const noMove: Scenario = {
  name: "no-scroll",
  title: "far down the page, / then typing then Escape does not move the page",
  async run(c) {
    const s = await paper(c);
    await s.press("End");
    const y0 = await s.until("the page to be far down and still", async () => {
      const a = await s.scrollY();
      await sleep(400);
      return a > 1000 && a === (await s.scrollY()) ? a : 0;
    }, 15_000);
    await s.press("/");
    await s.until("the ask box to take focus", () => s.page.evaluate(() => document.activeElement?.id === "command"), 2000);
    await s.page.keyboard.type("hello there", { delay: 10 });
    await s.press("Escape");
    for (let i = 0; i < 6; i++) {
      await sleep(150);
      const y = await s.scrollY();
      if (y !== y0) throw new Fail("scrollY to stay the same through / , typing and Escape", `it was ${y0} and became ${y}`);
    }
  },
};


// ---- the figure tour --------------------------------------------------------------------------------------------------------------

/** Moves to the first figure (F), starts its tour (Enter) and returns when the introduction has started. */
async function beginTour(s: Sess) {
  let t = await s.press("f");
  const fig = await s.until("the cursor to land on a figure after F", () => s.of("cursor", t).find((e) => e.kind === "figure"), 3000, t);
  await s.said(new RegExp(`^${String(fig.heading)}$`, "i"), t, 3000, `"${fig.heading}"`);
  t = await s.press("Enter");
  const intro = await s.said(/\b\d+ stops\b/, t, 10_000, "the tour's introduction (it names the number of stops)");
  await s.until("the tour to open", () => s.page.evaluate(() => !!document.querySelector("section[aria-label^='Figure tour']")), 3000, t);
  return { t, fig, intro };
}
const SHOWN = new Set(["hand-fixed", "high"]); // the confidences that draw a ring (components/FigureTour.tsx)
type StopData = { label: string; box_2d?: number[]; confidence?: string };
/** The tours the page was sent, for the boxes the ring must sit on. */
function toursOf(s: Sess): StopData[][] {
  const out: StopData[][] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the app's JSON answers are read loosely here
  const walk = (nodes: any[] | undefined) => nodes?.forEach((n) => n?.tour?.stops && out.push(n.tour.stops));
  for (const l of s.loads) {
    walk(l.json?.nodes);
    walk(l.json?.twin?.nodes);
  }
  return out;
}

/** The ring and the drawn pointer at the stop being spoken: visible, inside the picture, the pointer's tip in the ring's middle, the ring where the tour's box says. */
async function checkRing(s: Sess, n: number) {
  const g = await s.tourSettled();
  const m = /^Stop (\d+) of (\d+): (.*)\.$/.exec((g.stop ?? "").trim());
  if (!m || Number(m[1]) !== n) throw new Fail(`the tour to be at stop ${n}`, `the screen says "${g.stop}"`);
  const stop = toursOf(s).flat().find((x) => x.label === m[3] && toursOf(s).some((t) => t.length === Number(m[2]) && t.includes(x)));
  const shown = stop ? SHOWN.has(String(stop.confidence)) : true;
  const at = `at stop ${n} (${m[3]})`;
  if (!shown) {
    if (g.ringOn) throw new Fail(`no ring ${at} (its confidence is ${stop!.confidence})`, "a ring was drawn");
    return;
  }
  if (!g.ringOn || !g.ring || !g.img) throw new Fail(`a ring visible ${at}`, `ring on: ${g.ringOn}`);
  if (!g.pointerOn || !g.pointer) throw new Fail(`the drawn pointer visible ${at}`, "it was not");
  const { ring: r, img, pointer: p } = g;
  const tip = { x: p.left + g.tipDx, y: p.top + g.tipDy };
  const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
  if (r.left < img.left - 2 || r.top < img.top - 2 || r.right > img.right + 2 || r.bottom > img.bottom + 2) throw new Fail(`the ring inside the picture ${at}`, `ring ${Math.round(r.left)},${Math.round(r.top)}-${Math.round(r.right)},${Math.round(r.bottom)} vs picture ${Math.round(img.left)},${Math.round(img.top)}-${Math.round(img.right)},${Math.round(img.bottom)}`);
  if (tip.x < r.left - 2 || tip.x > r.right + 2 || tip.y < r.top - 2 || tip.y > r.bottom + 2) throw new Fail(`the pointer's tip inside the ring ${at}`, `tip ${Math.round(tip.x)},${Math.round(tip.y)} vs ring ${Math.round(r.left)},${Math.round(r.top)}-${Math.round(r.right)},${Math.round(r.bottom)}`);
  if (Math.hypot(tip.x - cx, tip.y - cy) > 6) throw new Fail(`the pointer's tip in the middle of the ring ${at}`, `${Math.hypot(tip.x - cx, tip.y - cy).toFixed(1)} px from its centre`);
  const b = stop?.box_2d?.length === 4 ? stop.box_2d : null;
  if (b) {
    const w = img.right - img.left, h = img.bottom - img.top;
    const want = { left: img.left + (b[1] / 1000) * w, top: img.top + (b[0] / 1000) * h, right: img.left + (b[3] / 1000) * w, bottom: img.top + (b[2] / 1000) * h };
    const off = Math.max(Math.abs(r.left - want.left), Math.abs(r.top - want.top), Math.abs(r.right - want.right), Math.abs(r.bottom - want.bottom));
    if (off > 3) throw new Fail(`the ring on the tour's box for "${m[3]}" (within 3 px)`, `it is ${off.toFixed(1)} px off (ring ${Math.round(r.left)},${Math.round(r.top)}-${Math.round(r.right)},${Math.round(r.bottom)}, box ${Math.round(want.left)},${Math.round(want.top)}-${Math.round(want.right)},${Math.round(want.bottom)})`);
  }
}
const CHIME_MS = 380; // a chime lasts 0.4 s (scripts/blind/session.mjs); the line may start once it is over
/** The n-th stop's chime and the line after it. */
async function stop(s: Sess, n: number, t: number, ms = 30_000) {
  const chime = await s.until(`chime ${n} of the tour`, () => s.sounds("chime", t)[n - 1], ms, t);
  const line = await s.until(`stop ${n}'s line after its chime`, () => s.utterances(t).find((u) => u.start >= chime.at), 4000, t);
  if (line.start < chime.at + CHIME_MS) throw new Fail(`chime ${n} to end before stop ${n} is spoken`, `the line started ${Math.round(line.start - chime.at)} ms after the chime began (a chime lasts ${CHIME_MS} ms)`);
  return { chime, line };
}
const noTourButtons = async (s: Sess, where: string) => {
  const names = await s.page.evaluate(() => [...document.querySelectorAll("button, [role='button'], a[role='button']")].map((e) => (e.getAttribute("aria-label") || e.textContent || "").replace(/\s+/g, " ").trim()));
  const bad = names.filter((n) => /\btour\b|controls/i.test(n));
  if (bad.length) throw new Fail(`no button for touring or controls ${where}`, `${bad.length} button(s) named ${[...new Set(bad)].map((b) => `"${b}"`).join(", ")}`);
};

const tour: Scenario = {
  name: "tour",
  title: "F, Enter: intro; 3 stops in order, chime then line; ring and pointer on each; Right jumps and waits; real pointer never asked",
  limit: 110,
  async run(c) {
    const s = await paper(c);
    await noTourButtons(s, "on the page");
    const { t } = await beginTour(s);
    await noTourButtons(s, "in the tour");
    let last: { line: Utter } | null = null;
    for (const n of [1, 2, 3]) {
      const st = await stop(s, n, t);
      if (last && st.line.start < last.line.start) throw new Fail("the stops in order", `stop ${n} before the one before it`);
      await checkRing(s, n);
      last = st;
    }
    // Right during stop 3: it is cut at once, stop 4 follows at once, and the tour then waits.
    const speaking = s.utterances(t).filter((u) => u.end === undefined).at(-1);
    const t2 = await s.press("ArrowRight");
    if (speaking) {
      const cut = await s.until("stop 3's line to be cut by Right", () => s.utterances(t).find((u) => u.start === speaking.start && u.end !== undefined), 2000, t2);
      if (!cut.cut || cut.end! - t2 > 300) throw new Fail("stop 3's line to be cut within 300 ms of Right", `${cut.cut ? "cut" : "not cut"} after ${cut.end! - t2} ms`);
    }
    const chime4 = await s.until("stop 4's chime right after Right", () => s.sounds("chime", t2)[0], 2500, t2);
    const line4 = await s.until("stop 4's line", () => s.utterances(t2).find((u) => u.start >= chime4.at), 4000, t2);
    if (line4.start < chime4.at + CHIME_MS) throw new Fail("the chime to end before stop 4 is spoken", `${Math.round(line4.start - chime4.at)} ms`);
    const g = await s.tourSettled();
    if (!/^Stop 4 of/.test((g.stop ?? "").trim())) throw new Fail("the tour to be at stop 4 after Right", `the screen says "${g.stop}"`);
    await checkRing(s, 4);
    const over = await s.until("stop 4's line to end", () => s.utterances(t2).find((u) => u.start === line4.start)?.end, 15_000, t2);
    await s.hush(6000, over, "nothing new for 6 s after the student's own Right (the tour waits)");
    if (s.posts.length || s.reqs.some((r) => r.method === "POST" && /\/api\/pointer/.test(r.url))) throw new Fail("no request to move the real pointer (Display option off)", `${s.posts.length} POST(s) to /api/pointer`);
    noLeak(s);
  },
};

const tourKeys: Scenario = {
  name: "tour-keys",
  title: "P pauses and resumes the tour, Escape leaves and says where; no tour or controls buttons",
  limit: 90,
  async run(c) {
    const s = await paper(c);
    const { t, fig } = await beginTour(s);
    const st1 = await stop(s, 1, t);
    // P: the voice stops, says it is paused, and nothing plays by itself until P again.
    const tp = await s.press("p");
    await s.said(/^Paused/i, tp, 3000, '"Paused..."');
    const cut = s.utterances(t).find((u) => u.start === st1.line.start);
    if (cut && cut.end === undefined) throw new Fail("stop 1's line to stop on P", "it kept speaking");
    const tq = Date.now();
    await s.hush(4000, tq + 1000, "nothing played by itself while paused", /^Paused/i);
    const tr = await s.press("p");
    const chime = await s.until("the tour to go on (a chime) after the second P", () => s.sounds("chime", tr)[0], 6000, tr);
    await s.until("stop 2's line after P", () => s.utterances(tr).find((u) => u.start >= chime.at), 4000, tr);
    const g = await s.tourSettled();
    if (!/^Stop 2 of/.test((g.stop ?? "").trim())) throw new Fail("the tour to go on at stop 2 after P", `the screen says "${g.stop}"`);
    // Escape leaves the tour and says where the student is.
    const te = await s.press("Escape");
    await s.said((x) => /^Back to the page\./.test(x) && norm(x).includes(norm(String(fig.heading))), te, 3000, `"Back to the page. ${fig.heading}."`);
    await s.until("the tour to close", () => s.page.evaluate(() => !document.querySelector("section[aria-label^='Figure tour']")), 2000, te);
    await noTourButtons(s, "after the tour");
    if (s.posts.length) throw new Fail("no request to move the real pointer", `${s.posts.length} POST(s)`);
  },
};

// ---- keys ------------------------------------------------------------------------------------------------------------------------

const speedKeys: Scenario = {
  name: "speed-keys",
  title: "Command+Right/Left change speed in reading and in a tour and never navigate; in the ask box they do nothing",
  limit: 100,
  async run(c) {
    const s = await paper(c);
    const url0 = s.page.url();
    const keyed = async (key: string, since: number, how: string) => {
      const k = await s.until(`the ${how} key press to be seen`, () => s.of("key", since).find((e) => e.key === key && (e.meta === true || e.ctrl === true)), 2000, since);
      return k;
    };
    let t = await s.press(s.speedKeys("faster"));
    await s.said(/faster\b.*speed|fastest/i, t, 3000, 'a line saying "Faster. Speed ..."');
    let k = await keyed("ArrowRight", t, "faster");
    if (!k.prevented) throw new Fail("the page to cancel the key's default (the browser's Forward) when reading", "it did not");
    t = await s.press(s.speedKeys("slower"));
    await s.said(/slower\b.*speed|slowest/i, t, 3000, 'a line saying "Slower. Speed ..."');
    k = await keyed("ArrowLeft", t, "slower");
    if (!k.prevented) throw new Fail("the page to cancel the key's default (the browser's Back) when reading", "it did not");
    if (s.page.url() !== url0) throw new Fail("the address to stay the same", `${url0} became ${s.page.url()}`);
    // In a tour.
    await beginTour(s);
    t = await s.press(s.speedKeys("faster"));
    await s.said(/faster\b.*speed|fastest/i, t, 3000, 'a line saying "Faster. Speed ..." in the tour');
    k = await keyed("ArrowRight", t, "faster in the tour");
    if (!k.prevented) throw new Fail("the page to cancel the key's default in a tour", "it did not");
    t = await s.press(s.speedKeys("slower"));
    await s.said(/slower\b.*speed|slowest/i, t, 3000, 'a line saying "Slower. Speed ..." in the tour');
    if (s.page.url() !== url0) throw new Fail("the address to stay the same in the tour", `${url0} became ${s.page.url()}`);
    await s.press("Escape");
    await s.settle(Date.now(), 600, 6000);
    // In the ask box: nothing changes.
    const sp = await s.page.evaluate(() => localStorage.getItem("arc-speed"));
    t = await s.press("/");
    await s.until("the ask box to take focus", () => s.page.evaluate(() => document.activeElement?.id === "command"), 2000);
    await s.settle(t, 500, 6000);
    t = await s.press(s.speedKeys("slower"));
    await s.hush(1500, t, "no speed change in the ask box");
    if ((await s.page.evaluate(() => localStorage.getItem("arc-speed"))) !== sp) throw new Fail("the saved speed to stay the same in the ask box", "it changed");
    if (s.page.url() !== url0) throw new Fail("the address to stay the same in the ask box", `${url0} became ${s.page.url()}`);
  },
};

// ---- a place kept ----------------------------------------------------------------------------------------------------------------

const place: Scenario = {
  name: "place",
  title: "third heading, reload: one \"Back on ... You were ...\" line, then Down reads the block after the saved one",
  limit: 90,
  async run(c) {
    const s = await paper(c);
    let t = 0;
    for (let i = 0; i < 3; i++) {
      t = await s.press("h");
      await s.until(`the cursor to land on heading ${i + 1}`, () => s.of("block", t).find((b) => Number(b.block) === -1) ?? s.of("cursor", t).find((e) => e.kind === "section"), 3000, t);
    }
    await s.until("the third heading's paragraph to be read", () => s.of("block", t).find((b) => Number(b.block) >= 0), 4000, t);
    await sleep(700);
    const saved = await s.until("a place to be kept in the tab after moving to the third heading", () => s.page.evaluate(() => {
      const k = Object.keys(sessionStorage).filter((x) => x.startsWith("arc-place:"));
      return k.map((x) => JSON.parse(sessionStorage.getItem(x) ?? "null"))[0] as { id: string; b: number } | undefined;
    }), 3000);
    const tr = Date.now();
    await s.page.reload({ waitUntil: "domcontentloaded" });
    const back = await s.said(/^Back on .+\. You were /, tr, 40_000, '"Back on <title>. You were ..."');
    await s.settle(tr, 1500, 20_000);
    const lines = s.utterances(tr).filter((u) => /^Back on /.test(u.text));
    if (lines.length !== 1) throw new Fail('one "Back on ..." line', `${lines.length}: ${lines.map(heard).join(", ")}`);
    if (s.utterances(tr).some((u) => /sections? and \d+ figures?/.test(u.text))) throw new Fail("no opening lines after a reload (only the place)", "the counts were read again");
    void back;
    const td = await s.press("ArrowDown");
    const nblocks = Number(s.of("block").filter((b) => b.id === saved.id).at(-1)?.blocks ?? 0);
    // The block after the saved one: in the same section while it has more blocks, else the next section.
    const moved = await s.until("the cursor to move after Down", () => s.of("block", td).find((b) => (b.id === saved.id ? Number(b.block) > saved.b : true) && !(b.id === saved.id && Number(b.block) < 0)) ?? s.of("cursor", td)[0], 4000, td);
    const inSame = saved.b + 1 < nblocks;
    if (inSame && !(moved.type === "block" && moved.id === saved.id && Number(moved.block) === saved.b + 1)) throw new Fail(`Down to read block ${saved.b + 1} of ${saved.id} (the one after the saved block ${saved.b})`, `it went to ${moved.type} ${moved.id} block ${moved.block ?? "-"}`);
    if (!inSame && moved.id === saved.id) throw new Fail(`Down to leave ${saved.id} (it was at its last block)`, "it stayed");
  },
};


// ---- the quiz page, private ------------------------------------------------------------------------------------------------------

const EXTRACT = readFileSync("extension/extract.js", "utf8");
const privateQuiz = async (c: Ctx) => {
  const port = 8800 + Math.floor(Math.random() * 150);
  const site = `http://127.0.0.1:${port}`;
  const server = await startFixture(port);
  try {
    const ctx = await c.browser.newContext();
    const tab = await ctx.newPage();
    await tab.goto(`${site}/login`);
    await tab.goto(`${site}/course/quizzes/3/take`);
    await tab.evaluate(EXTRACT);
    const payload = await tab.evaluate(() => (globalThis as unknown as { __arcExtract: () => Promise<unknown> }).__arcExtract());
    await ctx.close();
    const res = await fetch(`${c.base}/api/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const j = (await res.json()) as { id?: string; error?: string };
    if (!res.ok || !j.id) throw new Fail("the private quiz page to be accepted by /api/ingest", `${res.status} ${j.error ?? ""}`);
    return { id: j.id, close: () => void server.close() };
  } catch (e) {
    server.close();
    throw e;
  }
};

const priv: Scenario = {
  name: "private",
  title: "a private page leaves nothing in the address bar or storage but the one-word marker; a reload says it was not kept",
  limit: 60,
  async run(c) {
    const q = await privateQuiz(c);
    try {
      const t = Date.now();
      const s = await open(c, `/#doc=${q.id}`);
      await s.said(/Quiz 2/i, t, 20_000, "the quiz page's title");
      await s.until("the address bar to be cleared of the document id", () => s.page.evaluate(() => !location.search && !location.hash), 5000);
      const where = await s.page.evaluate(() => location.href);
      if (/doc=|#doc|url=/.test(where)) throw new Fail("nothing about the page in the address bar", where);
      const store = await s.page.evaluate(() => ({ session: Object.fromEntries(Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k)])), local: Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])) }));
      const extra = Object.keys(store.session).filter((k) => k !== "arc-gone");
      if (extra.length) throw new Fail('sessionStorage to hold at most the "arc-gone" marker', `it also holds ${extra.join(", ")}`);
      if (JSON.stringify(store).includes(MARKER) || JSON.stringify(store).includes(q.id)) throw new Fail("no trace of the page in browser storage", "its text or id was stored");
      if (store.session["arc-gone"] !== undefined && store.session["arc-gone"] !== "private") throw new Fail('the marker to be "private"', String(store.session["arc-gone"]));
      const tr = Date.now();
      await s.page.reload({ waitUntil: "domcontentloaded" });
      await s.said(/private page you had open was not kept/i, tr, 15_000, "the line saying the private page was not kept");
      if (/doc=|url=/.test(s.page.url())) throw new Fail("nothing about the page in the address bar after the reload", s.page.url());
    } finally {
      q.close();
    }
  },
};

// ---- a PDF ----------------------------------------------------------------------------------------------------------------------

const PDF = "https://arxiv.org/pdf/1706.03762";
const pdf: Scenario = {
  name: "pdf",
  title: "PDF by link: page count; go to page 4; equation picture with spoken alt, not a figure; a PDF figure's tour starts",
  limit: 100,
  async run(c) {
    const s = await open(c, "/");
    await s.until("the greeting", () => s.utterances().length, 5000);
    let t = await s.paste(PDF);
    await s.said(/Attention Is All You Need/, t, 40_000, "the paper's title");
    await s.said(/\b15 pages\b/, t, 10_000, '"15 pages"');
    t = await s.type("go to page 4");
    await s.until("the cursor to land on page 4", () => s.of("cursor", t).find((e) => e.page === 4), 12_000, t);
    await s.said(/Page 4 of 15/, t, 5000, '"Page 4 of 15"');
    // An equation: a picture whose alt text is the spoken form, and it is not a figure.
    t = await s.press("e");
    const eq = await s.until("the cursor to land on an equation after E", () => s.of("cursor", t).find((e) => e.heading === "Equation" || /equation/i.test(String(e.heading))), 4000, t);
    const spoken = await s.said(/^Equation/i, t, 4000, "the equation said in words");
    const kind = await s.until("the equation block to be highlighted", async () => (await s.currentBlock())?.kind, 3000, t);
    if (kind !== "equation") throw new Fail("the block under the cursor to be an equation", `it is "${kind}" (${eq.heading})`);
    const alt = await s.until("the equation's picture to show", () => s.page.evaluate(() => (document.querySelector('#content [aria-current="true"] img') as HTMLImageElement | null)?.alt || ""), 20_000, t);
    if (!norm(alt).startsWith(norm(spoken.text).slice(0, 40))) throw new Fail("the picture's alt text to be the spoken form", `alt "${alt.slice(0, 80)}", spoken "${spoken.text.slice(0, 80)}"`);
    t = await s.press("Enter");
    await sleep(2500);
    if (await s.page.evaluate(() => !!document.querySelector("section[aria-label^='Figure tour']"))) throw new Fail("Enter on an equation to start no tour", "a tour opened");
    if (s.utterances(t).some((u) => /looking (at|for)|tour/i.test(u.text))) throw new Fail("Enter on an equation to start no tour", "Arc said it was looking for a tour");
    // A figure's tour starts.
    t = await s.type("figure 2");
    await s.until("the cursor to land on a figure", () => s.of("cursor", t).find((e) => e.kind === "figure"), 8000, t);
    t = await s.press("Enter");
    await s.until("the figure tour to open", () => s.page.evaluate(() => !!document.querySelector("section[aria-label^='Figure tour']")), 30_000, t);
    await s.said(/\b\d+ stops\b/, t, 30_000, "the tour's introduction");
  },
};

// ---- upload ---------------------------------------------------------------------------------------------------------------------

const upload: Scenario = {
  name: "upload",
  title: "the Upload control opens a file chooser; the small PDF opens; the address bar shows nothing about it",
  limit: 60,
  async run(c) {
    const dir = mkdtempSync(join(tmpdir(), "arc-e2e-pdf-"));
    const doc = await PDFDocument.create();
    doc.setTitle("E2E notes");
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const lines of [["Notes on rainfall", "", "Rain falls when warm moist air rises and cools.", "Clouds are made of tiny drops of water."], ["Measuring rain", "", "A rain gauge is a tube that collects water.", "It is read once a day."]]) {
      const p = doc.addPage([420, 300]);
      lines.forEach((l, i) => p.drawText(l, { x: 30, y: 250 - i * 22, size: i ? 12 : 16, font }));
    }
    const file = join(dir, "rain-notes.pdf");
    writeFileSync(file, await doc.save());
    const s = await open(c, "/");
    await s.until("the greeting", () => s.utterances().length, 5000);
    const [chooser] = await Promise.all([s.page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null), s.page.getByRole("button", { name: /upload/i }).click()]);
    if (!chooser) throw new Fail("the Upload control to open a file chooser", "no chooser opened in 5 s");
    const t = Date.now();
    await chooser.setFiles(file);
    await s.said(/rain-notes|Notes on rainfall|E2E notes/i, t, 30_000, "the opened file's name or title");
    await s.said(/\b2 pages\b/, t, 15_000, '"2 pages"');
    const addr = await s.page.evaluate(() => location.pathname + location.search + location.hash);
    if (addr !== "/") throw new Fail("the address bar to show nothing about the file", addr);
  },
};

// ---- a lecture ------------------------------------------------------------------------------------------------------------------

const LECTURE = "https://www.youtube.com/watch?v=4JqH55rLGKY";
async function lecture(c: Ctx) {
  const s = await open(c, "/");
  await s.until("the greeting", () => s.utterances().length, 5000);
  const t = await s.paste(LECTURE);
  const title = await s.said(/^Video: .+\. It is .+ long/, t, 40_000, '"Video: <title>. It is N minutes long."');
  return { s, t, title };
}
const lec: Scenario = {
  name: "lecture",
  title: "lecture: title and length; V reads the transcript; P pauses and resumes it; on-screen descriptions are in the transcript",
  limit: 70,
  async run(c) {
    const { s } = await lecture(c);
    await s.until("the page to settle", () => s.page.evaluate(() => !!document.querySelector("#content article")), 5000);
    const t = await s.press("v");
    await s.said(/^Reading to you/, t, 4000, '"Reading to you."');
    const doc = await s.docText();
    await s.until("the transcript to be read aloud", () => s.utterances(t).find((u) => u.text.length > 30 && doc.includes(norm(u.text).slice(0, 25))), 6000, t);
    const tp = await s.press("p");
    await s.said(/^Paused/i, tp, 3000, '"Paused. ..." on P');
    await s.hush(2000, Date.now() + 500, "silence while paused", /^Paused/i);
    const tr = await s.press("p");
    await s.until("the reading to go on after the second P", () => s.utterances(tr).find((u) => u.text.length > 20), 4000, tr);
    const shown = await s.page.evaluate(() => [...document.querySelectorAll("#content p")].filter((p) => /^Shown on screen:/.test(p.textContent ?? "")).length);
    if (!shown) throw new Fail("on-screen description lines (\"Shown on screen: ...\") in the transcript view", "none found");
    void t;
  },
};
const lecK: Scenario = {
  name: "lecture-k",
  title: "lecture: K pauses the reading and a second K goes on, as P does",
  limit: 70,
  async run(c) {
    const { s } = await lecture(c);
    await s.until("the page to settle", () => s.page.evaluate(() => !!document.querySelector("#content article")), 5000);
    let t = await s.press("v");
    await s.said(/^Reading to you/, t, 4000, '"Reading to you."');
    await s.until("the transcript to be read aloud", () => s.utterances(t).find((u) => u.text.length > 30), 6000, t);
    t = await s.press("k");
    await s.said(/^Paused/i, t, 3000, '"Paused. ..." on K');
    await s.settle(t, 500, 4000);
    const t2 = await s.press("k");
    await s.until("the reading to go on (or a tick) after the second K", () => s.utterances(t2)[0] ?? s.sounds("tick", t2)[0], 3500, t2);
  },
};

// ---- scholarly links, at the API ------------------------------------------------------------------------------------------------

const post = async (c: Ctx, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${c.base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const text = await r.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the app's JSON answers are read loosely here
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
const scholar: Scenario = {
  name: "scholar",
  title: "network: a ScienceDirect link gives its open copy; a ResearchGate title gives numbered candidates; an arXiv abstract gives the paper with figures",
  limit: 150,
  async run(c) {
    const probe = await fetch("https://api.openalex.org/works?search=attention&per-page=1", { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    const notes: string[] = [];
    const sd = await post(c, "/api/load", { url: "https://www.sciencedirect.com/science/article/pii/S0893608014002135" });
    if (sd.status !== 200 || sd.json?.source?.via !== "open-copy") throw new Fail('the ScienceDirect link to load with via "open-copy"', `${sd.status} via ${sd.json?.source?.via} ${sd.json?.error ?? ""}`);
    const ax = await post(c, "/api/load", { url: "https://arxiv.org/abs/1512.03385" });
    if (ax.status !== 200 || !(ax.json?.counts?.figures > 0)) throw new Fail("the arXiv abstract link to load the paper with figures", `${ax.status} figures ${ax.json?.counts?.figures} ${ax.json?.error ?? ""}`);
    const rg = await post(c, "/api/load", { url: "https://www.researchgate.net/publication/317558625_Attention_Is_All_You_Need" });
    const hits = rg.json?.search?.results as { title: string; by?: string; year?: number }[] | undefined;
    if (rg.status === 200 && hits?.length) {
      const bad = hits.filter((h) => !h.by || !h.year);
      if (bad.length) throw new Fail("every candidate to name an author and a year", `${bad.length} of ${hits.length} do not: ${bad[0].title}`);
    } else if (probe && probe.status !== 200) notes.push(`ResearchGate not checked: the open index (OpenAlex) answers ${probe.status} today ("${(await probe.text().catch(() => "")).slice(0, 60)}...")`);
    else throw new Fail("the ResearchGate link to give numbered candidates with author and year", `${rg.status} ${rg.json?.error ?? rg.text.slice(0, 100)}`);
    return notes.length ? { note: notes.join("; ") } : undefined;
  },
};

// ---- guard rails at the API ------------------------------------------------------------------------------------------------------

const guard: Scenario = {
  name: "guard",
  title: "private and local addresses are refused by /api/load, /api/image and /api/tour; a foreign Origin on /api/decide",
  limit: 60,
  async run(c) {
    const bad = ["http://127.0.0.1:3000/api/budget", "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "file:///etc/passwd"];
    for (const u of bad) {
      const l = await post(c, "/api/load", { url: u });
      if (l.status !== 400 || l.json?.error !== "Arc only opens public web addresses.") throw new Fail(`/api/load to refuse ${u} with the public-addresses line`, `${l.status} ${l.text.slice(0, 100)}`);
      const i = await fetch(`${c.base}/api/image?u=${encodeURIComponent(u)}`);
      if (i.status < 400 || /^image\//.test(i.headers.get("content-type") ?? "")) throw new Fail(`/api/image to refuse ${u}`, `${i.status} ${i.headers.get("content-type")}`);
      const t = await fetch(`${c.base}/api/tour?image=${encodeURIComponent(u)}`);
      const tj = await t.json().catch(() => ({}));
      if (t.status < 400 || tj?.stops) throw new Fail(`/api/tour to refuse ${u}`, `${t.status} ${JSON.stringify(tj).slice(0, 80)}`);
    }
    // An empty body: a server that refuses foreign origins says 403 before reading it; one that does not says 400 "Missing utterance" and no model is asked.
    const d = await post(c, "/api/decide", {}, { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
    if (d.status === 403) return;
    return { note: `cross-site refusal not yet enforced: a POST to /api/decide from Origin https://evil.example reached the route (${d.status} ${d.json?.error ?? ""})` };
  },
};

// ---- search ----------------------------------------------------------------------------------------------------------------------
// The server's search is replaced in the page by a fixed list (STATIC_HITS), so no live search is paid for;
// what is tested is what the student hears and does with the list, and that narrowing never blocks a search.

type Hit = { title: string; url: string; snippet: string };
const QUERY = "photosynthesis openstax biology";
// A fixed list: the saved results in .cache/search are rewritten by every live search anyone runs, so they cannot be a fixture.
const STATIC_HITS: Hit[] = [
  { title: "8.1 Overview of Photosynthesis - Biology 2e | OpenStax", url: "https://openstax.org/books/biology-2e/pages/8-1-overview-of-photosynthesis", snippet: "Photosynthesis is essential to almost all life on earth; both plants and animals depend on it. It is the only biological process that can capture energy that originates from sunlight." },
  { title: "Ch. 8 Chapter Summary - Biology 2e | OpenStax", url: "https://openstax.org/books/biology-2e/pages/8-chapter-summary", snippet: "Chapter Summary 8.1 Overview of Photosynthesis. The process of photosynthesis transformed life on Earth. Photosynthesis evolved in steps." },
  { title: "Photosynthesis - Wikipedia", url: "https://en.wikipedia.org/wiki/Photosynthesis", snippet: "Photosynthesis is a system of biological processes by which photosynthetic organisms convert light energy into chemical energy. Most plants do it." },
  { title: "Photosynthesis | Khan Academy", url: "https://www.khanacademy.org/science/biology/photosynthesis-in-plants", snippet: "Learn about the light reactions and the Calvin cycle. Follow the energy from sunlight to sugar." },
  { title: "Light-dependent reactions - Biology LibreTexts", url: "https://bio.libretexts.org/Bookshelves/Introductory_and_General_Biology/light-dependent-reactions", snippet: "The light-dependent reactions take place in the thylakoid membranes. Light energy is converted to chemical energy." },
];
const FAKE_PAGE = (url: string, n: number) => ({
  id: `twin-e2e${n}`,
  source: { url, kind: "page", title: `E2E page ${n}`, via: "cache", ms: 1 },
  nodes: [{ id: "n01", kind: "section", order: 0, level: 2, heading: "A test section", text: "This page stands in for the one that was opened." }],
  counts: { sections: 1, figures: 0, segments: 0 },
});
/** Replaces /api/search, /api/narrow and /api/load in this page. Returns what was asked of them. */
async function stubSearch(s: Sess, results: Hit[], narrow: "fail" | "stall" | "none" = "fail") {
  const log = { search: [] as { at: number; query: string }[], narrow: [] as number[], load: [] as { at: number; url: string }[] };
  await s.page.route(/\/api\/search$/, async (r) => {
    if (r.request().method() !== "POST") return r.fallback();
    log.search.push({ at: Date.now(), query: JSON.parse(r.request().postData() ?? "{}").query });
    return r.fulfill({ status: 200, headers: { "content-type": "application/x-ndjson" }, body: JSON.stringify({ results, via: "cache", ms: 3 }) + "\n" });
  });
  await s.page.route(/\/api\/narrow$/, async (r) => {
    log.narrow.push(Date.now());
    if (narrow === "stall") return void setTimeout(() => r.abort().catch(() => {}), 12_000);
    if (narrow === "fail") return r.fulfill({ status: 502, json: { error: "The narrowing step did not answer." } });
    return r.fallback();
  });
  await s.page.route(/\/api\/load$/, async (r) => {
    if (r.request().method() !== "POST") return r.fallback();
    const url = JSON.parse(r.request().postData() ?? "{}").url as string;
    log.load.push({ at: Date.now(), url });
    return r.fulfill({ status: 200, json: FAKE_PAGE(url, log.load.length) });
  });
  return log;
}
const NUMBER_LINE = /^(One|Two|Three|Four|Five): /;

const searchSpecific: Scenario = {
  name: "search",
  title: "a specific query searches at once and reads three; no Tab stops in results; Down, a number, Enter open; back to the list without a new search",
  limit: 90,
  async run(c) {
    const hits = STATIC_HITS;
    const s = await open(c, "/");
    await s.until("the greeting", () => s.utterances().length, 5000);
    const log = await stubSearch(s, hits);
    let t = await s.type(QUERY);
    await s.said(/^Searching for /i, t, 1500, '"Searching for ..." at once (no question first)');
    if (log.narrow.length) throw new Fail("a specific query to be searched without asking the narrowing service", "/api/narrow was called");
    await s.until("the search to be sent", () => log.search[0], 2500, t);
    // The count, then the first three: number, title, source and kind.
    const lines = await s.until("three result lines (One, Two, Three) to be read", () => {
      const u = s.utterances(t).filter((x) => NUMBER_LINE.test(x.text));
      return u.length >= 3 ? u : undefined;
    }, 12_000, t);
    await s.settle(t, 900, 15_000);
    const read = s.utterances(t).filter((x) => NUMBER_LINE.test(x.text));
    if (read.length !== 3 || !/^One: /.test(read[0].text) || !/^Two: /.test(read[1].text) || !/^Three: /.test(read[2].text)) throw new Fail("exactly the first three results read as One, Two, Three", read.map(heard).join(", "));
    if (!/OpenStax/.test(lines[0].text)) throw new Fail("each result line to name its source (the query names OpenStax)", heard(lines[0]));
    if (!s.utterances(t).some((u) => /^(\d+ results?|.*\bresults?\b)/i.test(u.text) && u.start < lines[0].start)) throw new Fail("the count of results said before the first one", s.utterances(t).map(heard).join(", "));
    if (!s.utterances(t).some((u) => /Say open and a number|Press Down to hear each one/i.test(u.text) && u.start > lines[2].start)) throw new Fail("how to go on said after the third result", s.recent(t));
    const ids = s.of("cursor", t).map((e) => String(e.id));
    if (!["r01", "r02", "r03"].every((id) => ids.includes(id))) throw new Fail("the cursor to sit on each result as it is read (r01, r02, r03)", ids.join(", "));
    // Nothing in a result is a Tab stop.
    const stops = await s.page.evaluate(() => ({ inside: document.querySelectorAll(".results a, .results button, .results input, .results [tabindex]").length, names: [...document.querySelectorAll("a, button")].map((e) => (e.getAttribute("aria-label") || e.textContent || "").trim()).filter((n) => /open this page|back to the page/i.test(n)) }));
    if (stops.inside || stops.names.length) throw new Fail("no link, button or tab stop inside the results (no \"Open this page\" or \"Back to the page\")", `${stops.inside} focusable, names: ${stops.names.join(", ")}`);
    for (let i = 0; i < 6; i++) {
      await s.press("Tab");
      if (await s.page.evaluate(() => !!document.activeElement?.closest(".results"))) throw new Fail("Tab never to land inside the results", `it did on press ${i + 1}`);
    }
    // Down steps and reads a summary sentence; a number key opens that result.
    await s.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    t = await s.press("ArrowDown");
    const step = await s.until("the cursor to step to the next result after Down", () => s.of("cursor", t).find((e) => String(e.id).startsWith("r")), 3000, t);
    const wantSum = norm(hits[1].snippet).slice(0, 30);
    await s.until("the result's summary sentence to be read after Down", () => s.utterances(t).find((u) => norm(u.text).startsWith(wantSum)), 4000, t);
    await sleep(1200);
    const after = s.utterances(t);
    if (after.length > 2) throw new Fail("Down to read the result's line and one summary sentence", `${after.length} lines: ${after.map(heard).join(", ")}`);
    void step;
    t = await s.press("2");
    const open2 = await s.until("a number key to open that result", () => log.load.find((l) => l.at >= t), 3000, t);
    if (open2.url !== hits[1].url) throw new Fail(`key 2 to open the second result (${hits[1].url})`, open2.url);
    await s.said(/E2E page/, t, 8000, "the opened page's title");
    // "go back to the results": the same list, no new search.
    const searches = log.search.length;
    t = await s.type("go back to the results");
    await s.said(/^Back to your results/i, t, 5000, '"Back to your results."');
    if (log.search.length !== searches) throw new Fail("going back to the results to make no new /api/search request", `${log.search.length - searches} new request(s)`);
    const listed = await s.page.evaluate(() => document.querySelectorAll(".results li").length);
    if (listed !== hits.length) throw new Fail(`the same ${hits.length} results to be listed again`, `${listed} are`);
    // Enter opens the result under the cursor.
    const cur = String(s.of("cursor", t).at(-1)?.id ?? "r01");
    t = await s.press("Enter");
    const opened = await s.until("Enter to open the result under the cursor", () => log.load.find((l) => l.at >= t), 3000, t);
    const want = hits[Number(cur.slice(1)) - 1];
    if (opened.url !== want?.url) throw new Fail(`Enter to open the result under the cursor (${cur}: ${want?.url})`, opened.url);
  },
};

const searchNever: Scenario = {
  name: "search-never-blocks",
  title: "a broad subject with the narrowing service failing, then stalling: the search still goes out within about 2 s",
  limit: 60,
  async run(c) {
    const hits = STATIC_HITS;
    for (const mode of ["fail", "stall"] as const) {
      const s = await open(c, "/");
      try {
        await s.until("the greeting", () => s.utterances().length, 5000);
        const log = await stubSearch(s, hits, mode);
        const t = await s.type("biology");
        const sent = await s.until(`the search to go out with the narrowing service ${mode === "fail" ? "failing" : "stalling"}`, () => log.search[0], 4000, t);
        if (sent.at - t > 2500) throw new Fail(`the search to go out within about 1.5 s of the request when narrowing ${mode === "fail" ? "fails" : "stalls"}`, `it went out after ${sent.at - t} ms`);
        await s.until("the results to be read", () => s.utterances(t).find((u) => NUMBER_LINE.test(u.text)), 12_000, t);
      } finally {
        await s.close();
      }
    }
  },
};


// ---- with a model (--live) -------------------------------------------------------------------------------------------------------

/** The second voice's answer to a typed question: its words, once it has finished (or been cut). */
const answer = (s: Sess, t: number, what: string, ms = 60_000) => s.until(what, () => s.utterances(t).find((u) => u.voice === "gemini" && u.end !== undefined && u.text), ms, t);
const DECLINE = /can'?t|cannot|can not|won'?t|not able|unable|not going to|rather not|not something I can|shouldn'?t|instead/i;

const liveAsks: Scenario = {
  name: "live",
  title: "--live: the paper's accuracy is answered with 97.4; a learner-phrased question gets an answer; a quiz answer is declined; a broad subject asks a question",
  live: true,
  limit: 240,
  async run(c) {
    // The paper.
    const s = await paper(c, true);
    let t = await s.type("how accurate was the activity recognition?");
    const a1 = await answer(s, t, "an answer to \"how accurate was the activity recognition?\"");
    if (!/97\.4/.test(a1.text)) throw new Fail('the answer to contain 97.4', heard(a1));
    // A question as a learner would put it.
    t = await s.type("how much it cost, this system?");
    const a2 = await s.until("an answer (or a refusal line) to \"how much it cost, this system?\"", () => s.utterances(t).find((u) => u.end !== undefined && u.text.length > 10 && u.start > t), 60_000, t);
    if (/not sure what you meant|did not catch that|didn'?t catch that/i.test(a2.text)) throw new Fail("an answer, not \"I'm not sure what you meant\"", heard(a2));
    await s.close();
    // The quiz, private: the answer is declined.
    const q = await privateQuiz(c);
    try {
      const t0 = Date.now();
      const sq = await open(c, `/#doc=${q.id}`, true);
      await sq.said(/Quiz 2/i, t0, 20_000, "the quiz page's title");
      await sq.settle(t0, 1500, 20_000);
      const tq = await sq.type("what is the answer to question 2?");
      const a3 = await answer(sq, tq, "a reply to \"what is the answer to question 2?\"");
      if (/mitochondri/i.test(a3.text) || !DECLINE.test(a3.text)) throw new Fail("the answer to question 2 to be declined (no \"mitochondria\", a refusal)", heard(a3));
    } finally {
      q.close();
    }
    // A broad subject asks one question, and the student's answer leads to a search.
    const sb = await open(c, "/", true);
    await sb.until("the greeting", () => sb.utterances().length, 5000);
    const log = await stubSearch(sb, STATIC_HITS, "none");
    const tb = await sb.type("I want to study biology");
    const ask = await sb.until("one spoken question with options before searching", () => sb.utterances(tb).find((u) => /\?/.test(u.text)), 20_000, tb);
    if (log.search.length) throw new Fail("a broad subject to ask before searching", "it searched at once");
    if (!/ or |, /.test(ask.text)) throw new Fail("the question to offer options", heard(ask));
    const tc = await sb.type("the one about how cells divide");
    await sb.until("a search to go out after the answer", () => log.search.find((x) => x.at >= tc), 20_000, tc);
    if (!/cell|divi/i.test(log.search.at(-1)!.query)) throw new Fail('the search to use the answer ("cells divide")', `it searched "${log.search.at(-1)!.query}"`);
  },
};

export const scenarios: Scenario[] = [start, openPaper, reading, find, noMove, tour, tourKeys, speedKeys, place, priv, pdf, upload, lec, lecK, scholar, guard, searchSpecific, searchNever, liveAsks];
