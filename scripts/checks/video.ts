// Offline: YouTube link forms, the canonical address, coverage notes, the "Possibly:" prefix and plain error sentences.
import assert from "node:assert";
import { youtubeCanonical, youtubeId } from "../../lib/server/oembed";
import { coverageGaps, gapText, plainVideoError, shownText } from "../../lib/server/video";

export default function check() {
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

  const seg = (start: number, end: number) => ({ start, end });
  assert.deepEqual(coverageGaps([seg(0, 30), seg(30, 60), seg(60, 100)], 110), []);
  assert.deepEqual(coverageGaps([seg(40, 80), seg(80, 200), seg(260, 300)], 330), [seg(0, 40), seg(200, 260)]);
  assert.deepEqual(coverageGaps([seg(20, 60)], 100), [seg(60, 100)]);
  assert.equal(gapText(seg(0, 40)), "No outline for 0:00 to 0:40.");
  assert.equal(gapText(seg(200, 265)), "No outline for 3:20 to 4:25.");

  assert.equal(shownText({ shown: 'Slide "Prerequisites".', shown_confidence: "high" }), 'Slide "Prerequisites".');
  assert.equal(shownText({ shown: "A curve falling to the right.", shown_confidence: "low" }), "Possibly: A curve falling to the right.");
  assert.equal(shownText({ shown: "Unclear on screen.", shown_confidence: "low" }), "Unclear on screen.");

  const raw = [
    plainVideoError(new Error('Gemini HTTP 403: { "error": { "code": 403, "status": "PERMISSION_DENIED" } }')),
    plainVideoError(new Error("Gemini HTTP 400: Unsupported MIME type: text/html")),
    plainVideoError(new Error("no model answered (gemini-4-hydrogen, gemini-3.5-flash-lite)")),
  ];
  assert.deepEqual(raw, [
    "I could not open that video. It may be private or removed.",
    "I could not open that video. It may be private or removed.",
    "I could not outline that video just now. Try again in a minute.",
  ]);
  assert.match(plainVideoError(new Error("Gemini HTTP 403: embedding disabled by the owner")), /restricted access/);
}
