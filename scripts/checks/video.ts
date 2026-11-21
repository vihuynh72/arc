// Offline: YouTube link forms, the canonical address and plain error sentences; the Gemini route's window bounds and how model
// parts become stable, ordered, contiguous segments; the opt-in caption route's parsing, cleaning and segment boundaries;
// describe grouping; Khan link detection.
import assert from "node:assert";
import { cleanCues, clock, parseTimedText, pickTrack, segmentCues, type Cue } from "../../lib/server/captions";
import { isKhanVideo } from "../../lib/server/khan";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { cleanShown, evenOut, frameAt, pickFrames, requestFrame, restore, tile, winOf, winStart, windows } from "../../lib/server/videoQueue";
import { youtubeCanonical, youtubeId } from "../../lib/server/oembed";
import { dueAt, midSentence, saidBefore, saidTime, screenAt, screenLines, videoContext, WAIT_S, watchVideo } from "../../lib/client/video";
import type { Twin, TwinNode } from "../../lib/types";
import { plainVideoError } from "../../lib/server/video";

export default async function check() {
  await restored();
  const ID = "EPvd-3712U8";
  for (const link of [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=30s&list=PLxyz&si=abc`,
    `https://www.youtube.com/watch?list=PLxyz&v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abc&t=12`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}?start=5`,
    `https://www.youtube.com/live/${ID}?feature=share`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}&list=RDAMVM${ID}`,
    `http://www.youtube.com/v/${ID}`,
    `  https://youtu.be/${ID}  `,
  ]) assert.equal(youtubeId(link), ID, link);
  for (const bad of [
    "https://example.com/watch?v=EPvd-3712U8",
    "https://notyoutube.com/watch?v=EPvd-3712U8",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/",
    "https://www.youtube.com/channel/EPvd-3712U8",
    "https://example.com/?u=youtu.be/EPvd-3712U8",
    "ftp://youtu.be/EPvd-3712U8",
    "not a link",
  ]) assert.equal(youtubeId(bad), null, bad);
  assert.equal(youtubeCanonical(ID), `https://www.youtube.com/watch?v=${ID}`);

  const raw = [
    plainVideoError(new Error('Gemini HTTP 403: { "error": { "code": 403, "status": "PERMISSION_DENIED" } }')),
    plainVideoError(new Error("Gemini HTTP 400: Unsupported MIME type: text/html")),
    plainVideoError(new Error("no model answered (gemini-4-hydrogen, gemini-3.5-flash-lite)")),
  ];
  assert.deepEqual(raw, [
    "I could not open that video. It may be private or removed.",
    "I could not open that video. It may be private or removed.",
    "I could not read that video just now. Try again in a minute.",
  ]);
  assert.match(plainVideoError(new Error("Gemini HTTP 403: embedding disabled by the owner")), /restricted access/);

  captions();
  client();
}

