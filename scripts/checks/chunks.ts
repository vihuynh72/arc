// Run by scripts/selfcheck.ts: every chunk the reader sends to /api/speak is non-empty, within the limit, and nothing is dropped.
import assert from "node:assert";
import { MAX_CHUNK, shortFirst, splitSentences } from "../../lib/client/reader";

const norm = (s: string) => s.replace(/\s+/g, ""); // a mid-word cut (no space to cut at) is joined back with a space

export default function check() {
  const long = `In this study we propose ${"a robust, scalable and low-power sensing method for wearable devices ".repeat(13)}that works.`;
  const cases = [
    long, // one ~900-character sentence
    "word ".repeat(250).trim(), // no punctuation at all
    "Fig. 3 shows 2.5 mm of drift in the sensor. The error stays below 0.1% over e.g. ten runs, see Fig. 4 for details.",
    "",
    "Photosynthesis is a process used by plants to convert light into chemical energy. That energy is stored in sugars. It powers almost all life on Earth.",
    "x".repeat(700), // one 700-character token with no space
  ];
  assert(long.length > 850);
  for (const text of cases) {
    const chunks = splitSentences(text);
    for (const c of chunks) assert(c.trim().length > 0 && c.length <= MAX_CHUNK, `bad chunk (${c.length}): ${c.slice(0, 40)}`);
    assert.equal(norm(chunks.join(" ")), norm(text));
  }
  assert.deepEqual(splitSentences(""), []);
  assert.equal(splitSentences(cases[2]).length, 2); // "Fig." and "2.5" do not end a sentence

  // A block's first chunk is cut to about one clause; nothing is lost, and each chunk still names its sentence span.
  const lines = ["Photosynthesis is a multi-step process that requires specific wavelengths of visible sunlight, carbon dioxide (which is low in energy), and water as substrates (Figure 8.4).", "After the process is complete, it releases oxygen."];
  const s = shortFirst(lines);
  assert(s.lines[0].length <= 110 && s.lines[0].endsWith(","), s.lines[0]);
  assert.equal(norm(s.lines.join(" ")), norm(lines.join(" ")));
  assert.deepEqual(s.span, [0, 0, 1]);
  assert.deepEqual(shortFirst(["Short one.", "Two."]), { lines: ["Short one.", "Two."], span: [0, 1] });
  assert.deepEqual(shortFirst([]), { lines: [], span: [] });
}
