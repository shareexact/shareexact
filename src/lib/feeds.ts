/**
 * Chainlink feed addresses for Robinhood Chain Stock Tokens.
 *
 * Deliberately NOT hardcoded in source. Robinhood's docs state that Chainlink's
 * published feed list is the source of truth and that integrators should read
 * addresses and parameters from there rather than pinning them, so this module
 * resolves feeds in three steps and refuses to guess:
 *
 *   1. `ROBINHOOD_FEEDS` env var — JSON, highest priority, lets an operator
 *      patch a feed without a redeploy.
 *   2. `src/lib/feeds.generated.json` — written by `npm run feeds:sync`.
 *   3. Nothing. An asset with no feed is reported as NO_FEED and rendered
 *      without a price.
 *
 * Step 3 is the important one. The previous build shipped indicative marks that
 * looked exactly like live prices; a risk engine fed by invented numbers is
 * worse than one with no numbers, because it is confidently wrong.
 */

import { readEnv, readEnvNumber } from "./env";
import generated from "./feeds.generated.json";

export interface FeedConfig {
  /** Chainlink aggregator proxy address on chain 4663. */
  feed: string;
  /**
   * Seconds after which the answer is treated as stale.
   *
   * Sizing note: Robinhood equity feeds are 24/5 and explicitly have no
   * heartbeat during off-hours, so a bound tighter than roughly one day makes
   * every weekend read STALE. 26h is the default: long enough to survive a
   * normal overnight gap, short enough to catch a genuinely dead feed.
   */
  maxStaleness: number;
  /** Feed decimals. 8 for USD feeds unless the directory says otherwise. */
  decimals: number;
}

export const DEFAULT_MAX_STALENESS = 26 * 60 * 60;
export const DEFAULT_FEED_DECIMALS = 8;

/** Chainlink L2 Sequencer Uptime Feed. Empty disables the check. */
export const SEQUENCER_FEED = readEnv("ROBINHOOD_SEQUENCER_FEED") ?? "";
export const SEQUENCER_GRACE_PERIOD = readEnvNumber("ROBINHOOD_SEQUENCER_GRACE", 1800);

/** Seconds before a scheduled multiplier change at which CORP_ACTION is reported. */
export const CORP_ACTION_WINDOW = readEnvNumber("ROBINHOOD_CORP_ACTION_WINDOW", 7200);

interface GeneratedShape {
  generatedAt?: string | null;
  source?: string;
  feeds?: Record<string, unknown>;
}

/** The generated file is data, not code: it is validated, never trusted. */
const generatedFile = generated as unknown as GeneratedShape;

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

function normalise(raw: Record<string, unknown> | undefined): Record<string, FeedConfig> {
  const out: Record<string, FeedConfig> = {};
  if (!raw) return out;
  for (const [symbol, value] of Object.entries(raw)) {
    const entry = typeof value === "string" ? { feed: value } : (value as Partial<FeedConfig>);
    const feed = entry?.feed;
    if (!feed || !ADDRESS.test(feed) || /^0x0{40}$/i.test(feed)) continue;
    out[symbol.toUpperCase()] = {
      feed,
      maxStaleness: Number(entry.maxStaleness) > 0 ? Number(entry.maxStaleness) : DEFAULT_MAX_STALENESS,
      decimals: Number.isInteger(entry.decimals) ? Number(entry.decimals) : DEFAULT_FEED_DECIMALS,
    };
  }
  return out;
}

function fromEnv(): Record<string, FeedConfig> {
  const raw = readEnv("ROBINHOOD_FEEDS");
  if (!raw) return {};
  try {
    return normalise(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return {};
  }
}

const generatedFeeds = normalise(generatedFile.feeds);

export const FEEDS: Record<string, FeedConfig> = { ...generatedFeeds, ...fromEnv() };

export const FEEDS_SOURCE = generatedFile.source ?? "unset";
export const FEEDS_GENERATED_AT = generatedFile.generatedAt ?? null;

export function feedFor(symbol: string): FeedConfig | null {
  return FEEDS[symbol.toUpperCase()] ?? null;
}

export function feedCount(): number {
  return Object.keys(FEEDS).length;
}
