// Check for extension/extract.js in a real browser engine with no network: every address is answered by page.route from saved
// snippets (learning-system navigation markup, and a mocked Canvas API with its while(1); prefix and its unreadable picture
// redirect). Needs Google Chrome (playwright-core, channel "chrome"); skipped with a note when it is not installed.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { png } from "../private-fixture.mjs";

const EXTRACT = readFileSync("extension/extract.js", "utf8");
type Out = { html: string; images: string[]; links: { label: string; url: string; rel?: string }[]; lines: string[]; via?: string; trace?: { endpoint: string; status: number }[]; frames: { src: string }[]; youtube: { id: string }[] };

async function read(b: Browser, url: string, routes: Record<string, { body: string | Buffer; type?: string; status?: number; headers?: Record<string, string> }>): Promise<Out> {
  const page: Page = await b.newPage();
  await page.route("**/*", (r) => {
    const u = new URL(r.request().url());
    const hit = routes[u.pathname + u.search] ?? routes[u.pathname] ?? routes[`${u.host}${u.pathname}`];
    return hit ? r.fulfill({ status: hit.status ?? 200, contentType: hit.type ?? "text/html", body: hit.body, headers: hit.headers }) : r.fulfill({ status: 404, body: "" });
  });
  await page.goto(url);
  await page.evaluate(EXTRACT);
  const out = await page.evaluate(() => (globalThis as unknown as { __arcExtract: (o: object) => Promise<Out> }).__arcExtract({ noSettle: true }));
  await page.close();
  return out;
}
const html = (body: string, title = "Page") => ({ body: `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>` });
const json = (v: unknown) => ({ body: `while(1);${JSON.stringify(v)}`, type: "application/json" });
const prose = "<p>" + "Cells are the basic unit of life, and every cell has a membrane. ".repeat(30) + "</p>";

