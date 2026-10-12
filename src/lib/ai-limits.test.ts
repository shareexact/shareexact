import assert from "node:assert/strict";
import test from "node:test";
import { AI_LIMITS, RateLimitError, consumeQuota, resetQuota } from "./ai-limits.ts";

test("a caller within budget is allowed through", () => {
  resetQuota();
  for (let i = 0; i < 12; i++) consumeQuota("user:alice");
  assert.ok(true);
});

test("a caller over budget is rejected with a retry hint", () => {
  resetQuota();
  for (let i = 0; i < 12; i++) consumeQuota("user:bob");
  assert.throws(() => consumeQuota("user:bob"), RateLimitError);
  try {
    consumeQuota("user:bob");
  } catch (err) {
    assert.ok(err instanceof RateLimitError);
    assert.ok(err.retryAfterSeconds > 0 && err.retryAfterSeconds <= 60);
  }
});

test("budgets are per caller, not global", () => {
  resetQuota();
  for (let i = 0; i < 12; i++) consumeQuota("user:carol");
  assert.throws(() => consumeQuota("user:carol"), RateLimitError);
  consumeQuota("user:dave");
  assert.ok(true);
});

test("input ceilings are small enough to bound a prompt", () => {
  // These bound what reaches a paid model API, so they are asserted rather than
  // left as constants someone can quietly raise.
  assert.ok(AI_LIMITS.thesis <= 2_000);
  assert.ok(AI_LIMITS.about <= 4_000);
  assert.ok(AI_LIMITS.holdings <= 100);
  assert.ok(AI_LIMITS.symbols <= 200);
});
