import assert from "node:assert/strict";
import test from "node:test";
import {
  clearOracleOverlay,
  displayedShares,
  getStock,
  holdingValue,
  mergeOracleMarks,
  portfolioTotals,
  positionDollars,
  type Holding,
} from "./stocks.ts";

const RAW = (10n ** 18n).toString();

function mark(multiplier: string) {
  mergeOracleMarks([
    {
      symbol: "CRWD",
      price: 1600,
      updatedAt: 100,
      ageSeconds: 0,
      multiplier,
      pendingMultiplier: multiplier,
      effectiveAt: null,
      dataState: "FRESH",
      unitAvailable: true,
      contract: "0x1111111111111111111111111111111111111111",
    },
  ]);
}

const holding: Holding = { symbol: "CRWD", shares: 1, cost: 0, raw: RAW };

test("a neutral split does not change dollars", () => {
  try {
    mark("1.000000000000000000");
    const beforeShares = displayedShares(holding);
    const before = positionDollars(holding);
    assert.equal(beforeShares, 1);
    assert.equal(before, 1600);
    assert.equal(holdingValue(holding).value, 1600);
    assert.equal(getStock("CRWD")?.price, 1600);
    assert.equal(getStock("CRWD")?.rawTokenPrice, 1600);

    mark("4.000000000000000000");
    const afterShares = displayedShares(holding);
    const after = positionDollars(holding);
    assert.equal(afterShares, 4);
    assert.equal(after, 1600);
    assert.equal(holdingValue(holding).value, 1600);
    assert.equal(portfolioTotals([holding]).value, 1600);
    assert.equal(getStock("CRWD")?.price, 400);
    assert.equal(getStock("CRWD")?.rawTokenPrice, 1600);
    // Holdings, the brief, the risk book and the asset panel all use this pair.
    assert.equal(afterShares * (getStock("CRWD")?.price ?? 0), 1600);
    assert.equal(portfolioTotals([holding]).value, 1600);
  } finally {
    clearOracleOverlay("CRWD");
  }
});

test("the old shares × token-price path is the 4× error", () => {
  mark("4.000000000000000000");
  try {
    const doubled = 4 * 1600;
    assert.equal(doubled, 6400);
    assert.equal(positionDollars(holding), 1600);
  } finally {
    clearOracleOverlay("CRWD");
  }
});
