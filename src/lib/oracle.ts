import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  SELECTORS,
  decodeBool,
  decodeRoundData,
  decodeUint,
  scaleAnswer,
} from "./abi";
import {
  CORP_ACTION_WINDOW,
  DEFAULT_FEED_DECIMALS,
  FEEDS_GENERATED_AT,
  FEEDS_SOURCE,
  SEQUENCER_FEED,
  SEQUENCER_GRACE_PERIOD,
  feedCount,
  feedFor,
} from "./feeds";
import { classifyDataState, type DataState } from "./market-state";
import { ethCallBatch, getBlockTimestamp, type Call } from "./rpc";
import { loadRhjAssets, type RegistryAsset } from "./scan";

/**
 * Reads, for every requested Stock Token, the four things a contract would read
 * before trusting a price:
 *
 *   - the Chainlink answer and its `updatedAt`
 *   - the ERC-8056 `uiMultiplier()` straight from the token, not from the
 *     registry snapshot (the registry is a cache; the chain is the truth)
 *   - the pending multiplier and its activation time
 *   - the advisory `oraclePaused()` flag
 *
 * plus the L2 sequencer uptime feed once for the whole batch.
 *
 * Everything degrades. A token that does not implement ERC-8056 reports a 1.0
 * multiplier. A feed that is unreachable reports STALE. Nothing here throws,
 * and nothing here substitutes a made-up number for a missing one.
 */

export interface AssetOracleState {
  symbol: string;
  contract: string;
  feed: string | null;
  /** Price of ONE token, multiplier already included by the feed. */
  price: number | null;
  decimals: number;
  updatedAt: number | null;
  ageSeconds: number | null;
  /**
   * 18-decimal fixed point as a decimal string, read live from the token.
   * Null when `uiMultiplier()` could not be read — never silently 1.0.
   */
  multiplier: string | null;
  pendingMultiplier: string | null;
  effectiveAt: number | null;
  oraclePaused: boolean;
  dataState: DataState;
  /**
   * Whether the share/raw ratio is known. False means the desk must not quote
   * this asset in shares at all.
   *
   * Kept separate from `dataState` on purpose: a price can be fresh while the
   * unit is unknown, and those two failures need different responses. Pricing
   * without a unit is merely incomplete; converting without a unit moves the
   * wrong amount of money.
   */
  unitAvailable: boolean;
}

export interface OracleSnapshot {
  ok: boolean;
  chainTime: number;
  sequencerOk: boolean;
  sequencerConfigured: boolean;
  feedsConfigured: number;
  feedsSource: string;
  feedsGeneratedAt: string | null;
  corpActionWindow: number;
  assets: AssetOracleState[];
  error?: string;
}

