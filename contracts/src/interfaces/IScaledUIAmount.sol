// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ERC-8056 (Scaled UI Amount Extension) core surface.
/// @dev Robinhood Stock Tokens keep raw balances static and express corporate
///      actions (reinvested dividends, splits) through `uiMultiplier()`.
///      One raw token represents `uiMultiplier() / 1e18` underlying shares.
interface IScaledUIAmount {
    /// @notice Current UI multiplier, 18 decimals. 1e18 == 1.0.
    function uiMultiplier() external view returns (uint256);

    event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp);

    event TransferWithScaledUI(address indexed from, address indexed to, uint256 value, uint256 uiValue);
}

/// @notice Scheduled (pending) multiplier change, readable before it activates.
interface IScaledUIAmountNewUIMultiplier {
    /// @notice Multiplier that becomes active at `effectiveAt()`.
    function newUIMultiplier() external view returns (uint256);

    /// @notice Timestamp at which `newUIMultiplier()` becomes `uiMultiplier()`.
    function effectiveAt() external view returns (uint256);
}

/// @notice UI-adjusted (underlying-share denominated) views.
interface IScaledUIAmountBalances {
    function balanceOfUI(address account) external view returns (uint256);
    function totalSupplyUI() external view returns (uint256);
}

/// @notice Robinhood-specific advisory flag raised while a corporate action is processed.
/// @dev Per Robinhood Chain docs the flag is advisory and NOT enforced on-chain,
///      so a paused oracle may still return a value. Staleness remains the primary guard.
interface IOraclePausable {
    function oraclePaused() external view returns (bool);
}
