import assert from "node:assert/strict";
import test from "node:test";
import {
  ConversionError,
  InvalidAmountError,
  PrecisionOverflowError,
  fallbackRawToUi,
  fallbackUiToRaw,
  formatFixedToDecimalString,
  maxUiFromRaw,
  parseDecimalToBigInt,
  parseMultiplier,
  previewFromMultiplier,
  SHARE_DECIMALS,
} from "./conversion.ts";

const WAD = 10n ** 18n;

test("decimal strings parse to 18-decimal fixed point", () => {
  assert.equal(parseDecimalToBigInt("1"), WAD);
  assert.equal(parseDecimalToBigInt("0.5"), WAD / 2n);
  assert.equal(parseDecimalToBigInt("12.25"), 12_250_000_000_000_000_000n);
  assert.equal(parseDecimalToBigInt(".5"), WAD / 2n);
  assert.equal(parseDecimalToBigInt("0"), 0n);
});

test("malformed input is rejected rather than coerced", () => {
  for (const bad of ["", ".", "-1", "1.2.3", "1e18", "abc", "1,5", " "]) {
    assert.throws(() => parseDecimalToBigInt(bad), InvalidAmountError, `accepted "${bad}"`);
  }
});

test("more precision than the token has is an error, not a silent truncation", () => {
  assert.throws(() => parseDecimalToBigInt(`0.${"1".repeat(19)}`), PrecisionOverflowError);
});

test("formatting round-trips and trims trailing zeros", () => {
  assert.equal(formatFixedToDecimalString(WAD), "1");
  assert.equal(formatFixedToDecimalString(WAD / 2n), "0.5");
  assert.equal(formatFixedToDecimalString(0n), "0");
  assert.equal(formatFixedToDecimalString(1n), "0.000000000000000001");
  const value = parseDecimalToBigInt("123.456");
  assert.equal(formatFixedToDecimalString(value), "123.456");
});

test("multiplier strings parse without floating point", () => {
  assert.equal(parseMultiplier("1"), WAD);
  assert.equal(parseMultiplier("4"), 4n * WAD);
  assert.equal(parseMultiplier("1.000775159164630595"), 1_000_775_159_164_630_595n);
  // A multiplier with more than 18 decimals is truncated, never rounded up,
  // because rounding up would let a conversion create value out of nothing.
  assert.equal(parseMultiplier("1.0000000000000000009"), WAD);
});

test("share to raw conversion floors and never inflates", () => {
  const multiplier = 3n * WAD;
  const raw = fallbackUiToRaw(parseDecimalToBigInt("1"), multiplier);
  const back = fallbackRawToUi(raw, multiplier);
  assert.ok(back <= WAD, "round trip created value");
  assert.ok(WAD - back <= 1n, "lost more than one wei");
});

test("a 4x multiplier is the trap the product exists for", () => {
  // One raw token is four shares, so one share is a quarter of a raw token.
  const multiplier = 4n * WAD;
  assert.equal(fallbackUiToRaw(WAD, multiplier), WAD / 4n);
  // Sending a typed "1" as raw units moves four shares instead of one.
  assert.equal(fallbackRawToUi(WAD, multiplier), 4n * WAD);
});

test("preview exposes both the naive and the exact path", () => {
  const preview = previewFromMultiplier("1", 4n * WAD);
  assert.equal(preview.rawDisplay, "0.25");
  assert.equal(preview.naiveDisplay, "1");
  assert.equal(preview.representable, true);
});

test("max spendable never exceeds the raw balance", () => {
  const multiplier = 3n * WAD;
  const balance = parseDecimalToBigInt("10");
  const max = maxUiFromRaw(balance, multiplier);
  const raw = fallbackUiToRaw(parseDecimalToBigInt(max), multiplier);
  assert.ok(raw <= balance, `max ${max} converts to ${raw} > balance ${balance}`);
});

test("max spendable is stable for exact multipliers", () => {
  assert.equal(maxUiFromRaw(parseDecimalToBigInt("10"), 4n * WAD), "40");
  assert.equal(maxUiFromRaw(parseDecimalToBigInt("10"), WAD), "10");
});

test("max spendable survives the format and re-parse round trip", () => {
  // The value this returns is typed into a field and parsed again before it is
  // signed, so the guarantee has to hold on the re-parsed value, not on the
  // intermediate one.
  for (let i = 0; i < 500; i++) {
    const multiplier = BigInt(Math.floor(Math.random() * 9e18)) + 10n ** 17n;
    const balance = BigInt(Math.floor(Math.random() * 1e15)) * 10n ** 3n;
    const max = maxUiFromRaw(balance, multiplier);
    const raw = fallbackUiToRaw(parseDecimalToBigInt(max), multiplier);
    assert.ok(raw <= balance, `max ${max} converts to ${raw} > balance ${balance}`);
  }
});

test("a non-18 decimal scale is rejected rather than silently mixed", () => {
  // ERC-8056 fixes the scale at 1e18. Honouring a different precision here
  // would mix two scales in one expression and return an amount that cannot be
  // sent: at 6 decimals, 5000 of 5000 fuzzed cases failed before this guard.
  assert.throws(() => maxUiFromRaw(10n ** 18n, 3n * 10n ** 18n, 6), ConversionError);
  assert.throws(() => previewFromMultiplier("1", 4n * 10n ** 18n, 8), ConversionError);
  assert.equal(SHARE_DECIMALS, 18);
});
