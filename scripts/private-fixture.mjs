// A pretend signed-in learning site on 127.0.0.1, for testing Arc's helper without anyone's account.
// node scripts/private-fixture.mjs [port]   (default 8765)
// /login sets a cookie (no password: it just signs you in). Without the cookie every /course page, picture, caption file and PDF
// answers with a sign-in page. With it: late-rendered content, a picture that needs the cookie, a same-site frame, a Canvas-style
// equation, a linked PDF, next/previous and module links, a video with a caption track, and a quiz "take" page.
// Every page carries the marker ZEBRAQUARTZ-7741 so a check can grep .cache/ for it. Imported by scripts/private-e2e.ts.
import http from "node:http";
import zlib from "node:zlib";
import { PDFDocument, StandardFonts } from "pdf-lib";

export const MARKER = "ZEBRAQUARTZ-7741";

/** A real PNG (w x h, a blue box on white, a dark line), made without any image library. */
export function png(w = 480, h = 320) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      const box = x > 60 && x < 220 && y > 60 && y < 260;
      const line = Math.abs(y - (h - x * 0.5)) < 3;
      const [r, g, b] = line ? [30, 30, 30] : box ? [40, 90, 200] : [255, 255, 255];
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function pdf() {
  const doc = await PDFDocument.create();
  doc.setTitle(`Week 2 notes ${MARKER}`);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [i, lines] of [
    ["Week 2 notes", "", "Cells are the basic unit of life.", "Every cell has a membrane that controls what enters and leaves.", "The nucleus holds the genetic material."],
    ["Mitochondria", "", "Mitochondria release energy from food.", "Cells that work hard, like muscle cells, have many of them."],
  ].entries()) {
    const page = doc.addPage([612, 792]);
    lines.forEach((t, k) => page.drawText(t, { x: 72, y: 700 - k * 24, size: k === 0 ? 22 : 13, font }));
    page.drawText(`Page ${i + 1}`, { x: 72, y: 60, size: 10, font });
  }
  return Buffer.from(await doc.save());
}

const shell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} | Biology 101</title></head><body>
<header><a href="/course">Biology 101</a> <a href="/logout">Log out</a></header>
<nav aria-label="Course navigation" id="section-tabs"><a href="/course">Home</a> <a href="/course/modules">Modules</a> <a href="/course/grades">Grades</a></nav>
<main id="content">${body}</main>
<footer>Fixture learning site</footer></body></html>`;

const signInPage = shell("Sign in", `<h1>Sign in to continue</h1><p>You need to log in to view this course.</p><form action="/login" method="post"><label>User <input name="u"></label><label>Password <input type="password" name="p"></label><button>Log in</button></form>`);

const modules = `<div id="context_modules"><h2>Week 2</h2><ul>
<li><a class="ig-title" href="/course/pages/cells">Cells and membranes</a></li>
<li><a class="ig-title" href="/course/pages/energy">Energy in cells</a></li>
<li><a class="ig-title" href="/course/files/notes">Week 2 notes (PDF)</a></li>
<li><a class="ig-title" href="/course/pages/video">Lecture video</a></li></ul></div>`;

const footer = (prev, next) => `<div class="module-sequence-footer">${prev ? `<span class="module-sequence-footer-button--previous"><a href="${prev}" aria-label="Previous Module Item">Previous</a></span>` : ""}${next ? `<span class="module-sequence-footer-button--next"><a href="${next}" aria-label="Next Module Item">Next</a></span>` : ""}</div>`;

const PAGES = {
  "/course/pages/cells": () =>
    shell(
      "Cells and membranes",
      `<div id="late">Loading…</div>
<script>
  // Late rendering, as learning systems do: the article arrives 1.2 s after load.
  setTimeout(() => { document.getElementById("late").outerHTML = ${JSON.stringify(`<article><h1>Cells and membranes</h1>
<p>Every living thing is made of cells. ${MARKER} This page explains the cell membrane, which lets some things in and keeps others out.</p>
<h2>The membrane</h2><p>The membrane is a double layer of fat molecules with proteins set into it. Small molecules such as oxygen cross it freely.</p>
<figure><img src="/course/files/diagram.png" alt="Diagram of a cell membrane" width="480" height="320"><figcaption>Figure 1. A cell membrane with a channel protein.</figcaption></figure>
<h2>Diffusion</h2><p>Diffusion moves molecules from where there are many to where there are few. The rate follows <img class="equation_image" data-equation-content="J = -D \\frac{dc}{dx}" alt="LaTeX: J = -D \\frac{dc}{dx}" src="/equation_images/x">, which is Fick's first law.</p>
<h2>Activity</h2><iframe src="/course/frame" title="Practice activity"></iframe>
<p>Next week we look at energy in cells.</p></article>`)}; }, 1200);
</script>
${footer(null, "/course/pages/energy")}${modules}`,
    ),
  "/course/pages/energy": () =>
    shell("Energy in cells", `<h1>Energy in cells</h1><p>Cells need energy to live. ${MARKER} Mitochondria release it from sugar in a process called respiration.</p><h2>Respiration</h2><p>Glucose and oxygen become carbon dioxide, water and usable energy. Muscle cells have many mitochondria because they work hard.</p><h2>Fermentation</h2><p>Without oxygen, some cells ferment sugar instead. It releases far less energy.</p>${footer("/course/pages/cells", "/course/files/notes")}${modules}`),
  "/course/files/notes": () => shell("Week 2 notes", `<h1>Week 2 notes.pdf</h1><p><a href="/course/files/notes.pdf" class="instructure_file_link">Download Week 2 notes.pdf</a></p>${footer("/course/pages/energy", "/course/pages/video")}`),
  "/course/pages/video": () =>
    shell("Lecture video", `<h1>Lecture: inside the cell</h1><p>Watch the lecture, then try the quiz. ${MARKER}</p><video controls title="Inside the cell" src="/course/files/lecture.mp4"><track kind="captions" srclang="en" src="/course/files/lecture.vtt" label="English"></video><p>The lecture is about ten minutes long and covers the parts of the cell in order.</p><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="A short extra video"></iframe>${footer("/course/files/notes", null)}`),
  "/course/frame": () => `<!doctype html><html><head><title>Practice</title></head><body><h2>Practice activity</h2><p>Name the two layers of the membrane. ${MARKER}-FRAME</p></body></html>`,
  "/course/quizzes/3/take": () =>
    shell("Quiz 2: Cells", `<h1>Quiz 2: Cells</h1><p>Answer every question. ${MARKER}</p><form id="submit_quiz_form" action="/course/quizzes/3/submit" method="post">
