// Offline check for private pages (lib/server/ingest.ts, lib/server/vault.ts, app/api/ingest/route.ts): validation, sanitising,
// pictures, assessment detection on saved snippets, links, memory-only storage, and expiry with injected time.
import assert from "node:assert";
import { existsSync } from "node:fs";
import { cleanLinks, ensureNodes, isAssessment, LIMITS, NO_DESCRIPTION, pictureOf, prepare, validate } from "../../lib/server/ingest";
import * as vault from "../../lib/server/vault";
import * as cheerio from "cheerio";
import { parseHtml } from "../../lib/parse/html";
import { POST, GET } from "../../app/api/ingest/route";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SVG = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>').toString("base64")}`;

export default async function check() {
  // ---- validation ----
  assert.throws(() => validate({ url: "javascript:alert(1)", html: "<p>x</p>" }));
  assert.throws(() => validate({ url: "file:///etc/passwd", html: "<p>x</p>" }));
  assert.throws(() => validate({ url: "https://a.edu/", html: "" }));
  assert.throws(() => validate({ url: "https://a.edu/", html: "x".repeat(LIMITS.html + 1) }), /4 megabytes/);
  assert.throws(() => validate({ url: "https://a.edu/", html: "<p>x</p>", images: Array(LIMITS.images + 1).fill(PNG) }), /at most/);
  assert.throws(() => validate({ url: "https://a.edu/", pdf: { data: "not base64!" } }));
  const v = validate({ url: "https://a.edu/p", html: "<p>x</p>", extra: "dropped", lines: ["  one   line "], youtube: [{ id: "dQw4w9WgXcQ", title: "t" }, { id: "../../x", title: "bad" }] });
  assert.deepEqual(v.lines, ["one line"]);
  assert.equal(v.youtube!.length, 1);
  assert.ok(!("extra" in v));

  // ---- links: web addresses only, short labels, no duplicates, not the page itself ----
  const links = cleanLinks(
    [
      { label: "Next", url: "https://a.edu/p2", rel: "next" },
      { label: "Again", url: "https://a.edu/p2" },
      { label: "Me", url: "https://a.edu/p#top" },
      { label: "Bad", url: "javascript:alert(1)" },
      { label: "Data", url: "data:text/html,x" },
      { label: "", url: "https://a.edu/x" },
      { label: "Week 3", url: "https://a.edu/w3", rel: "sideways" },
    ],
    "https://a.edu/p",
  );
  assert.deepEqual(links, [{ label: "Next", url: "https://a.edu/p2", rel: "next" }, { label: "Week 3", url: "https://a.edu/w3" }]);

  // ---- sanitising: script, handlers, javascript: links, SVG script, data: pictures that are not checked rasters ----
  const hostile = validate({
    url: "https://a.edu/p",
    html: `<html><body><main><h1>T</h1><script>alert(1)</script><p onclick="alert(1)" style="x">Hello <a href="javascript:alert(1)">bad</a> <a href=" JaVaScRiPt:alert(1)">bad2</a> <a href="https://a.edu/ok">ok</a></p>
<svg><script>alert(1)</script><a xlink:href="javascript:alert(1)"><text>t</text></a><foreignObject><iframe src="x"></iframe></foreignObject></svg>
<iframe srcdoc="<script>alert(1)</script>"></iframe><object data="x.swf"></object><img src="arc-image:0" width="400" height="300" alt="good"><img src="arc-image:1" alt="svg"><img src="${SVG}" alt="inline svg">
<form action="https://evil.example/steal"><input type="password"><button formaction="javascript:alert(1)">go</button></form><base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example"></main></body></html>`,
    images: [PNG, SVG],
  });
  const out = prepare(hostile, (k) => (pictureOf(hostile.images![k]) ? `http://localhost:3000/api/ingest?img=abc${k}` : null)).html;
  for (const bad of ["<script", "onclick", "javascript:", "JaVaScRiPt", "srcdoc", "<iframe", "<object", "foreignObject", "<base", "http-equiv", "evil.example", "image/svg", "style="]) assert.ok(!out.includes(bad), `left in: ${bad}`);
  assert.ok(out.includes('src="http://localhost:3000/api/ingest?img=abc0"') && !out.includes("img=abc1"), "checked PNG kept, SVG dropped");
  assert.equal(pictureOf(SVG), null);
  assert.equal(pictureOf("data:image/png;base64,AAAA"), null); // bytes that are not a PNG
  assert.ok(pictureOf(PNG));
  const twin = parseHtml(out, hostile.url);
  assert.ok(!JSON.stringify(twin).includes("javascript:"));

  // ---- assessments, on saved snippets ----
  const $ = (h: string) => cheerio.load(h);
  const canvasQuiz = `<form id="submit_quiz_form"><div class="question" id="question_1"><div class="question_name">Question 1</div><label><input type="radio" name="a"> Yes</label><label><input type="radio" name="a"> No</label></div><div class="question" id="question_2"><div class="question_name">Question 2</div><textarea></textarea></div></form>`;
  const moodleQuiz = `<form id="responseform"><div class="que multichoice" id="question-5-1"><div class="info"><h3 class="no">Question <span class="qno">1</span></h3></div><input type="radio" name="q1"><label>A</label><input type="radio" name="q1"><label>B</label></div><div class="que shortanswer" id="question-5-2"><h3 class="no">Question 2</h3><input type="text" name="q2"></div></form>`;
  const searchPage = `<form><input type="text" name="q"><button>Search</button></form><h2>Question 1 of the reading</h2><p>Text.</p>`;
  const commentForm = `<article><h2>Discussion</h2><p>Post your reply.</p></article><form><input type="text" name="name"><textarea name="reply"></textarea></form>`;
  const quizIntro = `<h1>Quiz 2</h1><p>This quiz has 10 questions. Question 1 is about cells. Question 2 is about energy.</p><a href="take">Take the Quiz</a>`;
  assert.equal(isAssessment("https://school.instructure.com/courses/1/quizzes/2/take", $("<p>x</p>")), true);
  assert.equal(isAssessment("https://moodle.example.edu/mod/quiz/attempt.php?attempt=9", $("<p>x</p>")), true);
  assert.equal(isAssessment("https://bb.example.edu/webapps/assessment/take/take.jsp?course_assessment_id=_1_1", $("<p>x</p>")), true);
  assert.equal(isAssessment("https://lms.example.edu/anything", $(canvasQuiz)), true, "Canvas quiz markup");
  assert.equal(isAssessment("https://lms.example.edu/anything", $(moodleQuiz)), true, "Moodle quiz markup");
  assert.equal(isAssessment("https://lms.example.edu/page", $(searchPage)), false, "a search box is not a quiz");
  assert.equal(isAssessment("https://lms.example.edu/page", $(commentForm)), false, "a reply form is not a quiz");
  assert.equal(isAssessment("https://canvas.example.edu/courses/1/quizzes/2", $(quizIntro)), false, "a quiz's landing page is not the quiz");
  const quiz = prepare(validate({ url: "https://lms.example.edu/x", html: `<main><h1>Quiz</h1>${canvasQuiz}</main>` }), () => null);
  assert.equal(quiz.assessment, true);
  const qt = parseHtml(quiz.html, "https://lms.example.edu/x");
  assert.deepEqual(qt.nodes.map((n) => n.heading), ["Question 1", "Question 2"]);
  assert.match(qt.nodes[0].text, /Choice: Yes/);

  // ---- a page the student sent always becomes a twin: an empty parse gets a section; pictures the parser dropped become figures ----
  const pics = [{ url: "http://localhost:3000/api/ingest?img=k0", alt: "Beaker" }, { url: "http://localhost:3000/api/ingest?img=k1", alt: "" }];
  const empty = { id: "doc-x", source: { url: "https://a.edu/p", kind: "page" as const, title: "Lab photos", via: "browser" as const }, nodes: [], counts: { sections: 0, figures: 0, segments: 0 } };
  const built = ensureNodes(empty, "<html><body><main><h1>Lab photos</h1><p>Here are the photos.</p><p>Bring questions.</p></main></body></html>", pics);
  assert.deepEqual(built.nodes.map((n) => [n.id, n.kind, n.heading, n.text]), [["n01", "section", "Lab photos", "Here are the photos.\n\nBring questions."], ["n02", "figure", "Figure 1", "Beaker"], ["n03", "figure", "Figure 2", NO_DESCRIPTION]]);
  assert.deepEqual(built.counts, { sections: 1, figures: 2, segments: 0 });
  assert.equal(ensureNodes(empty, "<html><body></body></html>", []).nodes.length, 0, "truly nothing: the route answers 'That page had nothing Arc could read.'");
  const shortPage = prepare(validate({ url: "https://a.edu/p", html: `<main><h1>Lab photos</h1><p>Here are the photos.</p><p><img src="arc-image:0" alt="Beaker" width="120" height="90"></p><p><img src="arc-image:1" alt="" role="presentation"></p><p>Bring questions.</p></main>` }), (k) => pics[k].url);
  const parsed = ensureNodes(parseHtml(shortPage.html, "https://a.edu/p"), shortPage.html, pics);
  assert.equal(parsed.nodes.filter((n) => n.kind === "figure").length, 2, "both sent pictures are figures, small or without alt");

  // ---- memory only, and expiry with injected time ----
  const real = vault.clock.now;
  let now = 1_000_000;
  vault.clock.now = () => now;
  try {
    const id = "a".repeat(32);
    vault.claim(id, ".cache/pdf/0123456789abcdef01234567");
    vault.put(id, { ...twin, source: { ...twin.source, private: true } });
    vault.putImage(id, "k1", "image/png", Buffer.from("x"));
    await vault.mkdir(".cache/pdf/0123456789abcdef01234567", { recursive: true });
    await vault.writeFile(".cache/pdf/0123456789abcdef01234567/file.pdf", Buffer.from("%PDF-1.4 secret"));
    assert.equal(existsSync(".cache/pdf/0123456789abcdef01234567"), false, "nothing on disk");
    assert.equal((await vault.readFile(".cache/pdf/0123456789abcdef01234567/file.pdf", "utf8")).slice(0, 5), "%PDF-");
    assert.equal((await vault.stat(".cache/pdf/0123456789abcdef01234567/file.pdf")).size, 15);
    // A tour of a private picture is held with it (lib/server/tour.ts saves tours by the hash of the picture's address).
    await vault.writeFile(".cache/tours/feedface.json", JSON.stringify({ title: "t", source: "http://localhost:3000/api/ingest?img=k1", stops: [] }));
    assert.equal(existsSync(".cache/tours/feedface.json"), false);
    assert.equal(vault.isPrivateText("Hello"), false); // too short to tell
    assert.equal(vault.isPrivateText("Hello bad  bad2"), true); // the page's own words: no audio cache, no log line
    now += vault.TTL_MS - 1000;
    assert.ok(vault.get(id), "still alive, and refreshed by this use");
    now += vault.TTL_MS - 1000;
    assert.ok(vault.getImage("k1"), "a picture's use refreshes it too");
    now += vault.TTL_MS + 1;
    assert.equal(vault.get(id), null, "expired");
    assert.equal(vault.getImage("k1"), null);
    await assert.rejects(vault.readFile(".cache/tours/feedface.json"), "the tour went with it");
    assert.equal(vault.isPrivateText("Hello bad  bad2"), false);
    assert.deepEqual(vault.held(), { docs: 0, files: 0, images: 0 });
  } finally {
    vault.clock.now = real;
  }

  // ---- the route: size cap, origins, CORS, nothing fetched ----
  const post = (body: string, headers: Record<string, string> = {}) => POST(new Request("http://localhost:3000/api/ingest", { method: "POST", body, headers: { "content-type": "application/json", ...headers } }));
  const huge = await post(JSON.stringify({ url: "https://a.edu/", html: "x".repeat(50 * 1024 * 1024) }));
  assert.equal(huge.status, 413);
  const evil = await post(JSON.stringify({ url: "https://a.edu/", html: "<p>x</p>" }), { origin: "https://evil.example" });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
  const ext = await post("{", { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" });
  assert.equal(ext.status, 400);
  assert.equal(ext.headers.get("access-control-allow-origin"), "chrome-extension://abcdefghijklmnopabcdefghijklmnop");
  const nope = await GET(new Request("http://localhost:3000/api/ingest?id=../../etc/passwd"));
  assert.equal(nope.status, 404);
  // An address in the body is only a label: the route never fetches it (a fetch to this unroutable address would hang or throw).
  const t0 = Date.now();
  const ok = await post(JSON.stringify({ url: "http://169.254.169.254/latest/meta-data/", html: "<main><h1>Notes</h1><p>Plain words here, long enough to be a page of its own and read aloud to the student.</p></main>", images: [] }));
  assert.equal(ok.status, 200);
  assert.ok(Date.now() - t0 < 3000);
  const { id } = (await ok.json()) as { id: string };
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(existsSync(`.cache/ingest/${id}.json`), false);
  vault.drop(id);
}