// What the student hears while a video plays: where a description may start, what it leaves out, and what a question can use.
function client() {
  assert.deepEqual([saidTime(85), saidTime(120), saidTime(40), saidTime(61)], ["1 minute 25", "2 minutes", "40 seconds", "1 minute 1"]);
  const seg = (id: string, start: number, end: number, text: string, extra: Partial<TwinNode> = {}) => ({ id, kind: "segment", heading: id, level: 2, order: start, text, start, end, ...extra }) as TwinNode;
  // A part that ends at a sentence end is due at its end; one the model cut mid-sentence waits for the next part's first sentence.
  const parts = [seg("a", 0, 30, "One. Two sentences here."), seg("b", 30, 60, "And not only do they"), seg("c", 60, 90, "tell us that they sold 18% of it. Then a second sentence follows that is much longer than the first one.")];
  assert.equal(dueAt(parts, 0), 30);
  const due = dueAt(parts, 1);
  assert.ok(due > 60 && due <= 60 + WAIT_S, `held to the sentence's end, or a word gap within ${WAIT_S} s: ${due}`);
  assert.equal(dueAt(parts, 2), 90);
  assert.equal(dueAt([parts[1]], 0), 60, "nothing after it yet: its own end");
  // A sentence that ends soon in the next part: waited for in full. One that runs on: the last word gap in the wait, and less is said.
  const soon = [parts[1], seg("d", 60, 90, "tell us. Then a second sentence follows that is much longer than the first one and goes on and on.")];
  assert.ok(dueAt(soon, 0) > 60 && dueAt(soon, 0) < 60 + WAIT_S && !midSentence(soon, 0));
  assert.ok(midSentence(parts, 1) && !midSentence(parts, 0) && !midSentence(parts, 2));
  // "What is on the screen right now": the description of the moment shown latest at or before now (a part describes its end).
  const pic = (id: string, at: number) => ({ url: `http://x/api/video/frame?id=v&node=${id}&at=${at}`, alt: null });
  const lec = [seg("p0", 0, 28, "a.", { shown: "Pie.", image: pic("p0", 15) }), seg("p1", 93, 127, "b.", { shown: "January.", image: pic("p1", 125) }), seg("p2", 127, 157, "c.", { shown: "June and July circled.", image: pic("p2", 155) }), seg("p3", 157, 189, "d.", { shown: "" })];
  assert.equal(screenAt(lec, 131), 1, "early in a part: the screen the part before described");
  assert.equal(screenAt(lec, 154), 2);
  assert.equal(screenAt(lec, 180), 2, "a part with nothing new: the last description still holds");
  assert.equal(screenAt(lec, 5), 0, "before any description's moment: the first one");
  assert.equal(screenAt([lec[3]], 10), -1);
  // A description repeating the screen says nothing, or only what is new.
  const first = "A pie chart shows twelve monthly slices labeled clockwise: January 18%, February 10%, March 7%. The speaker draws a yellow arrow pointing to the blue January 18% slice.";
  const again = "The pie chart displays twelve monthly slices: January 18%, February 10%, March 7%. A yellow arrow points to the blue January 18% slice, and the speaker circles 18% in yellow.";
  assert.equal(screenLines(first, [])[0].startsWith("On screen: A pie chart"), true);
  assert.deepEqual(screenLines(again, [first]), ["Now the speaker circles 18% in yellow."]);
  assert.deepEqual(screenLines(first, [first]), []);
  assert.deepEqual(screenLines("A table of three columns: name, age, city.", [first]).length > 0, true, "a different screen is said in full");
  // Only earlier parts count as already said, never the part itself.
  const said = new Map([["a", first], ["c", again]]);
  assert.deepEqual(saidBefore(said, parts, parts[1]), [first]);
  assert.deepEqual(saidBefore(said, parts, parts[0]), []);
  // The context a question uses: title, every description, a built tour's values, the whole transcript with times.
  assert.equal(videoContext(), "");
  const tour = { title: "Sales by month", overview: "A pie chart.", source: "x", stops: [{ n: 1, label: "January", says: "18 percent, at about 1 o'clock.", box_2d: [0, 0, 1, 1] as [number, number, number, number], confidence: "high" }] };
  const twin = { source: { title: "Pie graphs" }, video: { id: "x" }, nodes: [seg("a", 0, 30, "Hello there.", { shown: first, tour }), seg("b", 30, 60, "More words.", { shown: "" })] } as unknown as Twin;
  watchVideo(twin);
  const ctx = videoContext(8000);
  for (const want of ["Pie graphs", "January. 18 percent, at about 1 o'clock.", "ON SCREEN AT 0:00: A pie chart shows twelve", "[0:30] More words."]) assert.ok(ctx.includes(want), want);
  assert.ok(videoContext(300).length <= 300);
  watchVideo(null);
}

