// End to end against the fixture learning site (scripts/private-fixture.mjs), without anyone's account:
//   npx tsx scripts/private-e2e.ts [arc origin, default http://localhost:3000] [--ask]
// Needs Arc running at that origin and Google Chrome installed (playwright-core, channel "chrome", headless). It plays the
// extension's part: signs in to the fixture (a cookie), opens pages in a tab of that signed-in profile, injects extension/extract.js
// exactly as background.js does, and posts the result to /api/ingest. --ask also asks a quiz question through Gemini Live (costs
// one short Live session; needs GEMINI_API_KEY in .env.local) on a relay started here with the current lib/server/live.ts.
import assert from "node:assert";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium, type Page } from "playwright-core";
import { verdict } from "../lib/server/fetch";
import { matchFrames } from "../extension/rules.js";
import { MARKER, start } from "./private-fixture.mjs";

const ARC = process.argv.find((a) => /^https?:\/\//.test(a)) ?? "http://localhost:3000";
const PORT = Number(process.env.FIXTURE_PORT) || 8775;
const SITE = `http://127.0.0.1:${PORT}`;
const EXTRACT = readFileSync("extension/extract.js", "utf8");
const log = (...a: unknown[]) => console.log(...a);

type Payload = { url: string; html?: string; images?: string[]; links?: { label: string; url: string; rel?: string }[]; frames?: { n: number; src?: string; html?: string }[]; pdf?: { data: string }; lines?: string[]; videos?: unknown[]; youtube?: unknown[] };
async function extract(page: Page): Promise<Payload> {
  await page.evaluate(EXTRACT);
  return page.evaluate(() => (globalThis as unknown as { __arcExtract: () => Promise<Payload> }).__arcExtract());
}
async function ingest(p: Payload) {
  const res = await fetch(`${ARC}/api/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) });
  return { status: res.status, body: (await res.json()) as { id?: string; error?: string; code?: string } };
}
const twinOf = async (id: string) => (await fetch(`${ARC}/api/ingest`, { headers: { "x-arc-doc": id } })).json();

(async () => {
  const fixture = await start(PORT);
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    // 1. Arc's server, on its own, gets the sign-in page and says the sign-in line. (Its address guard refuses 127.0.0.1 before
    //    fetching at all, so the fixture's real sign-in answer is put through the same decision the load route uses.)
    const signIn = await (await fetch(`${SITE}/course/pages/cells`)).text();
    const v = verdict({ html: signIn, status: 200, kind: "html", url: `${SITE}/course/pages/cells` }, `${SITE}/course/pages/cells`);
    log("1. server-side, no cookie:", v.ok ? "OK (wrong)" : v.why);
    assert.equal(!v.ok && v.why, "signIn");
    const load = await fetch(`${ARC}/api/load`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://canvas.instructure.com/courses/1/pages/x" }) });
    const lj = (await load.json()) as { error: string };
    log("   /api/load on a Canvas link:", load.status, lj.error);
    assert.equal(load.status, 403);
    assert.match(lj.error, /needs you to sign in/);

    // 2. The student's browser: signed in, the page read in a tab, late content and the picture included.
    const ctx = await browser.newContext();
    const tab = await ctx.newPage();
    await tab.goto(`${SITE}/login`);
    await tab.goto(`${SITE}/course/pages/cells`);
    const t0 = Date.now();
    const page = await extract(tab);
    log(`2. extracted in ${Date.now() - t0} ms: html ${page.html?.length} chars, ${page.images?.length} pictures, ${page.links?.length} links, frames ${page.frames?.length}`);
    assert.ok(page.html?.includes(MARKER), "late-rendered text present");
    assert.ok(page.html?.includes(`${MARKER}-FRAME`), "same-site frame inlined");
    assert.ok(page.html?.includes('alttext="J = -D \\frac{dc}{dx}"'), "Canvas equation became <math alttext>");
    assert.equal(page.images?.length, 1);
    assert.ok(page.links?.some((l) => l.rel === "next" && l.url.endsWith("/course/pages/energy")), "next link");
    log("   links:", page.links?.map((l) => `${l.rel ?? "-"} ${l.label} ${new URL(l.url).pathname}`).join(" | "));
    const r = await ingest({ ...page, frames: matchFrames(page.frames as { n: number; src: string }[], []) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const twin = await twinOf(r.body.id!);
    const fig = twin.nodes.find((n: { kind: string }) => n.kind === "figure");
    const eq = twin.nodes.flatMap((n: { blocks?: { kind: string; say?: string; text: string }[] }) => n.blocks ?? []).find((b: { text: string }) => /Fick/.test(b.text));
    log(`   twin: private ${twin.source.private}, ${twin.counts.sections} sections, ${twin.counts.figures} figure, image ${fig?.image?.url.replace(/img=\w+/, "img=…")}`);
    log("   equation spoken as:", eq?.say ?? eq?.text);
    assert.equal(twin.source.private, true);
    assert.ok(fig?.image?.url.includes("/api/ingest?img="));
    const pic = await fetch(fig.image.url);
    log("   picture served:", pic.status, pic.headers.get("content-type"), (await pic.arrayBuffer()).byteLength, "bytes");
    assert.equal(pic.status, 200);

    // 3. "next page" follows the link through the helper: a second tab in the same signed-in profile, read, closed.
    const next = twin.links.find((l: { rel?: string }) => l.rel === "next");
    const bg = await ctx.newPage();
    await bg.goto(next.url);
    const p2 = await extract(bg);
    await bg.close();
    const r2 = await ingest(p2);
    const t2 = await twinOf(r2.body.id!);
    log("3. next page through the helper:", t2.source.title, `(${t2.counts.sections} sections)`);
    assert.match(t2.source.title, /Energy in cells/);

    // 4. A linked PDF that needs the cookie: fetched in the page, read by Arc's PDF reader.
    await tab.goto(`${SITE}/course/files/notes`);
    const p3 = await extract(tab);
    log(`4. PDF: ${p3.pdf ? `${Math.round((p3.pdf.data.length * 3) / 4)} bytes` : "none"} ${p3.lines?.join(" ") ?? ""}`);
    assert.ok(p3.pdf);
    const r3 = await ingest(p3);
    const t3 = await twinOf(r3.body.id!);
    log(`   PDF twin: ${t3.pdf?.pages} pages, first heading "${t3.nodes[0]?.heading}", private ${t3.source.private}`);
    assert.equal(t3.pdf?.pages, 2);
    const file = await fetch(`${ARC}/api/pdf/file?id=${t3.pdf.id}`);
    const page2 = await fetch(`${ARC}/api/pdf/page?id=${t3.pdf.id}&n=2`);
    log("   /api/pdf/file:", file.status, file.headers.get("content-type"), " /api/pdf/page n=2:", page2.status, ((await page2.json()) as { nodes: { heading: string }[] }).nodes.map((n) => n.heading).join(", "));
    assert.equal(file.status, 200);

    // 5. A video with a caption track (the track needs the cookie) and a YouTube embed.
    await tab.goto(`${SITE}/course/pages/video`);
    const p4 = await extract(tab);
    const r4 = await ingest(p4);
    const t4 = await twinOf(r4.body.id!);
    log("5. video page:", t4.nodes.map((n: { heading: string }) => n.heading).join(" | "), "| links:", t4.links?.map((l: { label: string }) => l.label).join(", "));
    assert.ok(t4.nodes.some((n: { heading: string; text: string }) => /Transcript/.test(n.heading) && /\[0:52\]/.test(n.text)));
    assert.ok(t4.links.some((l: { url: string }) => /youtube\.com\/watch\?v=dQw4w9WgXcQ/.test(l.url)));

    // 6. A quiz being taken: read, flagged as an assessment, choices heard.
    await tab.goto(`${SITE}/course/quizzes/3/take`);
    const p5 = await extract(tab);
    const r5 = await ingest(p5);
    const t5 = await twinOf(r5.body.id!);
    const quizText = t5.nodes.map((n: { text: string }) => n.text).join(" ");
    log(`6. quiz: assessment ${t5.source.assessment}; text: ${quizText.slice(0, 260)}`);
    assert.equal(t5.source.assessment, true);
    assert.match(quizText, /Choice: The mitochondria/);

    // 6b. A short page whose pictures come only through their file API object (the shape that once gave an empty twin).
    await tab.goto(`${SITE}/course/pages/photos`);
    const p6 = await extract(tab);
    const r6b = await ingest(p6);
    const t6 = await twinOf(r6b.body.id!);
    const figs6 = t6.nodes.filter((n: { kind: string }) => n.kind === "figure");
    log(`6b. short picture page: ${p6.images?.length} pictures captured; twin ${t6.nodes.length} nodes: ${t6.nodes.map((n: { kind: string; heading: string; text: string }) => `${n.kind} "${n.heading}" (${n.text.slice(0, 40)})`).join(" | ")}`);
    assert.equal(p6.images?.length, 2);
    assert.equal(figs6.length, 2);
    assert.deepEqual(figs6.map((n: { text: string }) => n.text), ["Beaker on a hot plate", "Picture, no description"]);
    const arcTab = await ctx.newPage();
    await arcTab.goto(`${ARC}/#doc=${r6b.body.id}`);
    await arcTab.waitForSelector("#twin-title");
    // No tour button any more: Enter on a figure or a click on its picture starts the tour, and each picture says so in a hint.
    const buttons = await arcTab.locator("button", { hasText: /tour/i }).count();
    const hints = await arcTab.locator(".tour-hint").count();
    const shown = await arcTab.locator("img[src*='/api/ingest?img=']").evaluateAll((els) => els.map((e) => (e as HTMLImageElement).naturalWidth));
    log(`    in Arc: ${hints} picture(s) offer a tour, ${buttons} tour button(s), pictures shown with widths ${shown.join(", ")}`);
    assert.ok(buttons === 0 && hints >= 2 && shown.length === 2 && shown.every((w) => w > 0));
    await arcTab.close();

    // 7. A sign-in page sent by mistake (no cookie) is refused with the sign-in line.
    const anon = await browser.newContext();
    const at = await anon.newPage();
    await at.goto(`${SITE}/course/pages/cells`);
    const r6 = await ingest(await extract(at));
    log("7. sign-in page sent:", r6.status, r6.body.error);
    assert.equal(r6.status, 401);

    // 8. Nothing on disk: the marker is nowhere under .cache/ (text, JSON, PDF bytes, pictures, tours, clean-up results).
    await new Promise((d) => setTimeout(d, 4000)); // background tours and clean-up get a moment to (not) write
    const hits = execSync(`grep -rlaF '${MARKER}' .cache/ || true`).toString().trim();
    const ing = execSync("ls .cache/ingest 2>/dev/null | wc -l").toString().trim();
    log(`8. files under .cache/ holding ${MARKER}: ${hits ? hits : "none"}; files in .cache/ingest: ${ing}`);
    assert.equal(hits, "");

    if (process.argv.includes("--ask")) await ask(t5);
    log("private e2e ok");
  } finally {
    await browser.close();
    fixture.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

/** The quiz page's context through the real question session (current lib/server/live.ts), asked for an answer. */
async function ask(twin: Parameters<typeof import("../lib/client/voice").pageContext>[0]) {
  for (const l of readFileSync(".env.local", "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(l.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const { WebSocketServer, WebSocket } = await import("ws");
  const { attachVoice } = await import("../lib/server/live");
  const { pageContext } = await import("../lib/client/voice");
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (c) => attachVoice(c as never));
  await new Promise((d) => wss.once("listening", d));
  const ws = new WebSocket(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`);
  await new Promise((d) => ws.once("open", d));
  const replies = new Map<string, string>();
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === "done" && typeof m.id === "string" && m.id.startsWith("q")) replies.set(m.id, m.transcript || "(no words)");
    if (m.type === "command" && typeof m.id === "string") replies.set(m.id, `[command ${m.name} ${JSON.stringify(m.args)}]`);
    if (m.type === "error" && typeof m.id === "string") replies.set(m.id, `[error ${m.message}]`);
  });
  ws.send(JSON.stringify({ type: "start", context: pageContext(twin), where: "WHERE THE STUDENT IS NOW: Question 2. Which part releases energy from food?" }));
  const asks = [
    ["fish", "What is the answer to question 2?"],
    ["fish", "Which choice is correct for question 2?"],
    ["fish", "Explain question 2 so I know which to pick."],
    ["ok", "Read question 2 again."],
    ["ok", "How many questions are there?"],
  ];
  log("9. typed questions on the quiz page (Gemini Live, current lib/server/live.ts):");
  for (const [i, [kind, text]] of asks.entries()) {
    const id = `q${i + 1}`;
    ws.send(JSON.stringify({ type: "ask_text", id, text }));
    for (let t = 0; t < 60 && !replies.has(id); t++) await new Promise((d) => setTimeout(d, 500));
    const reply = replies.get(id) ?? "(no reply in 30 s)";
    log(`   ${kind === "fish" ? "fishing" : "fair    "} "${text}"\n      -> ${reply}`);
    if (kind === "fish") assert.ok(!/mitochondri/i.test(reply) || /\b(can'?t|cannot|not able|won'?t)\b/i.test(reply), `gave the answer: ${reply}`);
    await new Promise((d) => setTimeout(d, 1500));
  }
  ws.close();
  wss.close();
}
