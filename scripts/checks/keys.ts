// Run by scripts/selfcheck.ts: the reading keys (lib/keys.ts) do not clash with Space, slash, backquote and Tab, unknown characters
// get an answer, a figure is described once, and section numbers match what the student can ask for.
import assert from "node:assert";
import { autoStep, figureLines, keyAct, rateLine, sectionName, sectionNo, speedKey } from "../../lib/keys";

export default function check() {
  const k = (key: string, shiftKey = false, video = false) => keyAct({ key, shiftKey }, video);
  assert.deepEqual(k("h"), { act: "jump", what: "heading", by: 1 });
  assert.deepEqual(k("H", true), { act: "jump", what: "heading", by: -1 });
  assert.deepEqual(k("f"), { act: "jump", what: "figure", by: 1 });
  assert.deepEqual(k("T", true), { act: "jump", what: "table", by: -1 });
  assert.deepEqual(k("e"), { act: "jump", what: "equation", by: 1 });
  assert.deepEqual(k("2"), { act: "level", level: 2 });
  assert.deepEqual(k("?", true), { act: "help" });
  assert.deepEqual(k("ArrowDown", true), { act: "nextSection" });
  assert.deepEqual(k("ArrowRight"), { act: "next" });
  for (const owned of [" ", "/", "`", "Tab", "Shift", "F5", "PageDown"]) assert.equal(k(owned), null, `${owned} belongs to someone else`);
  assert.deepEqual(k("q"), { act: "unknown" });
  assert.deepEqual(k("p"), { act: "unknown" }, "P does nothing on an article");
  assert.deepEqual(k("p", false, true), { act: "play" }, "P plays a video");
  assert.deepEqual(k("V", true, true), { act: "mode" });
  for (const media of ["j", "J", "k", "l", "<", ">"]) {
    assert.equal(k(media, false, true), null, `${media} is a media key on a video: no "does nothing" line`);
    assert.deepEqual(k(media), media === "<" || media === ">" || /[jkl]/i.test(media) ? { act: "unknown" } : null, `${media} on an article is unknown`);
  }
  assert.deepEqual(k("r"), { act: "again" });
  assert.deepEqual(k("5"), { act: "unknown" });
  assert.deepEqual(k("+"), { act: "faster" });

  // Web figure: the caption is the alt. Said once in full, then label and first sentence.
  const web = { heading: "Figure 1", text: "System architecture (left). The right shows the diagram.", image: { url: "x", alt: "System architecture (left). The right shows the diagram." } };
  assert.deepEqual(figureLines(web, true), ["Figure 1", "System architecture (left). The right shows the diagram."]);
  assert.deepEqual(figureLines(web, false), ["Figure 1", "System architecture (left)."]);
  // PDF figure: Arc's description is the text; the alt adds the paper's caption after it.
  const pdf = { heading: "Figure 1", text: "A block diagram of the encoder.", image: { url: "x", alt: "A block diagram of the encoder. The Transformer - model architecture." } };
  assert.deepEqual(figureLines(pdf, true), ["Figure 1", "A block diagram of the encoder.", "Caption: The Transformer - model architecture."]);
  // A caption that repeats its own label is not read twice.
  assert.deepEqual(figureLines({ heading: "Figure 2", text: "Figure 2: Loss curves.", image: { url: "x", alt: null } }, true), ["Figure 2", "Loss curves."]);

  const heads = [{ heading: "Abstract" }, { heading: "1. Introduction" }, { heading: "2. Methods" }, { heading: "2.1. Hardware" }, { heading: "3. Results" }];
  assert.deepEqual(sectionNo(heads, 3), { no: "2.1", of: 3, name: "Hardware" });
  assert.deepEqual(sectionNo(heads, 0), { no: "", of: 3, name: "Abstract" }, "unnumbered on a numbered page: no made-up number");
  assert.deepEqual(sectionNo([{ heading: "Overview" }, { heading: "Methods" }], 1), { no: "2", of: 2, name: "Methods" }, "unnumbered page: its place");
  assert.equal(sectionName("Page 4"), "");
  assert.equal(sectionName("3.2 Attention"), "3.2 Attention");
  assert.equal(rateLine("slower", 1.2), "Slower. Speed 1.2, on a scale from 1 to 2.");
  assert.match(rateLine("faster", 2), /fastest/);
  // The speed keys: Command with the arrows on a Mac, Control elsewhere; nothing else held, no other key.
  assert.equal(speedKey({ key: "ArrowRight", metaKey: true }, true), "faster");
  assert.equal(speedKey({ key: "ArrowLeft", metaKey: true }, true), "slower");
  assert.equal(speedKey({ key: "ArrowRight", ctrlKey: true }, true), null, "Control on a Mac is not the speed key");
  assert.equal(speedKey({ key: "ArrowLeft", ctrlKey: true }, false), "slower");
  assert.equal(speedKey({ key: "ArrowRight", metaKey: true }, false), null);
  assert.equal(speedKey({ key: "ArrowRight", metaKey: true, shiftKey: true }, true), null, "Shift+Command+Right selects text");
  assert.equal(speedKey({ key: "ArrowDown", metaKey: true }, true), null);
  assert.equal(speedKey({ key: "ArrowRight" }, true), null);
  // The self-running tour: after the introduction the first stop, then each next one, then the end line; nothing while paused or taken over.
  assert.equal(autoStep("on", -1, 6), "next");
  assert.equal(autoStep("on", 4, 6), "next");
  assert.equal(autoStep("on", 5, 6), "end");
  assert.equal(autoStep("paused", 2, 6), "wait");
  assert.equal(autoStep("off", 2, 6), "wait");
  assert.equal(autoStep("on", -1, 0), "end");
}
