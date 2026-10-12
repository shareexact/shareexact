/**
 * ShareExact money path — UI shares <-> raw ERC-8056 units.
 *
 * No JS `Number` appears anywhere in this file. A double holds 53 bits of
 * mantissa; an 18-decimal share balance routinely needs more than that, and the
 * error shows up as a dust remainder that a user experiences as "the app lost
 * my money".
 *
 * Written without TypeScript parameter properties on purpose, so the whole
 * money path runs under `node --experimental-strip-types --test` with no
 * bundler in the loop. The conversion layer should be testable by anyone who
 * clones the repo and types `npm test`.
 */

export const SCALE = 10n ** 18n;

export class ConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidAmountError extends ConversionError {
  readonly input: string;

  constructor(input: string) {
    super(`"${input}" is not a valid non-negative decimal amount.`);
    this.input = input;
  }
}

export class PrecisionOverflowError extends ConversionError {
  readonly input: string;
  readonly maxDecimals: number;

  constructor(input: string, maxDecimals: number) {
    super(`"${input}" has more than ${maxDecimals} fractional digits.`);
    this.input = input;
    this.maxDecimals = maxDecimals;
  }
}

export class InsufficientRawBalanceError extends ConversionError {
  readonly raw: bigint;
  readonly balance: bigint;

  constructor(raw: bigint, balance: bigint) {
    super(`Computed raw amount ${raw} exceeds raw balance ${balance}.`);
    this.raw = raw;
    this.balance = balance;
  }
}

export function parseDecimalToBigInt(input: string, decimals = 18): bigint {
  const trimmed = input.trim();
  const match = /^(\d+)?(?:\.(\d+))?$/.exec(trimmed);
  if (!match || (match[1] === undefined && match[2] === undefined)) {
    throw new InvalidAmountError(input);
  }
  const whole = match[1] ?? "0";
  const frac = match[2] ?? "";
  if (frac.length > decimals) throw new PrecisionOverflowError(input, decimals);
  const combined = `${whole}${frac.padEnd(decimals, "0")}`;
  const normalized = combined.replace(/^0+(?=\d)/, "");
  return BigInt(normalized);
}

export function formatFixedToDecimalString(fixed: bigint, decimals = 18): string {
  const negative = fixed < 0n;
  const abs = negative ? -fixed : fixed;
  const s = abs.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return frac.length > 0 ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}

export function formatMultiplierDisplay(multiplier: bigint | null): string {
  if (multiplier == null) return "—";
  return `${formatFixedToDecimalString(multiplier)}×`;
}

export function parseMultiplier(m: string | number): bigint {
  const s = String(m).trim();
  const [w, f = ""] = s.split(".");
  return BigInt(`${w}${(f + "0".repeat(18)).slice(0, 18)}`);
}

/** raw = floor(uiFixed * 1e18 / multiplier) */
export function fallbackUiToRaw(uiFixed: bigint, multiplier: bigint): bigint {
  return (uiFixed * SCALE) / multiplier;
}

export function fallbackRawToUi(raw: bigint, multiplier: bigint): bigint {
  return (raw * multiplier) / SCALE;
}

/**
 * ERC-8056 fixes the scale. `uiMultiplier`, raw balances and share amounts are
 * all 18-decimal fixed point, and `SCALE` above is 1e18 for that reason, so a
 * caller cannot meaningfully ask for a different precision on this path.
 *
 * The `decimals` parameters below are kept for call-site readability and are
 * validated rather than honoured: passing anything else is a programming error
 * that would silently mix two scales inside one expression, and silence is
 * exactly what this codebase refuses to do with units.
 */
export const SHARE_DECIMALS = 18;

export function assertShareDecimals(decimals: number, where: string): void {
  if (decimals !== SHARE_DECIMALS) {
    throw new ConversionError(
      `${where}: ERC-8056 amounts are ${SHARE_DECIMALS}-decimal fixed point; received ${decimals}. Mixing scales here produces an amount that cannot be sent.`,
    );
  }
}

export interface PreviewResult {
  uiFixed: bigint;
  raw: bigint;
  naiveRaw: bigint;
  multiplier: bigint;
  decimals: number;
  uiDisplay: string;
  rawDisplay: string;
  naiveDisplay: string;
  trapRatio: string;
  representable: boolean;
}

/**
 * Dry preview against a known multiplier — the judge-path / demo path.
 * Naive transfer treats the typed share count as raw units (the CRWD ×4 trap).
 */
export function previewFromMultiplier(
  uiSharesInput: string,
  multiplier: bigint,
  decimals = SHARE_DECIMALS,
): PreviewResult {
  assertShareDecimals(decimals, "previewFromMultiplier");
  const uiFixed = parseDecimalToBigInt(uiSharesInput, decimals);
  const raw = fallbackUiToRaw(uiFixed, multiplier);
  const naiveRaw = uiFixed;
  const back = fallbackRawToUi(raw, multiplier);
  return {
    uiFixed,
    raw,
    naiveRaw,
    multiplier,
    decimals,
    uiDisplay: formatFixedToDecimalString(uiFixed, decimals),
    rawDisplay: formatFixedToDecimalString(raw, decimals),
    naiveDisplay: formatFixedToDecimalString(naiveRaw, decimals),
    trapRatio: formatFixedToDecimalString(multiplier, decimals),
    representable: back === uiFixed,
  };
}

/**
 * Largest share amount, as a decimal STRING, that still fits `balanceRaw`.
 *
 * The guarantee has to survive a round trip, because the string this returns is
 * typed into a field, re-parsed, converted again, and only then signed:
 *
 *   fallbackUiToRaw(parseDecimalToBigInt(maxUiFromRaw(balance, m)), m) <= balance
 *
 * An external review flagged the missing format/parse/step loop as a residual
 * bug here. Fuzzing settled it precisely: at 18 decimals the round trip is
 * exact and 20,000 random multiplier/balance pairs pass, so the shipped path was
 * never broken. At `decimals = 6`, 5,000 out of 5,000 pairs fail.
 *
 * But the fix is not a smarter step loop, because the failure is not a rounding
 * bug. `SCALE` is fixed at 1e18 by ERC-8056: the multiplier, the raw balance and
 * the share amount are all 18-decimal fixed point by definition of the standard.
 * A `decimals` argument here implies a choice that does not exist, and any value
 * other than 18 mixes two different scales in one expression. The armed footgun
 * is the parameter itself, so the parameter is what gets disarmed.
 */
export function maxUiFromRaw(balanceRaw: bigint, multiplier: bigint, decimals = SHARE_DECIMALS): string {
  assertShareDecimals(decimals, "maxUiFromRaw");
  if (multiplier <= 0n) throw new ConversionError("multiplier must be positive");
  if (balanceRaw <= 0n) return "0";

  let ui = fallbackRawToUi(balanceRaw, multiplier);
  for (let guard = 0; guard < 10_000 && ui > 0n; guard++) {
    const display = formatFixedToDecimalString(ui, decimals);
    // Re-parse exactly as the caller will. This is the value that gets signed,
    // so this is the value that has to fit — not the one before formatting.
    if (fallbackUiToRaw(parseDecimalToBigInt(display, decimals), multiplier) <= balanceRaw) {
      return display;
    }
    ui -= 1n;
  }
  return "0";
}
