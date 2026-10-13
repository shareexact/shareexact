import assert from "node:assert/strict";
import test from "node:test";
import {
  SELECTORS,
  TOPICS,
  decodeBool,
  decodeErc20Transfer,
  decodeExactShareTransfer,
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

/*//////////////////////////////////////////////////////////////
                             LOGS
//////////////////////////////////////////////////////////////*/

const WAD = 10n ** 18n;
const TOKEN = "0x1111111111111111111111111111111111111111";
const FROM = "0x2222222222222222222222222222222222222222";
const TO = "0x3333333333333333333333333333333333333333";

const topic = (address: string) =>
  `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
const blob = (...values: bigint[]) =>
  `0x${values.map((v) => v.toString(16).padStart(64, "0")).join("")}`;

/**
 * The ERC-20 `Transfer` topic is public knowledge and appears on every explorer
 * page. Pinning it proves the topic table came out of a real keccak run rather
 * than being typed from memory — the same argument as the selectors above, and
 * it matters more here, because a wrong topic would not fail loudly: the desk
 * would simply never find the log and would report every transfer as pending.
 */
test("the well-known event topic matches", () => {
  assert.equal(
    TOPICS.transfer,
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  );
  assert.match(TOPICS.exactShareTransfer, /^0x[0-9a-f]{64}$/);
});

test("ExactShareTransfer decodes to the eight values the contract emitted", () => {
  const event = decodeExactShareTransfer({
    address: "0x4444444444444444444444444444444444444444",
    topics: [TOPICS.exactShareTransfer, topic(TOKEN), topic(FROM), topic(TO)],
    data: blob(WAD, WAD - 3n, WAD / 4n, 4n * WAD, 5n),
  });
  assert.ok(event);
  assert.equal(event.token, TOKEN);
  assert.equal(event.from, FROM);
  assert.equal(event.to, TO);
  assert.equal(event.uiShares, WAD);
  assert.equal(event.deliveredShares, WAD - 3n);
  assert.equal(event.raw, WAD / 4n);
  assert.equal(event.multiplier, 4n * WAD);
  assert.equal(event.maxShortfall, 5n);
});

test("a log that is not ours decodes to null rather than to zeroes", () => {
  // Returning a zero-filled event for an unrecognised log would let the desk
  // print "0 shares delivered" over a transaction it never read.
  assert.equal(
    decodeExactShareTransfer({
      topics: [TOPICS.transfer, topic(FROM), topic(TO)],
      data: blob(WAD),
    }),
    null,
  );
  assert.equal(
    decodeExactShareTransfer({
      topics: [TOPICS.exactShareTransfer, topic(TOKEN), topic(FROM), topic(TO)],
      data: blob(WAD, WAD, WAD), // three words where five are required
    }),
    null,
  );
  assert.equal(decodeExactShareTransfer({ topics: [], data: "0x" }), null);
});

test("an ERC-20 Transfer yields the raw value and the two parties", () => {
  const event = decodeErc20Transfer({
    address: TOKEN,
    topics: [TOPICS.transfer, topic(FROM), topic(TO)],
    data: blob(WAD / 4n),
  });
  assert.ok(event);
  assert.equal(event.from, FROM);
  assert.equal(event.to, TO);
  assert.equal(event.value, WAD / 4n);
  assert.equal(decodeErc20Transfer({ topics: [TOPICS.exactShareTransfer], data: "0x" }), null);
});
