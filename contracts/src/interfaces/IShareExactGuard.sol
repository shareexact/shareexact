// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Trust state of the data a contract would price a Stock Token with.
/// @dev This enum is deliberately about DATA, not about the NYSE calendar.
///      A contract cannot know that "the market is closed" — it can only know
///      that the feed stopped updating, that the sequencer is down, that the
///      issuer paused the oracle, or that a multiplier change is imminent.
///      Session labelling (open / pre / after / overnight / weekend) is an
///      off-chain concern and lives in the ShareExact SDK, not here.
enum DataState {
    /// Price is fresh, no pause, no imminent multiplier change.
    FRESH,
    /// Feed has not updated within its configured staleness bound.
    /// Expected every weekend and US market holiday: Robinhood equity feeds
    /// publish 24/5 and hold the last value when the underlying market is shut.
    STALE,
    /// Issuer raised `oraclePaused()` on the token (corporate action in flight).
    ORACLE_PAUSED,
    /// A pending `newUIMultiplier()` activates within `corpActionWindow()`.
    CORP_ACTION,
    /// L2 sequencer uptime feed reports down, or the grace period has not elapsed.
    SEQUENCER_DOWN,
    /// No price feed registered for this token.
    NO_FEED
}

interface IShareExactGuard {
    /// @notice Data trust state for `token`. Never reverts.
    function state(address token) external view returns (DataState);

    /// @notice Latest price for `token` together with its trust state. Never reverts.
    /// @return price     Price of ONE token (already multiplier-adjusted by the feed).
    /// @return decimals_ Feed decimals.
    /// @return updatedAt Feed `updatedAt` timestamp (0 when unavailable).
    /// @return dataState Trust state at the time of the call.
    function priceOf(address token)
        external
        view
        returns (uint256 price, uint8 decimals_, uint256 updatedAt, DataState dataState);

    /// @notice Reverts unless `state(token) == DataState.FRESH`.
    function requireFresh(address token) external view;

    /// @notice Current, pending and activation time of the ERC-8056 multiplier.
    function multiplierOf(address token)
        external
        view
        returns (uint256 current, uint256 pending, uint256 effectiveAt);

    /// @notice Underlying shares -> raw token units (floor).
    function sharesToRaw(address token, uint256 uiShares) external view returns (uint256 raw);

    /// @notice Raw token units -> underlying shares (floor).
    function rawToShares(address token, uint256 raw) external view returns (uint256 uiShares);

    /// @notice USD value of `raw` units, scaled to 18 decimals.
    /// @param allowStale When false the call reverts unless the state is FRESH.
    function usdValue(address token, uint256 raw, bool allowStale) external view returns (uint256 value18);

    /// @notice Seconds before a scheduled multiplier change that the guard starts reporting CORP_ACTION.
    function corpActionWindow() external view returns (uint64);

    /// @notice Is a multiplier change scheduled inside the window, independent of price state?
    /// @dev `state()` is single-valued and `STALE` / `ORACLE_PAUSED` outrank
    ///      `CORP_ACTION` inside it, so a consumer branching on the enum can
    ///      miss a pending unit change precisely when the price is also
    ///      unhealthy. This answers the unit question on its own. It does not
    ///      read the feed registry, the staleness bound, or the sequencer feed,
    ///      and it does not revert. It does use `corpActionWindow()`, which the
    ///      owner can set between 10 minutes and 7 days. When `newUIMultiplier()`
    ///      cannot be read, the window is ignored and any future `effectiveAt`
    ///      is imminent. Anything that moves units rather than prices should use
    ///      this instead of branching on `CORP_ACTION`.
    /// @return imminent    True when a scheduled change should block a unit move.
    /// @return effectiveAt The token's `effectiveAt`; 0 when unset or unreadable.
    function unitChangeImminent(address token) external view returns (bool imminent, uint256 effectiveAt);
}
