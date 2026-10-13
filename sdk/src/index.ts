/**
 * @shareexact/sdk — read Robinhood Chain Stock Tokens correctly.
 *
 * Zero dependencies, no wallet library, no ABI coder. Give it anything that can
 * perform an `eth_call` and it answers the three questions a protocol has to
 * settle before it moves money against a tokenized equity:
 *
 *   1. How many raw units is one share right now.
 *   2. Is the price trustworthy, or is the feed holding a Friday value.
 *   3. Is a corporate action about to change the ratio under me.
 *
 * The classification is byte-for-byte the same precedence as
 * `ShareExactGuard.sol`, so an integrator reading this SDK and an integrator
 * reading the contract cannot disagree.
 */

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
export const WAD = 10n ** 18n;

export const SELECTORS = {
  balanceOf: "0x70a08231",
  decimals: "0x313ce567",
  symbol: "0x95d89b41",
  uiMultiplier: "0xa60bf13d",
  newUIMultiplier: "0xdc767007",
  effectiveAt: "0x97a4064f",
  oraclePaused: "0x7706ba52",
  balanceOfUI: "0x437a9958",
  latestRoundData: "0xfeaf968c",
} as const;

export type DataState =
  | "FRESH"
  | "STALE"
  | "ORACLE_PAUSED"
  | "CORP_ACTION"
  | "SEQUENCER_DOWN"
  | "NO_FEED";

/** Anything that can answer an eth_call: viem, ethers, window.ethereum, raw fetch. */
export type CallFn = (to: string, data: string) => Promise<string | null>;

export interface StockTokenState {
  token: string;
  /** 18-decimal fixed point. Zero means the multiplier could not be read. */
  multiplier: bigint;
  pendingMultiplier: bigint | null;
  effectiveAt: number | null;
  oraclePaused: boolean;
  price: number | null;
  priceUpdatedAt: number | null;
  ageSeconds: number | null;
  dataState: DataState;
  /**
   * Scheduled unit change, asked on its own. `dataState` can be `STALE` or
   * `ORACLE_PAUSED` while this is true. Do not infer it from the label.
   */
  unitChangeImminent: boolean;
}

export interface ReadOptions {
  /** Chainlink aggregator for this token. Omit to get NO_FEED. */
  feed?: string;
  /** Feed decimals. Defaults to 8. */
  feedDecimals?: number;
  /**
   * Seconds after which a price is stale. Defaults to 26 hours, which is sized
   * for a 24/5 equity feed: tight enough to catch a dead feed, loose enough not
   * to scream through every ordinary overnight gap.
   */
  maxStaleness?: number;
  /** Seconds before a scheduled multiplier change to report CORP_ACTION. Default 2h. */
  corpActionWindow?: number;
  /** Result of your sequencer uptime check. Default true. */
  sequencerOk?: boolean;
  /** Unix seconds to age the feed against. Defaults to wall clock. */
  now?: number;
}

function toBigInt(hex: string | null | undefined): bigint | null {
  if (!hex || hex === "0x" || hex.length < 66) return null;
  try {
    return BigInt(hex.slice(0, 66));
  } catch {
    return null;
  }
}

function wordAt(hex: string | null | undefined, index: number): bigint | null {
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

const TWO_256 = 1n << 256n;
const TWO_255 = 1n << 255n;

/** Shares -> raw units, floored. Flooring can only ever lose value, never create it. */
export function sharesToRaw(uiShares: bigint, multiplier: bigint): bigint {
  if (multiplier <= 0n) throw new Error("multiplier must be positive");
  if (uiShares < 0n) throw new Error("uiShares must not be negative");
  return (uiShares * WAD) / multiplier;
}

/** Raw units -> shares, floored. */
export function rawToShares(raw: bigint, multiplier: bigint): bigint {
  if (multiplier <= 0n) throw new Error("multiplier must be positive");
  if (raw < 0n) throw new Error("raw must not be negative");
  return (raw * multiplier) / WAD;
}

function normaliseFeedDecimals(value: number | undefined): number {
  const decimals = value ?? 8;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("feedDecimals must be an integer between 0 and 36");
  }
  return decimals;
}

/**
 * Every seconds argument is checked, because every way they can be wrong is
 * silent.
 *
 * `maxStaleness: NaN` makes `now - updatedAt > NaN` false, so a feed that has
 * not published in a week comes back `FRESH`. `corpActionWindow: NaN` makes
 * `effectiveAt - now <= NaN` false, so a split scheduled for ten minutes from
 * now is never reported. Neither throws, neither logs, and both turn this
 * library into the thing it exists to prevent — a confident answer about a
 * number nobody checked.
 *
 * `NaN` is not hypothetical: it is what `Number(undefined)`,
 * `parseInt("")` and a missing field in a parsed config all produce, and each
 * of those is one keystroke away in an integration.
 *
 * This throws rather than clamping. An out-of-range duration is a programming
 * error in the caller, and the one thing worse than crashing on it is quietly
 * substituting a value the caller did not choose and will never see.
 */
