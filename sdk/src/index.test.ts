import assert from "node:assert/strict";
import test from "node:test";
import {
  SELECTORS,
  classifyDataState,
  isShareConversionExecutable,
  readStockToken,
  type CallFn,
  type DataState,
} from "./index.ts";

const NOW = 1_800_000_000;
const WAD = 10n ** 18n;

function word(n: bigint) {
  return n.toString(16).padStart(64, "0");
}

function classify(overrides: Partial<Parameters<typeof classifyDataState>[0]> = {}): DataState {
  return classifyDataState({
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
  });
}

test("SDK classifier matches the contract cases", () => {
  assert.equal(classify(), "FRESH");
  assert.equal(classify({ hasFeed: false }), "NO_FEED");
  assert.equal(classify({ updatedAt: NOW - 50 * 3600 }), "STALE");
  assert.equal(classify({ price: null }), "STALE");
  assert.equal(classify({ oraclePaused: true }), "ORACLE_PAUSED");
  assert.equal(classify({ oraclePaused: true, updatedAt: NOW - 50 * 3600 }), "STALE");
  assert.equal(classify({ sequencerOk: false, hasFeed: false }), "SEQUENCER_DOWN");
  assert.equal(classify({ effectiveAt: NOW + 1800, pendingMultiplier: 4n * WAD }), "CORP_ACTION");
  assert.equal(classify({ effectiveAt: NOW + 5 * 86_400, pendingMultiplier: 4n * WAD }), "FRESH");
  assert.equal(classify({ effectiveAt: NOW + 600, pendingMultiplier: WAD }), "FRESH");
  assert.equal(classify({ effectiveAt: NOW - 600, pendingMultiplier: 4n * WAD }), "FRESH");
  assert.equal(
    classify({ hasFeed: false, effectiveAt: NOW + 1800, pendingMultiplier: 4n * WAD }),
    "CORP_ACTION",
  );
  assert.equal(classify({ effectiveAt: NOW + 1800, pendingMultiplier: null }), "CORP_ACTION");
  assert.equal(classify({ effectiveAt: NOW + 5 * 86_400, pendingMultiplier: null }), "CORP_ACTION");
  assert.equal(
    classify({ multiplier: 0n, pendingMultiplier: 4n * WAD, effectiveAt: NOW + 1800 }),
    "FRESH",
  );
});

test("a feed timestamp in the future is stale, not maximally fresh", () => {
  assert.equal(classify({ updatedAt: NOW + 3600 }), "STALE");
});

test("share conversion survives STALE and is blocked by CORP_ACTION", () => {
  assert.equal(isShareConversionExecutable("STALE"), true);
  assert.equal(isShareConversionExecutable("CORP_ACTION"), false);
  assert.equal(isShareConversionExecutable("SEQUENCER_DOWN"), false);
});

function mockCall(map: Record<string, string | null>): CallFn {
  return async (to, data) => {
    const key = `${to.toLowerCase()}:${data.slice(0, 10)}`;
    if (key in map) return map[key];
    if (data.slice(0, 10) in map) return map[data.slice(0, 10)];
    return null;
  };
}

const TOKEN = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const FEED = "0x1111111111111111111111111111111111111111";

function roundBlob(answer: bigint, updatedAt: bigint) {
  return `0x${word(1n)}${word(answer)}${word(0n)}${word(updatedAt)}${word(1n)}`;
}

test("unread multiplier with a dangling pending is not CORP_ACTION", async () => {
  const call = mockCall({
    [SELECTORS.uiMultiplier]: null,
    [SELECTORS.newUIMultiplier]: `0x${word(4n * WAD)}`,
    [SELECTORS.effectiveAt]: `0x${word(BigInt(NOW + 1800))}`,
    [SELECTORS.oraclePaused]: `0x${word(0n)}`,
    [SELECTORS.latestRoundData]: roundBlob(178_40_000_000n, BigInt(NOW - 60)),
  });
  const state = await readStockToken(call, TOKEN, {
    feed: FEED,
    now: NOW,
    maxStaleness: 26 * 3600,
    corpActionWindow: 7200,
  });
  assert.equal(state.multiplier, 0n);
  assert.equal(state.dataState, "FRESH");
});

test("unread pending multiplier with a future effectiveAt is CORP_ACTION", async () => {
  const call = mockCall({
    [SELECTORS.uiMultiplier]: `0x${word(WAD)}`,
    [SELECTORS.newUIMultiplier]: null,
    [SELECTORS.effectiveAt]: `0x${word(BigInt(NOW + 5 * 86_400))}`,
    [SELECTORS.oraclePaused]: `0x${word(0n)}`,
    [SELECTORS.latestRoundData]: roundBlob(178_40_000_000n, BigInt(NOW - 60)),
  });
  const state = await readStockToken(call, TOKEN, {
    feed: FEED,
    now: NOW,
    maxStaleness: 26 * 3600,
    corpActionWindow: 7200,
  });
  assert.equal(state.multiplier, WAD);
  assert.equal(state.pendingMultiplier, null);
  assert.equal(state.dataState, "CORP_ACTION");
});

test("a dirty paused word is unreadable, not paused", async () => {
  const call = mockCall({
    [SELECTORS.uiMultiplier]: `0x${word(WAD)}`,
    [SELECTORS.newUIMultiplier]: `0x${word(WAD)}`,
    [SELECTORS.effectiveAt]: `0x${word(0n)}`,
    [SELECTORS.oraclePaused]: `0x${word(2n)}`,
    [SELECTORS.latestRoundData]: roundBlob(178_40_000_000n, BigInt(NOW - 60)),
  });
  const state = await readStockToken(call, TOKEN, {
    feed: FEED,
    now: NOW,
  });
  assert.equal(state.oraclePaused, false);
  assert.equal(state.dataState, "FRESH");
});

test("future feed timestamp classifies as STALE through readStockToken", async () => {
  const call = mockCall({
    [SELECTORS.uiMultiplier]: `0x${word(WAD)}`,
    [SELECTORS.newUIMultiplier]: `0x${word(WAD)}`,
    [SELECTORS.effectiveAt]: `0x${word(0n)}`,
    [SELECTORS.oraclePaused]: `0x${word(0n)}`,
    [SELECTORS.latestRoundData]: roundBlob(178_40_000_000n, BigInt(NOW + 3600)),
  });
  const state = await readStockToken(call, TOKEN, { feed: FEED, now: NOW });
  assert.equal(state.dataState, "STALE");
});