export default async function check() {
  const b = await chromium.launch({ channel: "chrome", headless: true }).catch(() => null);
  if (!b) return void console.log("  (extract.ts skipped: Google Chrome is not installed)");
  try {
    // Canvas rendered page (classic module footer), Moodle 4 activity navigation and course index, D2L and Blackboard words.
    const canvas = await read(b, "https://canvas.test/courses/9/pages/intro", {
      "/courses/9/pages/intro": html(`<div id="left-side"><nav role="navigation" aria-label="Courses Navigation Menu" id="section-tabs"><a href="/courses/9">Home</a><a href="/courses/9/modules">Modules</a><a href="/courses/9/grades">Grades</a><a href="/courses/9/users">People</a></nav></div><div id="content"><h1>Intro</h1>${prose}</div>
<div class="module-sequence-footer"><div class="module-sequence-footer-button--previous" data-tooltip="right"><a href="/courses/9/modules/items/101" role="button" class="Button" aria-describedby="msf0-previous-desc">Previous</a></div><div class="module-sequence-footer-button--next" data-tooltip="left"><a href="/courses/9/modules/items/103" role="button" class="Button" aria-describedby="msf0-next-desc">Next</a></div></div>`),
      "/api/v1/courses/9": { body: "Not JSON", status: 401 }, // the probe fails: the rendered page is used
    });
    assert.equal(canvas.via, undefined);
    assert.deepEqual(canvas.links.filter((l) => l.rel).map((l) => [l.rel, new URL(l.url).pathname]), [["prev", "/courses/9/modules/items/101"], ["next", "/courses/9/modules/items/103"]]);
    assert.ok(canvas.links.some((l) => l.label === "Modules") && !canvas.links.some((l) => /Grades|People/.test(l.label)), "course menu kept, grades and people skipped");

    const moodle = await read(b, "https://moodle.test/mod/page/view.php?id=12", {
      "/mod/page/view.php": html(`<nav id="courseindex" class="courseindex"><a class="courseindex-link" href="https://moodle.test/course/section.php?id=1">Week 1</a><a class="courseindex-link" href="https://moodle.test/mod/page/view.php?id=11">Lesson 1</a><a class="courseindex-link" href="https://moodle.test/mod/page/view.php?id=13">Lesson 3</a></nav><div role="main"><h2>Lesson 2</h2>${prose}</div>
<div class="activity-navigation"><a href="https://moodle.test/mod/page/view.php?id=11&forceview=1" id="prev-activity-link" class="btn btn-link" title="Lesson 1">&#x25C4; Lesson 1</a><a href="https://moodle.test/mod/page/view.php?id=13&forceview=1" id="next-activity-link" class="btn btn-link" title="Lesson 3">Lesson 3 &#x25BA;</a></div>`),
    });
    assert.deepEqual(moodle.links.filter((l) => l.rel).map((l) => `${l.rel} ${l.label}`).sort(), ["next Lesson 3", "prev Lesson 1"]);
    assert.ok(moodle.links.some((l) => l.label === "Week 1"));

    const d2l = await read(b, "https://d2l.test/d2l/le/content/5/viewContent/7/View", {
      "/d2l/le/content/5/viewContent/7/View": html(`<h1>Topic</h1>${prose}<a class="d2l-iterator-button d2l-iterator-button-prev" href="/d2l/le/content/5/viewContent/6/View" aria-label="Previous topic: Reading 1">&lt;</a><a class="d2l-iterator-button d2l-iterator-button-next" href="/d2l/le/content/5/viewContent/8/View" aria-label="Next topic: Reading 3">&gt;</a>`),
    });
    assert.ok(d2l.links.some((l) => l.rel === "next" && /\/8\/View$/.test(l.url)) && d2l.links.some((l) => l.rel === "prev" && /\/6\/View$/.test(l.url)));

    // Frames: YouTube becomes a video; a calendar embed and a media player leave one honest line each.
    const frames = await read(b, "https://lms.test/p", {
      "/p": html(`<h1>Week 1</h1>${prose}<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="Intro video"></iframe><iframe src="https://calendar.google.com/calendar/embed?src=x" title="Class calendar"></iframe><iframe src="https://cdnapisec.kaltura.com/p/1/embedIframeJs" title="Lecture 1"></iframe>`),
    });
    assert.deepEqual(frames.youtube.map((y) => y.id), ["dQw4w9WgXcQ"]);
    assert.equal(frames.frames.length, 2);
    assert.match(frames.html, /Something from calendar\.google\.com is embedded here: Class calendar/);
    assert.match(frames.html, /A video from cdnapisec\.kaltura\.com is here: Lecture 1/);

    // Canvas through its API: while(1); prefix; a picture whose preview redirect is unreadable but whose file object names a
    // readable download; an equation; next and previous from module_item_sequence; module items as links.
    const PNG = png(200, 120);
    const api = {
      "/courses/9/pages/cells": html(`<div id="content">rendered page (not used)</div>`),
      "/api/v1/courses/9": json({ id: 9, name: "Biology 101" }),
      "/api/v1/courses/9/pages/cells": json({ title: "Cells", url: "cells", body: `<p>Cells are small.</p><p><img src="/courses/9/files/5/preview" data-api-endpoint="https://canvas.test/api/v1/courses/9/files/5" data-api-returntype="File" alt="A cell" loading="lazy"></p><p>Rate: <img class="equation_image" title="J = -D \\frac{dc}{dx}" src="/equation_images/J" alt="LaTeX: J = -D \\frac{dc}{dx}" data-equation-content="J = -D \\frac{dc}{dx}"></p>${prose}` }),
      "/courses/9/files/5/preview": { body: "", status: 302, headers: { location: "https://cdn.inst-fs.test/blocked" } },
      "cdn.inst-fs.test/blocked": { body: "nope", status: 403 },
      "/api/v1/courses/9/files/5": json({ id: 5, display_name: "cell.png", "content-type": "image/png", url: "https://canvas.test/files/5/download?download_frd=1" }),
      "/files/5/download": { body: PNG, type: "image/png" },
      "/api/v1/courses/9/module_item_sequence": json({ items: [{ prev: { title: "Welcome", html_url: "https://canvas.test/courses/9/modules/items/1" }, current: {}, next: { title: "Energy", html_url: "https://canvas.test/courses/9/modules/items/3" } }] }),
      "/api/v1/courses/9/modules": json([{ name: "Week 1", items: [{ type: "SubHeader", title: "Read" }, { type: "Page", title: "Cells", html_url: "https://canvas.test/courses/9/modules/items/2" }, { type: "File", title: "Notes.pdf", html_url: "https://canvas.test/courses/9/modules/items/4" }] }]),
    };
    const cv = await read(b, "https://canvas.test/courses/9/pages/cells", api);
    assert.equal(cv.via, "canvas-api");
    assert.equal(cv.images.length, 1, "picture resolved through its file API object");
    assert.match(cv.html, /src="arc-image:0"/);
    assert.match(cv.html, /<math alttext="J = -D \\frac\{dc\}\{dx\}"/);
    assert.deepEqual(cv.links.map((l) => [l.rel ?? "-", l.label]), [["prev", "Welcome"], ["next", "Energy"], ["-", "Cells"], ["-", "Notes.pdf"]]);
    assert.deepEqual(cv.trace!.map((t) => t.endpoint.split("?")[0]), ["/api/v1/courses/N", "/api/v1/courses/N/pagesX", "/api/v1/courses/N/module_item_sequence", "/api/v1/courses/N/modules"].map((e) => e.replace("pagesX", "pages/X")));

    // An assignment: its facts as sentences in their own first paragraph. Grades: one line, no API call past the probe.
    const as = await read(b, "https://canvas.test/courses/9/assignments/7", {
      "/courses/9/assignments/7": html("x"),
      "/api/v1/courses/9": json({ id: 9, name: "Biology 101" }),
      "/api/v1/courses/9/assignments/7": json({ name: "Lab report", description: `<h2>Task</h2>${prose}`, due_at: "2026-11-21T07:59:00Z", points_possible: 100, submission_types: ["online_upload"] }),
    });
    assert.match(as.html, /<p>This assignment is due \w+day, November 2\d, 2026, at \d{1,2}:59\s?[AP]M\. It is worth 100 points\. Hand it in by uploading a file on Canvas\.<\/p>/);
    const grades = await read(b, "https://canvas.test/courses/9/grades", { "/courses/9/grades": html(`<table><tr><td>Lab</td><td>95</td></tr></table>`), "/api/v1/courses/9": json({ id: 9 }) });
    assert.match(grades.lines[0], /does not read grades/);
    assert.ok(!/95/.test(grades.html));
    assert.deepEqual(grades.trace ?? [], []);
    // A quiz being taken: never the API, the open page itself.
    const take = await read(b, "https://canvas.test/courses/9/quizzes/3/take", { "/courses/9/quizzes/3/take": html(`<h1>Quiz</h1>${prose}`), "/api/v1/courses/9": json({ id: 9 }) });
    assert.equal(take.via, undefined);
  } finally {
    await b.close();
  }
}