function formatFixed(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const padded = abs.toString().padStart(19, "0");
  const whole = padded.slice(0, padded.length - 18);
  const frac = padded.slice(padded.length - 18).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * @param now Chain head timestamp.
 *
 * The clock matters. `ShareExactGuard._sequencerOk` measures the grace period
 * against `block.timestamp`; this function used to measure it against
 * `Date.now()`. Two clocks means that for a few seconds either side of the
 * grace boundary the desk and the chain can give different answers about
 * whether data is trustworthy — in a product whose whole claim is that the UI,
 * the SDK and the contract agree. One clock source, passed in explicitly.
 */
async function readSequencer(now: number): Promise<{ configured: boolean; ok: boolean }> {
  if (!SEQUENCER_FEED) return { configured: false, ok: true };
  const [result] = await ethCallBatch([{ to: SEQUENCER_FEED, data: SELECTORS.latestRoundData }]);
  const round = decodeRoundData(result);
  if (!round) return { configured: true, ok: false };
  if (round.answer !== 0n) return { configured: true, ok: false };
  if (round.startedAt === 0n) return { configured: true, ok: false };
  const startedAt = Number(round.startedAt);
  if (startedAt > now) return { configured: true, ok: false }; // future start: broken feed
  return { configured: true, ok: now - startedAt > SEQUENCER_GRACE_PERIOD };
}

export async function readOracleState(symbols: string[]): Promise<OracleSnapshot> {
  const base: OracleSnapshot = {
    ok: false,
    chainTime: Math.floor(Date.now() / 1000),
    sequencerOk: true,
    sequencerConfigured: Boolean(SEQUENCER_FEED),
    feedsConfigured: feedCount(),
    feedsSource: FEEDS_SOURCE,
    feedsGeneratedAt: FEEDS_GENERATED_AT,
    corpActionWindow: CORP_ACTION_WINDOW,
    assets: [],
  };

  let registry: RegistryAsset[] = [];
  try {
    registry = await loadRhjAssets();
  } catch (err) {
    return { ...base, error: `registry unavailable: ${String(err)}` };
  }

  const wanted = new Set(symbols.map((s) => s.toUpperCase()));
  const assets = registry.filter((a) => wanted.has(a.symbol.toUpperCase())).slice(0, 60);
  if (assets.length === 0) return { ...base, ok: true };

  // Chain time first, then everything else measured against it.
  const chainTs = await getBlockTimestamp();
  const now = chainTs ?? Math.floor(Date.now() / 1000);
  const sequencer = await readSequencer(now);

  // Four token reads per asset, plus one feed read for the assets that have one.
  const calls: Call[] = [];
  const index: { symbol: string; kind: string }[] = [];
  for (const asset of assets) {
    for (const selector of [
      SELECTORS.uiMultiplier,
      SELECTORS.newUIMultiplier,
      SELECTORS.effectiveAt,
      SELECTORS.oraclePaused,
    ]) {
      calls.push({ to: asset.contract, data: selector });
      index.push({ symbol: asset.symbol, kind: selector });
    }
    const cfg = feedFor(asset.symbol);
    if (cfg) {
      calls.push({ to: cfg.feed, data: SELECTORS.latestRoundData });
      index.push({ symbol: asset.symbol, kind: "feed" });
    }
  }

  const results = await ethCallBatch(calls);
  const byAsset = new Map<string, Record<string, string | null>>();
  for (let i = 0; i < index.length; i++) {
    const { symbol, kind } = index[i];
    const bucket = byAsset.get(symbol) ?? {};
    bucket[kind] = results[i];
    byAsset.set(symbol, bucket);
  }

  const out: AssetOracleState[] = assets.map((asset) => {
    const bucket = byAsset.get(asset.symbol) ?? {};
    const cfg = feedFor(asset.symbol);

    // FAIL CLOSED, matching ShareExactGuard.multiplierOf. An unreadable
    // multiplier is not evidence of a 1:1 token, it is evidence that the ratio
    // is unknown, and the two are indistinguishable from a failed staticcall.
    const multiplierRaw = decodeUint(bucket[SELECTORS.uiMultiplier]);
    const unitAvailable = multiplierRaw !== null && multiplierRaw > 0n;
    const multiplier = unitAvailable ? (multiplierRaw as bigint) : 0n;
    const pendingRaw = decodeUint(bucket[SELECTORS.newUIMultiplier]);
    const effectiveRaw = decodeUint(bucket[SELECTORS.effectiveAt]);
    const paused = decodeBool(bucket[SELECTORS.oraclePaused]) ?? false;

    const round = cfg ? decodeRoundData(bucket.feed) : null;
    const decimals = cfg?.decimals ?? DEFAULT_FEED_DECIMALS;
    const price = round && round.answer > 0n ? scaleAnswer(round.answer, decimals) : null;
    const updatedAt = round && round.updatedAt > 0n ? Number(round.updatedAt) : null;
    const effectiveAt = effectiveRaw !== null && effectiveRaw > 0n ? Number(effectiveRaw) : null;

    const dataState = classifyDataState({
      sequencerOk: sequencer.ok,
      hasFeed: Boolean(cfg),
      updatedAt,
      price,
      now,
      maxStaleness: cfg?.maxStaleness ?? 0,
      oraclePaused: paused,
      // Pass both through even when the current multiplier could not be read.
      // classifyDataState matches the guard: unreadable pending + future
      // effectiveAt is CORP_ACTION; a readable pending against an unreadable
      // current is not.
      effectiveAt,
      multiplier,
      pendingMultiplier: pendingRaw,
      corpActionWindow: CORP_ACTION_WINDOW,
    });

    return {
      symbol: asset.symbol,
      contract: asset.contract,
      feed: cfg?.feed ?? null,
      price,
      decimals,
      updatedAt,
      ageSeconds: updatedAt ? Math.max(0, now - updatedAt) : null,
      multiplier: unitAvailable ? formatFixed(multiplier) : null,
      pendingMultiplier: pendingRaw !== null ? formatFixed(pendingRaw) : null,
      effectiveAt,
      oraclePaused: paused,
      dataState,
      unitAvailable,
    };
  });

  return {
    ...base,
    ok: true,
    chainTime: now,
    sequencerOk: sequencer.ok,
    sequencerConfigured: sequencer.configured,
    assets: out,
  };
}

export const fetchOracleState = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ symbols: z.array(z.string().min(1).max(12)).max(60) }).parse(input),
  )
  .handler(async ({ data }) => readOracleState(data.symbols));