<div class="question" id="question_1"><div class="question_name">Question 1</div><div class="question_text">What does the cell membrane control?</div>
<label><input type="radio" name="q1" value="a"> What enters and leaves the cell</label><label><input type="radio" name="q1" value="b"> The colour of the cell</label></div>
<div class="question" id="question_2"><div class="question_name">Question 2</div><div class="question_text">Which part releases energy from food?</div>
<label><input type="radio" name="q2" value="a"> The nucleus</label><label><input type="radio" name="q2" value="b"> The mitochondria</label></div>
<div class="question" id="question_3"><div class="question_name">Question 3</div><div class="question_text">In one sentence, what is diffusion?</div><textarea name="q3"></textarea></div>
<button type="submit">Submit quiz</button></form>`),
  // The shape of a real short Canvas page that once gave an empty twin: a title, two pictures each alone in a paragraph (Canvas
  // markup: a preview address that redirects somewhere unreadable, and the file's API object), three short sentences.
  "/course/pages/photos": () =>
    shell("Lab photos", `<h1>Lab photos</h1><p>Here are the photos from Tuesday. ${MARKER}</p><p><img src="/course/files/7/preview" data-api-endpoint="/api/v1/courses/1/files/7" data-api-returntype="File" alt="Beaker on a hot plate" loading="lazy"></p><p>Look at the colour change.</p><p><img src="/course/files/8/preview" data-api-endpoint="/api/v1/courses/1/files/8" data-api-returntype="File" alt="" loading="lazy"></p><p>Bring questions to class.</p>`),
  "/course/modules": () => shell("Modules", `<h1>Modules</h1>${modules}`),
};

const VTT = `WEBVTT

00:00:01.000 --> 00:00:05.000
Welcome to the lecture on the inside of the cell.

00:00:05.500 --> 00:00:11.000
First we look at the nucleus, which holds the cell's genetic material.

00:00:52.000 --> 00:00:58.000
Next, the mitochondria, which release energy from food. ${MARKER}
`;

export function start(port = 8765) {
  let PDF;
  const PNG = png();
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const signed = /(?:^|;\s*)fixture_session=ok(?:;|$)/.test(req.headers.cookie ?? "");
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...extra });
      res.end(body);
    };
    if (u.pathname === "/login") return send(302, "text/plain", "", { "set-cookie": "fixture_session=ok; Path=/; HttpOnly; SameSite=Lax", location: u.searchParams.get("next") || "/course/pages/cells" });
    if (u.pathname === "/logout") return send(302, "text/plain", "", { "set-cookie": "fixture_session=; Path=/; Max-Age=0", location: "/" });
    if (u.pathname === "/") return send(200, "text/html", shell("Welcome", `<h1>Fixture learning site</h1><p><a href="/login">Sign in</a> (no password: this only sets a cookie).</p>`));
    if (!u.pathname.startsWith("/course") && !u.pathname.startsWith("/api/v1/")) return send(404, "text/plain", "not found");
    if (!signed) return /\.(png|pdf|vtt|mp4)$/.test(u.pathname) ? send(401, "text/html", signInPage) : send(200, "text/html", signInPage);
    if (u.pathname === "/course/files/diagram.png") return send(200, "image/png", PNG);
    if (/^\/course\/files\/\d+\/preview$/.test(u.pathname)) return send(302, "text/plain", "", { location: "http://127.0.0.1:9/unreadable" }); // like Canvas's file host hop
    if (/^\/api\/v1\/courses\/1\/files\/\d+$/.test(u.pathname) && signed) return send(200, "application/json", `while(1);${JSON.stringify({ id: 7, display_name: "photo.png", "content-type": "image/png", url: "/course/files/diagram.png?download_frd=1" })}`);
    if (u.pathname === "/course/files/notes.pdf") return send(200, "application/pdf", (PDF ??= await pdf()));
    if (u.pathname === "/course/files/lecture.vtt") return send(200, "text/vtt", VTT);
    if (u.pathname === "/course/files/lecture.mp4") return send(404, "text/plain", "no media in the fixture");
    if (u.pathname === "/course" || u.pathname === "/course/") return send(302, "text/plain", "", { location: "/course/pages/cells" });
    const page = PAGES[u.pathname];
    return page ? send(200, "text/html", page()) : send(404, "text/html", shell("Not found", "<h1>Page not found</h1>"));
  });
  return new Promise((done) => server.listen(port, "127.0.0.1", () => done(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2]) || 8765;
  void start(port).then(() => console.log(`fixture learning site on http://127.0.0.1:${port}/ (sign in at /login)`));
}
