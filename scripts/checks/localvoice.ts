import assert from "node:assert";
import { LIMITS, after, english, fits, mayLoad, patience, pick, seconds, tooSlow, type State } from "../../lib/client/localVoice";

const ready: State = { status: "ready", rtf: 0.1, misses: 0 };
const en = [{ text: "Photosynthesis makes sugar." }, { text: "It needs light." }];

export default function check() {
  // when local: ready, fast enough at this speed, every chunk English (the server's English Kokoro rule)
  assert.equal(pick(ready, en, 1.25), "local");
  assert.equal(pick(ready, [{ text: "Hola.", lang: "es" }], 1), "server");
  assert.equal(pick(ready, [...en, { text: "Фотосинтез превращает энергию света в сахар." }], 1), "server", "one chunk in another script: the whole block goes to the server");
  assert.equal(pick(ready, [{ text: "Hello.", lang: "en-GB" }], 1), "local");
  assert.equal(pick(ready, [], 1), "server");
  for (const status of ["off", "idle", "loading"] as const) assert.equal(pick({ ...ready, status }, en, 1), "server");
  // fast enough: every clip of the block made in time for gapless playback, at this speed, serially
  const long = "x".repeat(300); // about 22 s of audio
  assert.equal(pick({ ...ready, rtf: 0.15 }, [{ text: "Figure 8.3" }, { text: long }], 1.25), "server", "a short heading cannot hide a long caption's making");
  assert.equal(pick({ ...ready, rtf: 0.15 }, [{ text: "Figure 8.3" }, { text: long }], 1.25, (t) => t === long), "local", "unless it is already made");
  const para = ["x".repeat(60), "x".repeat(200), "x".repeat(200), "x".repeat(200)];
  assert.ok(fits(para, 0.15, 2) && !fits(para, 0.4, 1), "rtf 0.4 cannot keep up");
  assert.ok(fits(para, 0.2, 1.25) && !fits(para, 0.2, 2), "double speed needs twice the margin");
  assert.ok(!fits(["x".repeat(300)], 0.5, 1), "the first clip must come within firstMs");
  assert.ok(Math.abs(seconds("x".repeat(113)) - 8.3) < 0.5);
  assert.equal(pick({ ...ready, misses: LIMITS.misses }, en, 1), "server");
  assert.ok(english({ text: "x²" }) && !english({ text: "光合成は、光のエネルギーを使って糖を作る仕組みです。" }));

  // when to give up: a late clip is a miss; enough misses end it for the session; a clip slower than real time ends it at once
  assert.equal(patience(0), LIMITS.firstMs);
  assert.equal(patience(3), LIMITS.hardMs);
  assert.deepEqual(after(ready, 100, 1, true), ready);
  assert.equal(after(ready, LIMITS.gapMs + 1, 1, true).misses, 1);
  assert.equal(after(ready, 800, 0, true).misses, 0, "the first clip of a block may take longer");
  assert.equal(after(ready, 50, 2, false).misses, 1, "no clip (timeout or error) is a miss");
  let s = ready;
  for (let k = 0; k < LIMITS.misses; k++) s = after(s, 5000, 1, false);
  assert.equal(s.status, "off");
  assert.ok(tooSlow({ ms: 4100, seconds: 2 }) && !tooSlow({ ms: 400, seconds: 2 }));

  // when to download: allowed, after a key or click, not on save-data or 2G
  assert.ok(mayLoad({ allowed: true, gesture: true }));
  assert.ok(!mayLoad({ allowed: true, gesture: false }));
  assert.ok(!mayLoad({ allowed: false, gesture: true }));
  assert.ok(!mayLoad({ allowed: true, gesture: true, saveData: true }));
  assert.ok(!mayLoad({ allowed: true, gesture: true, effectiveType: "2g" }));
  assert.ok(mayLoad({ allowed: true, gesture: true, effectiveType: "4g" }));
}
