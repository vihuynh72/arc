// Offline: price arithmetic, the degradation order, the empty-balance test, token buckets (time injected) and the client address.
import assert from "node:assert";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { LIVE_VOICE } from "../../lib/models";
import * as B from "../../lib/server/budget";
import { Buckets, classify, clientIp } from "../../lib/server/limits";
import { MODEL_PRICES, NAMED_MODELS, UNKNOWN_MODEL, callCost, isHeavy } from "../../lib/server/prices";

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

export default function check() {
  // prices: every model Arc names has a price; arithmetic per 1M tokens, thinking billed as output, audio at its own rate
  for (const m of NAMED_MODELS) assert.ok(MODEL_PRICES[m], `no price for ${m}`);
  near(callCost("gemini-3.5-flash-lite", { input: 1e6, output: 0, thinking: 0 }), 0.3);
  near(callCost("gemini-3.5-flash-lite", { input: 0, output: 1e5, thinking: 1e5 }), 0.5);
  near(callCost("gemini-3.8-live", { input: 1e6, output: 1e6, thinking: 0, audioIn: 5e5, audioOut: 1e6 }), 0.5 * 0.75 + 0.5 * 3 + 12);
  near(callCost("no-such-model", { input: 1e6, output: 0, thinking: 0 }), UNKNOWN_MODEL.input);
  assert.ok(isHeavy("gemini-4-hydrogen") && !isHeavy("gemini-3.5-flash-lite"));

  // degradation order: normal, lean (extras off), asked only (background off), cap (refused); an empty balance is the cap
  assert.deepEqual([0, 0.49, 0.5, 0.79, 0.8, 0.99, 1, 5].map((s) => B.levelFor(s, 1)), [0, 0, 1, 1, 2, 2, 3, 3]);
  assert.equal(B.levelFor(0, 1, true), 3);
  B.resetForTest(0);
  assert.ok(B.allowExtras() && B.allowBackground());
  B.checkModel("x");
  const budget = B.dailyBudget();
  B.resetForTest(budget * 0.6);
  assert.ok(!B.allowExtras() && B.allowBackground());
  assert.equal(B.levelLine(), B.LEVEL_LINES[1]);
  B.resetForTest(budget * 0.85);
  assert.ok(!B.allowExtras() && !B.allowBackground());
  B.checkModel("question"); // asked work still runs at level 2
  B.resetForTest(budget);
  assert.throws(() => B.checkModel("question"), (e: unknown) => B.isBudgetError(e) && (e as B.BudgetError).say === B.CAP_LINE);
  assert.equal(B.report().refused.question, 1);

  // an empty balance: 402, or a 429/403 that names credit or billing; a plain per-minute 429 is not one
  assert.ok(B.saysDepleted(402, ""));
  assert.ok(B.saysDepleted(429, '{"error":{"status":"RESOURCE_EXHAUSTED","message":"Your prepayment credits are depleted."}}'));
  assert.ok(!B.saysDepleted(429, '{"error":{"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded for metric requests per minute"}}'));
  assert.ok(!B.saysDepleted(429, "Service is unavailable due to load balancing")); // a real Live close reason shape: not money
  // Google's ordinary rate-limit answer (seen on the hosted copy): it names "billing" and is not an empty balance.
  assert.ok(!B.saysDepleted(429, '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.","status":"RESOURCE_EXHAUSTED"}}'));
  assert.ok(B.saysDepleted(403, "This API method requires billing to be enabled. Please enable billing on project #1."));
  assert.ok(B.saysDepleted(429, "Your project is temporarily rate-limited to prevent exceeding its monthly spending cap."));
  assert.ok(B.saysDepleted(429, "Your project has exceeded its spending cap."));
  B.resetForTest(0);
  B.noteGeminiFailure(402, "credits are depleted");
  assert.throws(() => B.checkModel("tour"), (e: unknown) => (e as B.BudgetError).code === "depleted");
  B.resetForTest(0);

  // token buckets with time injected: a burst of `cap`, then refill at perMin
  const b = new Buckets(3, 60); // one a second
  const t = 1_000_000;
  assert.deepEqual([b.take("a", t), b.take("a", t), b.take("a", t)], [0, 0, 0]);
  assert.equal(b.take("a", t), 1);
  assert.equal(b.take("b", t), 0); // another visitor has their own
  assert.equal(b.take("a", t + 999), 1);
  assert.equal(b.take("a", t + 1000), 0);
  assert.equal(new Buckets(5, 0.2).take("u", t) + 0, 0);
  const slow = new Buckets(1, 0.2);
  slow.take("u", t);
  assert.equal(slow.take("u", t), 300); // one per five minutes

  // client address: the proxy's own (last) entry; anything the visitor wrote to the left is ignored
  assert.equal(clientIp("1.2.3.4", "10.0.0.9", 1), "1.2.3.4");
  assert.equal(clientIp("6.6.6.6, 1.2.3.4", "10.0.0.9", 1), "1.2.3.4");
  assert.equal(clientIp(["6.6.6.6", "7.7.7.7, 1.2.3.4"], "10.0.0.9", 1), "1.2.3.4");
  assert.equal(clientIp("6.6.6.6", "::ffff:127.0.0.1", 0), "127.0.0.1"); // no proxy: the header is never trusted
  assert.equal(clientIp(undefined, "10.0.0.9", 1), "10.0.0.9");

  // the recorded lines live.ts plays when the money is gone (regenerate when a line or the voice changes)
  for (const line of [B.CAP_LINE, B.DEPLETED_LINE, B.VISITOR_LINE]) assert.ok(existsSync(`lib/server/voice-lines/${createHash("sha1").update(LIVE_VOICE + line).digest("hex")}.pcm`), `no recording of: ${line}`);

  // one visitor's share of the voice
  B.addVoiceSeconds("v1", B.voiceMinutesPerVisitor() * 60 - 1);
  B.checkVisitor("v1");
  B.addVoiceSeconds("v1", 1);
  assert.throws(() => B.checkVisitor("v1"), (e: unknown) => (e as B.BudgetError).code === "visitor");
  B.checkVisitor("v2");

  // route classes
  assert.equal(classify("POST", "/api/load"), "page");
  assert.equal(classify("POST", "/api/decide"), "model");
  assert.equal(classify("GET", "/api/decide"), "api");
  assert.equal(classify("GET", "/api/tour"), "model");
  assert.equal(classify("GET", "/api/tour/status"), "api");
  assert.equal(classify("POST", "/api/video/shown"), "model");
  assert.equal(classify("GET", "/api/video/shown"), "api");
  assert.equal(classify("POST", "/api/pdf/upload"), "upload");
  assert.equal(classify("GET", "/api/speak"), "speak");
  assert.equal(classify("POST", "/api/speak"), "speak"); // the app asks by POST (text in the body, never the URL)
  assert.equal(classify("GET", "/_next/static/x.js"), "web");
}
