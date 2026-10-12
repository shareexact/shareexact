/**
 * Hand-rolled ABI encode/decode for the handful of calls ShareExact makes.
 *
 * Every call in this app is a single static read or a single ERC-20 write with
 * fixed-width arguments, so a full ABI coder would be ~100 kB of dependency for
 * eight function signatures. Selectors below are keccak256 of the signature,
 * truncated to 4 bytes, and are pinned in `abi.test.ts` against the three
 * universally known values (balanceOf, transfer, latestRoundData) so a typo
 * cannot silently ship.
 */

export const SELECTORS = {
  // ERC-20
  balanceOf: "0x70a08231", // balanceOf(address)
  transfer: "0xa9059cbb", // transfer(address,uint256)
  approve: "0x095ea7b3", // approve(address,uint256)
  allowance: "0xdd62ed3e", // allowance(address,address)
  decimals: "0x313ce567", // decimals()
  symbol: "0x95d89b41", // symbol()
  // ERC-8056 + Robinhood
  uiMultiplier: "0xa60bf13d", // uiMultiplier()
  newUIMultiplier: "0xdc767007", // newUIMultiplier()
  effectiveAt: "0x97a4064f", // effectiveAt()
  oraclePaused: "0x7706ba52", // oraclePaused()
  balanceOfUI: "0x437a9958", // balanceOfUI(address)
  // Chainlink
  latestRoundData: "0xfeaf968c", // latestRoundData()
  // ShareExact contracts
  transferShares: "0xa1774ea4", // transferShares(address,address,uint256,uint256)
  guardState: "0x31e658a5", // state(address)
  multiplierOf: "0x8e4a5248", // multiplierOf(address)
} as const;

export function padAddress(address: string): string {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

export function padUint(value: bigint): string {
  if (value < 0n) throw new Error("padUint: negative");
  return value.toString(16).padStart(64, "0");
}

export function encodeBalanceOf(holder: string): string {
  return `${SELECTORS.balanceOf}${padAddress(holder)}`;
}

export function encodeTransfer(to: string, rawAmount: bigint): string {
  return `${SELECTORS.transfer}${padAddress(to)}${padUint(rawAmount)}`;
}

export function encodeApprove(spender: string, rawAmount: bigint): string {
  return `${SELECTORS.approve}${padAddress(spender)}${padUint(rawAmount)}`;
}

export function encodeAllowance(owner: string, spender: string): string {
  return `${SELECTORS.allowance}${padAddress(owner)}${padAddress(spender)}`;
}

export function encodeTransferShares(
  token: string,
  to: string,
  uiShares: bigint,
  maxShortfall: bigint,
): string {
  return `${SELECTORS.transferShares}${padAddress(token)}${padAddress(to)}${padUint(uiShares)}${padUint(
    maxShortfall,
  )}`;
}

/** Decode a single uint256 return value. Returns null on empty/short data. */
export function decodeUint(hex: string | null | undefined): bigint | null {
  if (!hex || hex === "0x" || hex.length < 66) return null;
  try {
    return BigInt(hex.slice(0, 66));
  } catch {
    return null;
  }
}

export function decodeBool(hex: string | null | undefined): boolean | null {
  const value = decodeUint(hex);
  if (value === null) return null;
  // Mirror ShareExactGuard._tryBool: only 0/1 are booleans. A dirty word is
  // unreadable, not `true` — treating 2 as paused would make the desk disagree
  // with the chain about whether the issuer paused the oracle.
  if (value === 0n) return false;
  if (value === 1n) return true;
  return null;
}

export function decodeUint8(hex: string | null | undefined): number | null {
  const value = decodeUint(hex);
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 255 ? n : null;
}

const TWO_256 = 1n << 256n;
const TWO_255 = 1n << 255n;

/** Read word `index` of an ABI return blob as a signed int256. */
export function decodeInt256At(hex: string | null | undefined, index: number): bigint | null {
  const word = wordAt(hex, index);
  if (word === null) return null;
  return word >= TWO_255 ? word - TWO_256 : word;
}

export function wordAt(hex: string | null | undefined, index: number): bigint | null {
  if (!hex || hex === "0x") return null;
  const body = hex.slice(2);
  const start = index * 64;
  if (body.length < start + 64) return null;
  try {
    return BigInt(`0x${body.slice(start, start + 64)}`);
  } catch {
    return null;
  }
}

export interface RoundData {
  roundId: bigint;
  answer: bigint;
  startedAt: bigint;
  updatedAt: bigint;
}

/** Decode Chainlink `latestRoundData()`: (uint80, int256, uint256, uint256, uint80). */
export function decodeRoundData(hex: string | null | undefined): RoundData | null {
  const roundId = wordAt(hex, 0);
  const answer = decodeInt256At(hex, 1);
  const startedAt = wordAt(hex, 2);
  const updatedAt = wordAt(hex, 3);
  if (roundId === null || answer === null || startedAt === null || updatedAt === null) return null;
  return { roundId, answer, startedAt, updatedAt };
}

/** Chainlink answers are integers scaled by `decimals`. Returns a JS number for display only. */
export function scaleAnswer(answer: bigint, decimals: number): number {
  if (decimals <= 0) return Number(answer);
  const divisor = 10n ** BigInt(decimals);
  const whole = answer / divisor;
  const frac = answer % divisor;
  return Number(whole) + Number(frac) / Number(divisor);
}
