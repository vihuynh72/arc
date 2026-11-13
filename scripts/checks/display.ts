import assert from "node:assert";
import { applyCommand, DISPLAY_COMMANDS } from "../../lib/client/display";

export default function check() {
  for (const c of Object.keys(DISPLAY_COMMANDS)) assert.ok(applyCommand({}, c), `no handler for ${c}`);
  assert.deepEqual(applyCommand({}, "bigger"), [{ text: "125" }, "Text size 125 percent."]);
  assert.equal(applyCommand({ text: "200" }, "bigger")?.[0].text, "200");
  assert.equal(applyCommand({}, "smaller")?.[0].text, "100");
  assert.deepEqual(applyCommand({ text: "150", theme: "cream" }, "low-glare"), [{ text: "150", theme: "low-glare" }, "Low glare dark."]);
  assert.deepEqual(applyCommand({ text: "150" }, "dyslexia")?.[0], { theme: "cream", spacing: "wide", font: "legible", profile: "dyslexia" });
  assert.deepEqual(applyCommand({ text: "150" }, "reset"), [{}, "Display reset."]);
  assert.equal(applyCommand({}, "nonsense"), null);
}
