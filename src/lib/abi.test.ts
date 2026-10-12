import assert from "node:assert/strict";
import test from "node:test";
import {
  SELECTORS,
  decodeBool,
  decodeRoundData,
  decodeUint,
  encodeBalanceOf,
  encodeTransfer,
  padUint,
  scaleAnswer,
} from "./abi.ts";

/**
 * These three selectors are public knowledge and appear in every block
 * explorer. Pinning them proves the whole table was generated with a real
 * keccak implementation rather than typed by hand.
 */
test("well-known selectors match", () => {
  assert.equal(SELECTORS.balanceOf, "0x70a08231");
  assert.equal(SELECTORS.transfer, "0xa9059cbb");
  assert.equal(SELECTORS.approve, "0x095ea7b3");
  assert.equal(SELECTORS.latestRoundData, "0xfeaf968c");
  assert.equal(SELECTORS.decimals, "0x313ce567");
});

test("calldata is exactly 4 + 32n bytes", () => {
  const balance = encodeBalanceOf("0x1111111111111111111111111111111111111111");
  assert.equal(balance.length, 2 + 8 + 64);
  const transfer = encodeTransfer("0x2222222222222222222222222222222222222222", 10n ** 18n);
  assert.equal(transfer.length, 2 + 8 + 128);
  assert.ok(transfer.startsWith(SELECTORS.transfer));
});

test("address is lower-cased and left-padded", () => {
  const data = encodeBalanceOf("0xABCDEF0000000000000000000000000000000001");
  assert.ok(data.endsWith("abcdef0000000000000000000000000000000001"));
  assert.ok(data.includes("000000000000000000000000abcdef"));
});

test("padUint rejects negatives", () => {
  assert.throws(() => padUint(-1n));
  assert.equal(padUint(255n).slice(-2), "ff");
});

test("decodeUint tolerates empty and short data", () => {
  assert.equal(decodeUint(null), null);
  assert.equal(decodeUint("0x"), null);
  assert.equal(decodeUint("0x01"), null);
  assert.equal(decodeUint(`0x${"0".repeat(63)}5`), 5n);
});

test("decodeBool matches the contract: only 0 and 1 are booleans", () => {
  const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
  assert.equal(decodeBool(word(0n)), false);
  assert.equal(decodeBool(word(1n)), true);
  assert.equal(decodeBool(word(2n)), null);
  assert.equal(decodeBool(null), null);
  assert.equal(decodeBool("0x"), null);
});

test("latestRoundData decodes a negative answer correctly", () => {
  // (roundId=1, answer=-42, startedAt=7, updatedAt=9, answeredInRound=1)
  const word = (hex: string) => hex.padStart(64, "0");
  const negative = ((1n << 256n) - 42n).toString(16).padStart(64, "0");
  const blob = `0x${word("1")}${negative}${word("7")}${word("9")}${word("1")}`;
  const round = decodeRoundData(blob);
  assert.ok(round);
  assert.equal(round.answer, -42n);
  assert.equal(round.updatedAt, 9n);
});

test("chainlink answers scale by feed decimals", () => {
  assert.equal(scaleAnswer(17_840_000_000n, 8), 178.4);
  assert.equal(scaleAnswer(100_000_000n, 8), 1);
});