function requireSeconds(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number of seconds`);
  }
  if (value < 0) {
    throw new Error(`${name} must not be negative`);
  }
  return value;
}

/**
 * The interface promises to accept "anything that can answer an eth_call", so a
 * caller-supplied function that throws is a legal input, not a bug. Wrapping it
 * here is what makes the never-throws claim on `readStockToken` actually true —
 * the built-in callers swallow their own errors, but a viem or ethers client
 * passed in directly will not.
 */
async function safeCall(call: CallFn, to: string, data: string): Promise<string | null> {
  try {
    return await call(to, data);
  } catch {
    return null;
  }
}

export function classifyDataState(input: {
  sequencerOk: boolean;
  hasFeed: boolean;
  price: number | null;
  updatedAt: number | null;
  now: number;
  maxStaleness: number;
  oraclePaused: boolean;
  effectiveAt: number | null;
  multiplier: bigint;
  pendingMultiplier: bigint | null;
  corpActionWindow: number;
}): DataState {
  if (!input.sequencerOk) return "SEQUENCER_DOWN";
  if (!input.hasFeed) {
    if (unitChangeImminent(input)) return "CORP_ACTION";
    return "NO_FEED";
  }
  if (input.price === null || input.price <= 0 || !input.updatedAt) return "STALE";
  // A timestamp in the future is a broken or hostile feed, not a fresher one.
  // Identical to ShareExactGuard._evaluate and src/lib/market-state.ts.
  if (input.updatedAt > input.now) return "STALE";
  if (input.now > input.updatedAt && input.now - input.updatedAt > input.maxStaleness) return "STALE";
  if (input.oraclePaused) return "ORACLE_PAUSED";
  if (unitChangeImminent(input)) return "CORP_ACTION";
  return "FRESH";
}

export function unitChangeImminent(input: Parameters<typeof classifyDataState>[0]): boolean {
  // Same order as ShareExactGuard._corpActionImminent. An unreadable pending
  // multiplier fails closed for any future effectiveAt, before the window.
  if (input.effectiveAt == null || input.effectiveAt <= input.now) return false;
  if (input.pendingMultiplier === null) return true;
  if (input.multiplier === 0n || input.pendingMultiplier === input.multiplier) return false;
  return input.effectiveAt - input.now <= input.corpActionWindow;
}

/**
 * Read everything about one Stock Token in five calls.
 *
 * Does not throw on a failed or throwing `CallFn`; every read degrades to null
 * and is reflected in `dataState`. It does throw on invalid arguments —
 * `feedDecimals`, `maxStaleness`, `corpActionWindow` and `now` are all checked
 * before any call is made — because those are programming errors in the caller
 * rather than network conditions, and a library that silently repaired them
 * would be answering a question nobody asked.
 */
export async function readStockToken(
  call: CallFn,
  token: string,
  options: ReadOptions = {},
): Promise<StockTokenState> {
  const maxStaleness = requireSeconds("maxStaleness", options.maxStaleness ?? 26 * 60 * 60);
  const corpActionWindow = requireSeconds(
    "corpActionWindow",
    options.corpActionWindow ?? 2 * 60 * 60,
  );
  const feedDecimals = normaliseFeedDecimals(options.feedDecimals);
  const now = requireSeconds("now", options.now ?? Math.floor(Date.now() / 1000));

  const [multiplierHex, pendingHex, effectiveHex, pausedHex, roundHex] = await Promise.all([
    safeCall(call, token, SELECTORS.uiMultiplier),
    safeCall(call, token, SELECTORS.newUIMultiplier),
    safeCall(call, token, SELECTORS.effectiveAt),
    safeCall(call, token, SELECTORS.oraclePaused),
    options.feed ? safeCall(call, options.feed, SELECTORS.latestRoundData) : Promise.resolve(null),
  ]);

  // FAIL CLOSED: zero means "we could not read the ratio", never "assume 1:1".
  // Pending and effectiveAt are read independently. Dropping them when the
  // current multiplier fails would hide a scheduled change the guard reports.
  const multiplier = toBigInt(multiplierHex) ?? 0n;
  const pendingMultiplier = toBigInt(pendingHex);
  const effectiveRaw = toBigInt(effectiveHex);
  const effectiveAt = effectiveRaw && effectiveRaw > 0n ? Number(effectiveRaw) : null;
  const pausedRaw = toBigInt(pausedHex);
  // Match ShareExactGuard._tryBool: only the word `1` is true. 0 is false,
  // and anything else (dirty ABI word) is unreadable, not "paused".
  const oraclePaused = pausedRaw === 1n;

  let price: number | null = null;
  let priceUpdatedAt: number | null = null;
  if (options.feed && roundHex) {
    const rawAnswer = wordAt(roundHex, 1);
    const updated = wordAt(roundHex, 3);
    if (rawAnswer !== null) {
      const signed = rawAnswer >= TWO_255 ? rawAnswer - TWO_256 : rawAnswer;
      if (signed > 0n) {
        const divisor = 10n ** BigInt(feedDecimals);
        price = Number(signed / divisor) + Number(signed % divisor) / Number(divisor);
      }
    }
    if (updated !== null && updated > 0n) priceUpdatedAt = Number(updated);
  }

  const moving = unitChangeImminent({
    sequencerOk: options.sequencerOk ?? true,
    hasFeed: Boolean(options.feed),
    price,
    updatedAt: priceUpdatedAt,
    now,
    maxStaleness,
    oraclePaused,
    effectiveAt,
    multiplier,
    pendingMultiplier,
    corpActionWindow,
  });

  const dataState = classifyDataState({
    sequencerOk: options.sequencerOk ?? true,
    hasFeed: Boolean(options.feed),
    price,
    updatedAt: priceUpdatedAt,
    now,
    maxStaleness,
    oraclePaused,
    effectiveAt,
    multiplier,
    pendingMultiplier,
    corpActionWindow,
  });

  return {
    token,
    multiplier,
    pendingMultiplier,
    effectiveAt,
    oraclePaused,
    price,
    priceUpdatedAt,
    ageSeconds: priceUpdatedAt ? Math.max(0, now - priceUpdatedAt) : null,
    dataState,
    unitChangeImminent: moving,
  };
}

/** True when a price may be used as a live mark. */
export const isPriceable = (state: DataState): boolean => state === "FRESH";

/**
 * True when a share conversion may be sent.
 *
 * Three things have to hold, and each has been got wrong at least once:
 *
 *   - the chain has to be live, which is what `SEQUENCER_DOWN` means;
 *   - no unit change may be about to land — and `dataState` will not show one
 *     while the feed is `STALE` or the issuer has paused the oracle, because a
 *     single-valued label has to pick an answer and price outranks unit inside
 *     it. Passing only the label is how a pending split was once reported as
 *     executable;
 *   - and the ratio has to be readable at all.
 *
 * The third is why `multiplier` is here. A token whose `uiMultiplier()` cannot
 * be read comes back as `0n`, `unitChangeImminent` is false for it, and the
 * label can be anything — so without this check the predicate answered
 * "executable" about a token the contract refuses outright:
 * `ExactTransfer.transferShares` reverts with `UnitUnavailable`. A predicate
 * that disagrees with the contract it exists to predict is worse than no
 * predicate, because it gets believed.
 *
 * `StockTokenState` already has this shape, so pass the token read in whole.
 */
export function isShareConversionExecutable(input: {
  dataState: DataState;
  unitChangeImminent: boolean;
  /** Current ratio, 18-decimal fixed point. Zero means it could not be read. */
  multiplier: bigint;
}): boolean {
  if (input.dataState === "SEQUENCER_DOWN" || input.dataState === "CORP_ACTION") return false;
  // Written as a positive test on purpose: a JavaScript caller compiled against
  // the older two-field shape passes `undefined` here, this comparison is false,
  // and the answer is "not executable". An absent field is not evidence that the
  // unit is readable, and the safe direction is the same one the contract takes.
  if (!(input.multiplier > 0n)) return false;
  return !input.unitChangeImminent;
}

/**
 * @deprecated Misleadingly broad name. Use `isShareConversionExecutable`.
 * It checks unit mechanics only, never economic or compliance safety.
 */
export const isTransferSafe = isShareConversionExecutable;

/** Build a CallFn from a plain JSON-RPC endpoint. */
export function rpcCaller(url: string): CallFn {
  return async (to, data) => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to, data }, "latest"],
        }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { result?: string };
      return json.result && json.result !== "0x" ? json.result : null;
    } catch {
      return null;
    }
  };
}

/** Build a CallFn from any EIP-1193 provider (window.ethereum, viem, ethers). */
export function providerCaller(provider: {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}): CallFn {
  return async (to, data) => {
    try {
      const result = (await provider.request({
        method: "eth_call",
        params: [{ to, data }, "latest"],
      })) as string;
      return result && result !== "0x" ? result : null;
    } catch {
      return null;
    }
  };
}
