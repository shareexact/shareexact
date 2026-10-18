import assert from "node:assert/strict";
import test from "node:test";
import {
  SELECTORS,
  classifyDataState,
  isShareConversionExecutable,
  readStockToken,
  unitChangeImminent,
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

test("STALE does not mean the unit is stable", () => {
  const weekend = {
    sequencerOk: true,
    hasFeed: true,
    updatedAt: NOW - 50 * 3600,
    price: 178.4,
    now: NOW,
    maxStaleness: 26 * 3600,
    oraclePaused: false,
    effectiveAt: null as number | null,
    multiplier: WAD,
    pendingMultiplier: WAD,
    corpActionWindow: 7200,
  };
  assert.equal(classify(weekend), "STALE");
  assert.equal(unitChangeImminent(weekend), false);
  assert.equal(
    isShareConversionExecutable({ dataState: "STALE", unitChangeImminent: false, multiplier: WAD }),
    true,
  );

  const staleSplit = {
    ...weekend,
    effectiveAt: NOW + 1800,
    pendingMultiplier: 4n * WAD,
  };
  assert.equal(classify(staleSplit), "STALE");
  assert.equal(unitChangeImminent(staleSplit), true);
  assert.equal(
    isShareConversionExecutable({ dataState: "STALE", unitChangeImminent: true, multiplier: WAD }),
    false,
  );
  assert.equal(isShareConversionExecutable({ dataState: "CORP_ACTION", unitChangeImminent: true, multiplier: WAD }), false);
  assert.equal(
    isShareConversionExecutable({ dataState: "SEQUENCER_DOWN", unitChangeImminent: false, multiplier: WAD }),
    false,
  );
  assert.equal(
    isShareConversionExecutable({ dataState: "ORACLE_PAUSED", unitChangeImminent: true, multiplier: WAD }),
    false,
  );
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

test("a token whose ratio cannot be read is not executable, whatever the label says", () => {
  // `multiplier: 0n` is "uiMultiplier() could not be read". The contract refuses
  // such a token outright — `transferShares` reverts with `UnitUnavailable` —
  // so the predicate that exists to predict the contract has to refuse too.
  // Before this, FRESH with nothing pending and an unreadable ratio returned
  // true, which is the one answer that gets a caller to sign.
  for (const dataState of ["FRESH", "STALE", "ORACLE_PAUSED", "NO_FEED"] as const) {
    assert.equal(
      isShareConversionExecutable({ dataState, unitChangeImminent: false, multiplier: 0n }),
      false,
      `${dataState} with an unreadable ratio must not be executable`,
    );
  }
  assert.equal(
    isShareConversionExecutable({ dataState: "FRESH", unitChangeImminent: false, multiplier: WAD }),
    true,
  );
});

test("omitting the ratio refuses rather than passes", () => {
  // TypeScript requires the field; JavaScript does not. An integration written
  // against the older two-field shape must fail closed instead of keeping the
  // bug it was written around.
  const legacy = { dataState: "FRESH", unitChangeImminent: false } as unknown as Parameters<
    typeof isShareConversionExecutable
  >[0];
  assert.equal(isShareConversionExecutable(legacy), false);
});

/*//////////////////////////////////////////////////////////////
                    ARGUMENTS ARE NOT TRUSTED
//////////////////////////////////////////////////////////////*/

test("a non-finite duration is refused instead of silently disabling the check", async () => {
  // This is the whole point: `now - updatedAt > NaN` is false, so a feed that
  // has not published in a week would have come back FRESH, with no error and
  // nothing in the logs. The library would have been confidently wrong about
  // the one thing it exists to be right about.
  const call = mockCall({});
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    await assert.rejects(
      () => readStockToken(call, TOKEN, { maxStaleness: bad }),
      /maxStaleness/,
      `maxStaleness ${bad} must be refused`,
    );
    await assert.rejects(
      () => readStockToken(call, TOKEN, { corpActionWindow: bad }),
      /corpActionWindow/,
      `corpActionWindow ${bad} must be refused`,
    );
    await assert.rejects(() => readStockToken(call, TOKEN, { now: bad }), /now/);
  }
  await assert.rejects(
    () => readStockToken(call, TOKEN, { maxStaleness: "3600" as unknown as number }),
    /maxStaleness/,
  );
});

test("arguments are checked before any call is made", async () => {
  // A bad argument must not cost an RPC round trip, and must not half-read a
  // token and then throw.
  let calls = 0;
  const counting: CallFn = async () => {
    calls += 1;
    return null;
  };
  await assert.rejects(() => readStockToken(counting, TOKEN, { maxStaleness: Number.NaN }));
  assert.equal(calls, 0);
});

test("the ordinary durations still pass", async () => {
  const state = await readStockToken(mockCall({}), TOKEN, {
    maxStaleness: 93_600,
    corpActionWindow: 0,
    now: 1_790_000_000,
  });
  assert.equal(state.dataState, "NO_FEED");
});

test("a truncated latestRoundData reply is refused, exactly as the guard refuses it", async () => {
  // ShareExactGuard._tryLatestRoundData returns (false, 0, 0) when the reply is
  // shorter than 160 bytes, before reading any word of it. wordAt does not:
  // words 1 and 3 both exist in a four-word answer, so price and timestamp were
  // read and the state came back FRESH for bytes the contract refuses. That is
  // the SDK and the guard disagreeing, which this file's header says cannot
  // happen.
  const TOKEN = `0x${"11".repeat(20)}`;
  const FEED = `0x${"22".repeat(20)}`;
  const five = `0x${word(1n)}${word(17_840_000_000n)}${word(BigInt(NOW))}${word(BigInt(NOW))}${word(1n)}`;
  const four = `0x${word(1n)}${word(17_840_000_000n)}${word(BigInt(NOW))}${word(BigInt(NOW))}`;
  assert.equal((five.length - 2) / 2, 160);
  assert.equal((four.length - 2) / 2, 128);

  const reader =
    (reply: string): CallFn =>
    async (to: string) =>
      to.toLowerCase() === FEED.toLowerCase() ? reply : `0x${word(WAD)}`;

  const whole = await readStockToken(reader(five), TOKEN, { feed: FEED, feedDecimals: 8, now: NOW });
  assert.equal(whole.dataState, "FRESH");
  assert.equal(whole.price, 178.4);

  const cut = await readStockToken(reader(four), TOKEN, { feed: FEED, feedDecimals: 8, now: NOW });
  assert.equal(cut.dataState, "STALE");
  assert.equal(cut.price, null);

  // One word short of the threshold is still short, whatever it contains.
  const padded = `0x${word(1n)}${word(17_840_000_000n)}${word(BigInt(NOW))}${word(BigInt(NOW))}${word(1n).slice(2)}`;
  const nearly = await readStockToken(reader(padded), TOKEN, { feed: FEED, feedDecimals: 8, now: NOW });
  assert.equal(nearly.dataState, "STALE");
});

test("the SDK and the app classifier never disagree about the same input", async () => {
  // Two copies of one rule set is a standing invitation to drift, and it drifted:
  // a finite-number guard was added to src/lib/market-state.ts first, so for a
  // while the app answered STALE and this file answered FRESH for the same
  // malformed input. A differential fixture is cheaper than remembering.
  const app = await import("../../src/lib/market-state.ts");
  const base = {
    sequencerOk: true,
    hasFeed: true,
    updatedAt: NOW - 50 * 3600,
    price: 178.4,
    now: NOW,
    maxStaleness: 26 * 3600,
    oraclePaused: false,
    effectiveAt: null as number | null,
    multiplier: WAD,
    pendingMultiplier: WAD as bigint | null,
    corpActionWindow: 7200,
  };
  const cases: Array<Record<string, unknown>> = [
    {},
    { updatedAt: NOW - 60 },
    { hasFeed: false },
    { sequencerOk: false },
    { oraclePaused: true, updatedAt: NOW - 60 },
    { updatedAt: NOW + 3600 },
    { effectiveAt: NOW + 1800, pendingMultiplier: 4n * WAD },
    { effectiveAt: NOW + 5 * 86_400, pendingMultiplier: 4n * WAD },
    // the ones that used to differ
    { maxStaleness: NaN },
    { now: NaN },
    { corpActionWindow: NaN, effectiveAt: NOW + 1800, pendingMultiplier: 4n * WAD },
    { effectiveAt: NaN, pendingMultiplier: 4n * WAD },
    { price: NaN, updatedAt: NOW - 60 },
    { price: Infinity, updatedAt: NOW - 60 },
    { price: -Infinity, updatedAt: NOW - 60 },
  ];
  for (const override of cases) {
    const input = { ...base, ...override } as Parameters<typeof classifyDataState>[0];
    assert.equal(
      classifyDataState(input),
      app.classifyDataState(input),
      `classifyDataState differs for ${JSON.stringify(override, (_k, v) => (typeof v === "bigint" ? `${v}` : v))}`,
    );
    assert.equal(
      unitChangeImminent(input),
      app.unitChangeImminent(input),
      `unitChangeImminent differs for ${JSON.stringify(override, (_k, v) => (typeof v === "bigint" ? `${v}` : v))}`,
    );
  }
});
