/**
 * The off-chain twin of `ShareExactGuard.sol`.
 *
 * The precedence order below is identical to `_evaluate()` in the contract and
 * is enforced by `market-state.test.ts`. If the two ever drift, an integrator
 * reading the UI and an integrator reading the chain would disagree about
 * whether a price can be trusted, which is the exact failure this product
 * exists to prevent.
 *
 * Two separate ideas live here and are deliberately not merged:
 *
 *   DataState    — can this price be trusted right now. Derived only from what
 *                  a contract can observe: sequencer, feed age, pause flag,
 *                  pending multiplier.
 *   SessionKind  — what humans call this time of day. Derived from the NYSE
 *                  calendar, which no contract can know.
 *
 * A weekend is not a failure. It is a normal, expected STALE window, and the
 * product's job is to say so out loud instead of showing a Friday price as if
 * it were live.
 */

export type DataState =
  | "FRESH"
  | "STALE"
  | "ORACLE_PAUSED"
  | "CORP_ACTION"
  | "SEQUENCER_DOWN"
  | "NO_FEED";

export interface ClassifyInput {
  /** Chainlink L2 sequencer uptime: true when up and past the grace period. */
  sequencerOk: boolean;
  /** Feed address configured for this token. */
  hasFeed: boolean;
  /** Feed `updatedAt`, unix seconds. */
  updatedAt: number | null;
  /** Feed answer scaled to a number. Non-positive is treated as no answer. */
  price: number | null;
  /** Chain head timestamp, unix seconds. */
  now: number;
  /** Seconds after which the answer is considered stale. */
  maxStaleness: number;
  /** Advisory `oraclePaused()` on the token. */
  oraclePaused: boolean;
  /** Scheduled multiplier activation, unix seconds (0 or null when none). */
  effectiveAt: number | null;
  /** Current and pending multipliers, 18-decimal fixed point as strings. */
  multiplier: bigint;
  pendingMultiplier: bigint | null;
  /** Seconds before `effectiveAt` at which CORP_ACTION is reported. */
  corpActionWindow: number;
}

export function classifyDataState(input: ClassifyInput): DataState {
  // 1. Chain liveness. Nothing else is meaningful while the sequencer is down.
  if (!input.sequencerOk) return "SEQUENCER_DOWN";

  // 2. A missing price feed does not make the unit safe. Transfers read the
  //    multiplier, not the price, so a pending split is CORP_ACTION even when
  //    no aggregator is registered.
  if (!input.hasFeed) {
    if (unitChangeImminent(input)) return "CORP_ACTION";
    return "NO_FEED";
  }

  // 3. A missing or non-positive answer is indistinguishable from a dead feed.
  if (input.price === null || input.price <= 0 || !input.updatedAt) return "STALE";

  // 3b. A timestamp in the future is a broken or hostile feed, not a fresher
  //     one. Mirrors the same check in ShareExactGuard._evaluate.
  if (input.updatedAt > input.now) return "STALE";

  // 4. Staleness is the primary guard and outranks the advisory pause flag.
  if (input.now > input.updatedAt && input.now - input.updatedAt > input.maxStaleness) return "STALE";

  // 5. Advisory issuer flag.
  if (input.oraclePaused) return "ORACLE_PAUSED";

  // 6. Imminent corporate action. A scheduled no-op does not count.
  if (unitChangeImminent(input)) return "CORP_ACTION";

  return "FRESH";
}

export function unitChangeImminent(input: ClassifyInput): boolean {
  // Same order as ShareExactGuard._corpActionImminent. An unreadable pending
  // multiplier fails closed for any future effectiveAt, before the window.
  // The window applies only once both multipliers can be compared.
  if (input.effectiveAt == null || input.effectiveAt <= input.now) return false;
  if (input.pendingMultiplier === null) return true;
  // 0n is "current multiplier could not be read", which the contract treats as
  // not imminent once the pending value itself was readable (`!okCur`).
  if (input.multiplier === 0n || input.pendingMultiplier === input.multiplier) return false;
  return input.effectiveAt - input.now <= input.corpActionWindow;
}

/** True when a price may be shown as a live mark rather than a historical one. */
export function isTradeable(state: DataState): boolean {
  return state === "FRESH";
}

/**
 * True when a share conversion may be sent.
 *
 * `STALE` by itself does not block. `STALE` together with a scheduled unit
 * change does, and the label hides that second fact, so it is passed in.
 *
 * The third input is the ratio itself. A token whose `uiMultiplier()` cannot be
 * read comes back as `0n`, `unitChangeImminent` is false for it, and the label
 * can be anything — so without this check the predicate answered "executable"
 * about a token `ExactTransfer.transferShares` refuses outright with
 * `UnitUnavailable`. Fail closed here for the same reason the contract and the
 * preflight do: an unreadable ratio is not evidence of a 1:1 token.
 */
export function isShareConversionExecutable(input: {
  dataState: DataState;
  unitChangeImminent: boolean;
  /** Current ratio, 18-decimal fixed point. Zero means it could not be read. */
  multiplier: bigint;
}): boolean {
  if (input.dataState === "SEQUENCER_DOWN" || input.dataState === "CORP_ACTION") return false;
  // A positive test, so an omitted field (a JavaScript caller written against
  // the older two-field shape) refuses rather than passes.
  if (!(input.multiplier > 0n)) return false;
  return !input.unitChangeImminent;
}

/** @deprecated Too broad a name. Use `isShareConversionExecutable`. */
export const isTransferSafe = isShareConversionExecutable;

export const STATE_LABEL: Record<DataState, { short: string; detail: string }> = {
  FRESH: {
    short: "Live",
    detail: "Feed updated within its heartbeat. Price can be marked and borrowed against.",
  },
  STALE: {
    short: "Held",
    detail:
      "The feed is holding its last value. Robinhood equity feeds publish 24/5, so this is the normal state on weekends, holidays and thin overnight windows — the tokens keep trading, the price does not.",
  },
  ORACLE_PAUSED: {
    short: "Paused",
    detail:
      "The issuer raised oraclePaused() while a corporate action is processed. Advisory only, so the staleness check still governs.",
  },
  CORP_ACTION: {
    short: "Corp action",
    detail:
      "A new uiMultiplier activates shortly. Share-denominated quotes made now could settle against a different ratio.",
  },
  SEQUENCER_DOWN: {
    short: "Sequencer down",
    detail: "The L2 sequencer is down or inside its grace period. No reading can be trusted.",
  },
  NO_FEED: {
    short: "No feed",
    detail: "No Chainlink feed is registered for this token, so ShareExact will not invent a price.",
  },
};

/** Human-readable age, e.g. "39h ago". Used to make staleness impossible to miss. */
export function formatAge(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 90) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  const days = seconds / 86_400;
  return `${days.toFixed(days < 10 ? 1 : 0)}d ago`;
}
