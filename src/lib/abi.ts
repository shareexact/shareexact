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

/*//////////////////////////////////////////////////////////////
                          EVENT TOPICS
//////////////////////////////////////////////////////////////*/

/**
 * `topics[0]` of a log is keccak256 of the event signature.
 *
 * These exist so the desk can read what a transaction actually did instead of
 * reporting what it predicted beforehand. `transfer` is pinned in `abi.test.ts`
 * against the value every explorer shows, for the same reason the selectors are:
 * it proves the table came out of a real keccak run rather than from memory.
 */
export const TOPICS = {
  /** ExactShareTransfer(address,address,address,uint256,uint256,uint256,uint256,uint256) */
  exactShareTransfer: "0xb2b898b2fa6ac66d43a75ab8119dbfd075f91c3eb28ac39ecbd341780ec98b15",
  /** Transfer(address,address,uint256) */
  transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
} as const;

/**
 * A log as a provider returns it. Every field is optional because this is JSON
 * arriving from outside, not a shape we control.
 */
export interface EventLog {
  address?: string;
  topics?: string[];
  data?: string;
}

/** The contract's own account of the transfer: three indexed arguments in the
 *  topics, five numbers in the data. */
export interface ExactShareTransferEvent {
  token: string;
  from: string;
  to: string;
  uiShares: bigint;
  deliveredShares: bigint;
  raw: bigint;
  multiplier: bigint;
  maxShortfall: bigint;
}

/** An indexed `address` sits right-aligned in a 32-byte topic. */
function addressFromTopic(topic: string | undefined): string | null {
  if (typeof topic !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  return `0x${topic.slice(26)}`.toLowerCase();
}

export function decodeExactShareTransfer(log: EventLog): ExactShareTransferEvent | null {
  const topics = log.topics ?? [];
  if (topics[0]?.toLowerCase() !== TOPICS.exactShareTransfer) return null;
  const token = addressFromTopic(topics[1]);
  const from = addressFromTopic(topics[2]);
  const to = addressFromTopic(topics[3]);
  if (!token || !from || !to) return null;
  const words = [0, 1, 2, 3, 4].map((i) => wordAt(log.data, i));
  // A short data blob is a log we do not understand, which is not the same as a
  // log full of zeroes. Decode all five numbers or none of them.
  if (words.some((w) => w === null)) return null;
  const [uiShares, deliveredShares, raw, multiplier, maxShortfall] = words as bigint[];
  return { token, from, to, uiShares, deliveredShares, raw, multiplier, maxShortfall };
}

/**
 * Decode an ERC-20 `Transfer`.
 *
 * This proves how many raw units moved and nothing else. On the preflight route
 * that is all a receipt can ever prove, because the share count never entered
 * the transaction — which is exactly the difference between the two routes, now
 * visible in the receipt instead of only in the documentation.
 */
export function decodeErc20Transfer(
  log: EventLog,
): { from: string; to: string; value: bigint } | null {
  const topics = log.topics ?? [];
  if (topics[0]?.toLowerCase() !== TOPICS.transfer) return null;
  const from = addressFromTopic(topics[1]);
  const to = addressFromTopic(topics[2]);
  const value = wordAt(log.data, 0);
  if (!from || !to || value === null) return null;
  return { from, to, value };
}
