import assert from "node:assert";
import { ACTION_MIN, TARGET_MIN, cleanQuery, shouldAct } from "../../lib/server/decide";

export default function check() {
  assert.equal(shouldAct("next", 0.9, null, 0), true);
  assert.equal(shouldAct("next", ACTION_MIN - 0.01, null, 0), false);
  assert.equal(shouldAct("stop", ACTION_MIN, null, 0), true);
  assert.equal(shouldAct("search", 0.8, null, 0), true);
  assert.equal(shouldAct("question", 0.99, null, 0), false);
  assert.equal(shouldAct("none", 0.99, null, 0), false);
  assert.equal(shouldAct("goto", 0.9, "n03", TARGET_MIN), true);
  assert.equal(shouldAct("goto", 0.9, "n03", TARGET_MIN - 0.01), false);
  assert.equal(shouldAct("goto", 0.9, null, 0.9), false);
  assert.equal(shouldAct("goto", 0.9, "none", 0.9), false);
  assert.equal(shouldAct("tour", 0.9, "n05", 0.9), true);
  assert.equal(shouldAct("tour", 0.5, "n05", 0.9), false);

  assert.equal(cleanQuery("  Um, please take me to the results. ", "goto"), "take me to the results");
  assert.equal(cleanQuery("hey arc, can you stop", "stop"), "stop");
  assert.equal(cleanQuery("find me a paper about knee rehabilitation", "search"), "knee rehabilitation");
  assert.equal(cleanQuery("Search for knee rehab", "search"), "knee rehab");
  assert.equal(cleanQuery("look up wearable sensors", "search"), "wearable sensors");
  assert.equal(cleanQuery("find me a paper about knee rehabilitation", "goto"), "find me a paper about knee rehabilitation");
  assert.equal(cleanQuery("what does the belt unit contain?", "question"), "what does the belt unit contain");
}
