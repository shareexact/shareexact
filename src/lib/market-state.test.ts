import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDataState,
  formatAge,
  isShareConversionExecutable,
  type ClassifyInput,
} from "./market-state.ts";

const NOW = 1_800_000_000;
const WAD = 10n ** 18n;

function input(overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    sequencerOk: true,
    hasFeed: true,
    updatedAt: NOW - 60,
    price: 178.4,
    now: NOW,
    maxStaleness: 26 * 3600,
    oraclePaused: false,
    effectiveAt: null,
    multiplier: WAD,
    pendingMultiplier: WAD,
    corpActionWindow: 7200,
    ...overrides,
  };
}

test("fresh feed classifies as FRESH", () => {
  assert.equal(classifyDataState(input()), "FRESH");
});

test("unregistered feed classifies as NO_FEED", () => {
  assert.equal(classifyDataState(input({ hasFeed: false })), "NO_FEED");
});

test("unregistered token with a pending split is CORP_ACTION", () => {
  assert.equal(
    classifyDataState(
      input({ hasFeed: false, effectiveAt: NOW + 1800, pendingMultiplier: 4n * WAD }),
    ),
    "CORP_ACTION",
  );
});

test("weekend hold classifies as STALE", () => {
  // Friday close, read on Sunday: the feed answers, it just stopped moving.
  assert.equal(classifyDataState(input({ updatedAt: NOW - 50 * 3600 })), "STALE");
});

test("missing or non-positive answer classifies as STALE", () => {
  assert.equal(classifyDataState(input({ price: null })), "STALE");
  assert.equal(classifyDataState(input({ price: 0 })), "STALE");
  assert.equal(classifyDataState(input({ updatedAt: null })), "STALE");
});

test("oracle pause is reported when the price is otherwise fresh", () => {
  assert.equal(classifyDataState(input({ oraclePaused: true })), "ORACLE_PAUSED");
});

test("staleness outranks the advisory pause flag", () => {
  const state = classifyDataState(input({ oraclePaused: true, updatedAt: NOW - 50 * 3600 }));
  assert.equal(state, "STALE");
});

test("sequencer down outranks everything", () => {
  const state = classifyDataState(
    input({ sequencerOk: false, hasFeed: false, price: null, oraclePaused: true }),
  );
  assert.equal(state, "SEQUENCER_DOWN");
});

test("imminent multiplier change classifies as CORP_ACTION", () => {
  const state = classifyDataState(
    input({ effectiveAt: NOW + 1800, pendingMultiplier: 4n * WAD }),
  );
  assert.equal(state, "CORP_ACTION");
});

test("multiplier change outside the window stays FRESH", () => {
  const state = classifyDataState(
    input({ effectiveAt: NOW + 5 * 86_400, pendingMultiplier: 4n * WAD }),
  );
  assert.equal(state, "FRESH");
});

test("scheduled no-op is not a corporate action", () => {
  const state = classifyDataState(input({ effectiveAt: NOW + 600, pendingMultiplier: WAD }));
  assert.equal(state, "FRESH");
});

test("already-applied multiplier change is not pending", () => {
  const state = classifyDataState(
    input({ effectiveAt: NOW - 600, pendingMultiplier: 4n * WAD }),
  );
  assert.equal(state, "FRESH");
});

test("transfers survive a stale price but not a pending corporate action", () => {
  // The deliberate asymmetry: a transfer needs the multiplier, not the price.
  assert.equal(isShareConversionExecutable("STALE"), true);
  assert.equal(isShareConversionExecutable("ORACLE_PAUSED"), true);
  assert.equal(isShareConversionExecutable("CORP_ACTION"), false);
  assert.equal(isShareConversionExecutable("SEQUENCER_DOWN"), false);
});

test("a feed timestamp in the future is stale, not maximally fresh", () => {
  assert.equal(classifyDataState(input({ updatedAt: NOW + 3600 })), "STALE");
});

test("age formatting is readable at every scale", () => {
  assert.equal(formatAge(30), "30s ago");
  assert.equal(formatAge(600), "10m ago");
  assert.equal(formatAge(7200), "2h ago");
  assert.equal(formatAge(50 * 3600), "2.1d ago");
  assert.equal(formatAge(null), "—");
});

test("an unreadable multiplier is a unit failure, not a corporate action", () => {
  // No scheduled time: a null pending value is not, by itself, a corporate action.
  const state = classifyDataState(
    input({ multiplier: 0n, pendingMultiplier: null, effectiveAt: null }),
  );
  assert.equal(state, "FRESH");
});

test("an unreadable pending multiplier with a future effectiveAt fails closed", () => {
  // ShareExactGuard._corpActionImminent returns true before the window check
  // when newUIMultiplier() cannot be read and effectiveAt is still in the future.
  assert.equal(
    classifyDataState(input({ effectiveAt: NOW + 1800, pendingMultiplier: null })),
    "CORP_ACTION",
  );
  assert.equal(
    classifyDataState(input({ effectiveAt: NOW + 5 * 86_400, pendingMultiplier: null })),
    "CORP_ACTION",
  );
  assert.equal(
    classifyDataState(
      input({ hasFeed: false, effectiveAt: NOW + 1800, pendingMultiplier: null }),
    ),
    "CORP_ACTION",
  );
  // A readable pending against an unreadable current is not imminent (`!okCur`).
  assert.equal(
    classifyDataState(
      input({ multiplier: 0n, pendingMultiplier: 4n * WAD, effectiveAt: NOW + 1800 }),
    ),
    "FRESH",
  );
});