function captions() {
  // Human track: line breaks, entities (also double-encoded), a sound tag.
  const human = `<timedtext format="3"><body><p t="690" d="2360">An investment firm\ncreates a graph</p><p t="3050" d="1000">[Music]</p><p t="4050" d="2000">it&amp;#39;s &quot;up&quot; &amp; down</p></body></timedtext>`;
  assert.deepEqual(cleanCues(parseTimedText(human)), [
    { start: 0.69, end: 3.05, text: "An investment firm creates a graph" },
    { start: 4.05, end: 6.05, text: `it's "up" & down` },
  ]);
  // Automatic track: one cue per word, empty rolling lines dropped, overlapping lines cut where the next starts, a doubled line dropped.
  const asr = `<timedtext format="3"><body><p t="640" d="4360" w="1"><s>An</s><s t="160"> investment</s></p><p t="2990" d="2010" w="1" a="1">\n</p><p t="3000" d="5200" w="1"><s>showing</s><s t="320"> the</s></p><p t="4000" d="500"><s> the</s></p></body></timedtext>`;
  assert.deepEqual(cleanCues(parseTimedText(asr)), [
    { start: 0.64, end: 0.8, text: "An" },
    { start: 0.8, end: 3, text: "investment" },
    { start: 3, end: 3.32, text: "showing" },
    { start: 3.32, end: 8.2, text: "the" },
  ]);
  assert.equal(pickTrack([{ baseUrl: "a", languageCode: "de" }, { baseUrl: "b", languageCode: "en", kind: "asr" }, { baseUrl: "c", languageCode: "en" }])?.baseUrl, "c");
  assert.equal(pickTrack([{ baseUrl: "a", languageCode: "de" }, { baseUrl: "b", languageCode: "en", kind: "asr" }])?.baseUrl, "b");
  assert.equal(pickTrack([{ baseUrl: "a", languageCode: "de" }])?.baseUrl, "a");
  assert.equal(pickTrack([]), null);

  const bounds = (segs: Cue[]) => segs.map((s) => [s.start, s.end]);
  // Punctuated: each segment ends at the first sentence end past 25 s.
  const p = Array.from({ length: 20 }, (_, i) => ({ start: 5 * i, end: 5 * i + 5, text: `w${i}${i === 6 || i === 13 ? "." : ""}` }));
  const ps = segmentCues(p, 100);
  assert.deepEqual(bounds(ps), [[0, 35], [35, 70], [70, 100]]);
  assert.equal(ps[0].text, "w0 w1 w2 w3 w4 w5 w6.");
  // Unpunctuated words with a pause after word 29: the break falls in the pause.
  const u = Array.from({ length: 60 }, (_, i) => ({ start: i + (i >= 30 ? 2 : 0), end: i + (i >= 30 ? 2 : 0) + 1, text: "w" }));
  assert.deepEqual(bounds(segmentCues(u, 62)), [[0, 32], [32, 62]]);
  // No punctuation and no pause: 45 s pieces, and a tail under 10 s joins the one before.
  const flat = Array.from({ length: 98 }, (_, i) => ({ start: i, end: i + 1, text: "w" }));
  assert.deepEqual(bounds(segmentCues(flat, 98)), [[0, 45], [45, 98]]);
  // The video runs on after the last caption: the last segment reaches the end.
  assert.deepEqual(bounds(segmentCues([{ start: 3, end: 8, text: "Hi." }], 120)), [[0, 120]]);
  assert.deepEqual([clock(45), clock(723), clock(3723)], ["0:45", "12:03", "1:02:03"]);

  // Caption segments group into describe windows of at most 150 s.
  const segs = [0, 40, 80, 120, 160, 200, 240].map((t, i) => ({ id: `n0${i + 1}`, start: t, end: t + 40, text: "words" }));
  assert.deepEqual(windows(segs).map((w) => w.map((s) => s.id)), [["n01", "n02", "n03"], ["n04", "n05", "n06"], ["n07"]]);

  // Gemini route: window 0 is 0 to 60 s, then 180 s each.
  assert.deepEqual([winStart(0), winStart(1), winStart(2), winStart(5)], [0, 60, 240, 780]);
  assert.deepEqual([winOf(0), winOf(59.9), winOf(60), winOf(239), winOf(240), winOf(1000)], [0, 0, 1, 1, 2, 6]);
  // Model parts: out of order, out of range, a duplicate second, empty ones; code orders, clamps, merges and tiles them.
  const part = (start: number, said: string, shown = "", heading = "h") => ({ start, end: start + 30, said, shown, heading });
  const t = tile([part(95, "Second part."), part(50, "Before the window."), part(130, "Third", "A graph titled \"Cost\"."), part(130, "continues."), part(120, ""), part(400, "Past the end.")], 60, 240, 1);
  assert.deepEqual(t.map((o) => [o.seg.id, o.seg.order, o.seg.start, o.seg.end, o.seg.text]), [
    ["n0100", 100, 60, 95, "Before the window."],
    ["n0101", 101, 95, 130, "Second part."],
    // 110 s with two sentences: split, timed by character share (16 of 29 characters)
    ["n0102", 102, 130, 191, "Third continues."],
    ["n0103", 103, 191, 240, "Past the end."],
  ]);
  assert.equal(t[2].shown, 'A graph titled "Cost".');
  assert.equal(t[0].seg.heading, "1:00");
  assert.deepEqual(tile([part(10, ""), part(20, "  ")], 0, 60, 0), []); // an empty window ends the run
  const lens = (ps: { start: number; end: number }[]) => ps.map((p) => [p.start, p.end]);
  // Six parts of 10 s: merged to 40 s and 20 s (never past 45 s).
  const six = [0, 10, 20, 30, 40, 50].map((t) => ({ start: t, end: t + 10, said: `s${t}.`, heading: `h${t}`, shown: "" }));
  const merged = evenOut(six);
  assert.deepEqual(lens(merged), [[0, 40], [40, 60]]);
  assert.equal(merged[0].said, "s0. s10. s20. s30.");
  assert.equal(merged[0].heading, "h0");
  // One 180 s part of six equal sentences: about 35 s pieces at sentence ends, times by character share.
  const s30 = "This sentence is exactly forty characters.";
  const long = evenOut([{ start: 60, end: 240, said: Array(6).fill(s30).join(" "), heading: "h", shown: "A graph." }]);
  assert.deepEqual(lens(long), [[60, 90], [90, 120], [120, 150], [150, 180], [180, 210], [210, 240]]);
  assert.ok(long.every((p) => p.said === s30));
  assert.deepEqual([long[0].shown, long[1].shown, long[1].heading], ["A graph.", "", ""]);
  // A long part with one sentence cannot split; a short last part joins its neighbour if the sum fits.
  assert.deepEqual(lens(evenOut([{ start: 0, end: 50, said: "One long sentence", heading: "", shown: "" }, { start: 50, end: 55, said: "x.", heading: "", shown: "" }])), [[0, 50], [50, 55]]);
  assert.deepEqual(lens(evenOut([{ start: 0, end: 30, said: "a.", heading: "", shown: "" }, { start: 30, end: 38, said: "b.", heading: "", shown: "" }])), [[0, 38]]);
  assert.equal(cleanShown("The speaker, no slides."), "");
  assert.equal(cleanShown("  "), "");
  // Frames: the model's second kept inside the segment; unasked pictures capped, tourable kinds first, time order within.
  assert.deepEqual([frameAt({ start: 30, end: 60 }, 45.26), frameAt({ start: 30, end: 60 }, 90), frameAt({ start: 30, end: 60 }, undefined), frameAt({ start: 30, end: 31 }, 0)], [45.3, 59, 59, 31]);
  const vis = { n0003: { visual: "slide", at: 1 }, n0101: { visual: "chart", at: 2 }, n0002: { visual: "equation", at: 3 }, n0001: { visual: "diagram", at: 4 }, n0200: { visual: "table", at: 5 } };
  assert.deepEqual(pickFrames(vis, []), ["n0001", "n0101", "n0200", "n0002", "n0003"]);
  assert.deepEqual(pickFrames(vis, ["n0001"], 3), ["n0101", "n0200"]);
  assert.deepEqual(pickFrames(vis, ["a", "b", "c"], 3), []);
  assert.equal(cleanShown('Arrows point to "≈ 2π(0.1) dr" terms. Then more. And more.'), 'Arrows point to "≈ 2π(0.1) dr" terms. Then more.');
  assert.equal(cleanShown("No full stop here"), "No full stop here");
  assert.equal(cleanShown('A graph titled "Stock price". The line rises from July to August. Then it dips. More.'), 'A graph titled "Stock price". The line rises from July to August.');

  assert.ok(isKhanVideo("https://www.khanacademy.org/math/statistics-probability/displaying-describing-data/more-on-data-displays/v/u08-l1-t2-we2-reading-line-graphs"));
  assert.ok(!isKhanVideo("https://www.khanacademy.org/math/statistics-probability"));

}

async function restored() {
  // After a restart the job is only on disk: restore() brings it back, so a frame request finds the segment instead of "unknown".
  const VID = "arcCheck_01";
  await mkdir(".cache/video", { recursive: true });
  await writeFile(`.cache/video/job-${VID}.json`, JSON.stringify({ url: `https://www.youtube.com/watch?v=${VID}`, duration: 60, ended: null, source: "gemini", segs: [{ id: "n0000", kind: "segment", order: 0, level: 3, heading: "0:00", text: "As you can see here.", start: 0, end: 60 }], wins: ["done"], lite: { n0000: "" }, described: {}, headings: {}, pending: [], noFrames: "No pictures for this video." }));
  try {
    assert.equal(requestFrame(VID, "n0000"), "unknown");
    assert.equal(await restore(VID), true);
    assert.equal(requestFrame(VID, "n0000"), "No pictures for this video.");
    assert.equal(requestFrame(VID, "n9999"), "unknown");
    assert.equal(await restore("arcCheck_02"), false);
  } finally {
    await rm(`.cache/video/job-${VID}.json`, { force: true });
  }
}
