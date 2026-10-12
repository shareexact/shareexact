// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {DataState, IShareExactGuard} from "./interfaces/IShareExactGuard.sol";

/// @title ExactTransfer
/// @notice Move an exact number of *underlying shares* of a Robinhood Stock
///         Token, instead of an exact number of raw ERC-20 units.
///
/// @dev Why this exists.
///
///      A Stock Token is a plain ERC-20 whose raw unit is not one share. One
///      raw unit is `uiMultiplier() / 1e18` shares, and that ratio moves every
///      time a dividend is reinvested or the underlying splits. Every wallet on
///      the chain quotes raw units, which is correct. Every product that quotes
///      *shares* — lending markets, baskets, structured products, anything that
///      shows a user "you hold 12 NVDA" — has to do the conversion itself, and
///      each one gets to invent its own rounding, its own staleness policy and
///      its own corporate-action race condition.
///
///      This contract is that conversion, once, on-chain, with the race
///      conditions closed:
///
///      - The multiplier is read at execution time, in the same transaction as
///        the transfer, so a quote built minutes ago in a browser cannot settle
///        against a ratio that has since changed.
///      - If a scheduled multiplier change is about to activate, the transfer
///        reverts rather than settling across the boundary.
///      - Rounding is floor, and the caller states the share shortfall it will
///        accept, so a silent truncation cannot pass unnoticed.
///
///      Deliberately NOT in scope: custody, allowances held by this contract,
///      upgradeability, admin keys, pausing. The contract holds no balance and
///      has no privileged role. It can be read end to end in a few minutes,
///      which is the point.
///
///      Price freshness is NOT required here. A transfer does not need to know
///      what the share is worth, only how many raw units make up a share. The
///      guard states that matter to a transfer are the ones that affect the
///      multiplier, not the ones that affect the price — which is why a weekend
///      (STALE) transfer is allowed and a pending-split (CORP_ACTION) transfer
///      is not.
contract ExactTransfer {
    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error ZeroAmount();
    error MultiplierChangePending(address token, uint256 effectiveAt);
    error SequencerDown();
    error ShareShortfall(uint256 requestedShares, uint256 deliveredShares, uint256 maxShortfall);
    error TransferFailed(address token);
    error InsufficientShareBalance(uint256 haveRaw, uint256 needRaw);
    error UnitUnavailable(address token);

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @param uiShares        Shares the sender asked to move.
    /// @param deliveredShares Shares actually represented by `raw` after floor rounding.
    /// @param raw             Raw ERC-20 units moved.
    /// @param multiplier      ERC-8056 multiplier used, captured at execution time.
    /// @param maxShortfall    Rounding loss the sender declared acceptable.
    ///
    /// @dev `maxShortfall` is in the log because it is the consent record. The
    ///      difference between `uiShares` and `deliveredShares` is what the
    ///      sender lost; this field is what they agreed to lose beforehand.
    ///      Without it an indexer can see the loss but cannot tell an accepted
    ///      rounding from an unnoticed one.
    event ExactShareTransfer(
        address indexed token,
        address indexed from,
        address indexed to,
        uint256 uiShares,
        uint256 deliveredShares,
        uint256 raw,
        uint256 multiplier,
        uint256 maxShortfall
    );

    /*//////////////////////////////////////////////////////////////
                                IMMUTABLE
    //////////////////////////////////////////////////////////////*/

    uint256 internal constant WAD = 1e18;

    IShareExactGuard public immutable guard;

    constructor(IShareExactGuard guard_) {
        if (address(guard_) == address(0)) revert ZeroAddress();
        guard = guard_;
    }

    /*//////////////////////////////////////////////////////////////
                                 QUOTES
    //////////////////////////////////////////////////////////////*/

    /// @notice What `transferShares` would do right now. Never reverts.
    /// @return raw              Raw units that would move.
    /// @return deliveredShares  Shares those raw units represent after flooring.
    /// @return multiplier       Multiplier that would be used.
    /// @return dataState        Guard state, for display.
    /// @return executable       False when the guard state blocks execution.
    function quote(address token, uint256 uiShares)
        external
        view
        returns (
            uint256 raw,
            uint256 deliveredShares,
            uint256 multiplier,
            DataState dataState,
            bool executable
        )
    {
        (multiplier,,) = guard.multiplierOf(token);
        dataState = guard.state(token);
        // An unreadable multiplier is not a pricing problem, it is a unit
        // problem: nothing can be quoted at all, so the quote reports
        // not-executable instead of inventing a 1:1 ratio.
        if (multiplier == 0) return (0, 0, 0, dataState, false);

        // `Math.mulDiv` reverts on overflow and this function is documented
        // never to. The product can only overflow when the multiplier is below
        // 1.0, and the bound itself is always representable.
        if (multiplier < WAD && uiShares > Math.mulDiv(type(uint256).max, multiplier, WAD)) {
            return (0, 0, multiplier, dataState, false);
        }

        raw = Math.mulDiv(uiShares, WAD, multiplier);
        deliveredShares = Math.mulDiv(raw, multiplier, WAD);

        // The unit question is put to the token, not inferred from the enum.
        // `STALE` and `ORACLE_PAUSED` outrank `CORP_ACTION` inside `state()`, so
        // reading executability off the enum advertised a pending split as
        // executable whenever the feed also happened to be stale or paused.
        (bool unitMoving,) = guard.unitChangeImminent(token);

        // A zero request is not executable: `transferShares` reverts
        // `ZeroAmount`. Nor is one that floors away to nothing.
        executable =
            uiShares != 0 && raw != 0 && !unitMoving && dataState != DataState.SEQUENCER_DOWN;
    }

    /// @notice Largest whole share amount `holder` can send without a shortfall.
    /// @dev Observation-class: never reverts. An unreadable multiplier or a
    ///      reverting `balanceOf` returns 0 rather than bubbling up — `quote`
    ///      already treats those as not-executable, and a view that throws when
    ///      the token is hostile is useless to an integrator sizing a send.
    function maxShares(address token, address holder) external view returns (uint256) {
        (uint256 current,,) = guard.multiplierOf(token);
        if (current == 0) return 0;
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(IERC20.balanceOf.selector, holder));
        if (!ok || data.length < 32) return 0;
        uint256 rawBalance = abi.decode(data, (uint256));
        return Math.mulDiv(rawBalance, current, WAD);
    }

    /// @notice Scope statement, on-chain and machine-readable.
    /// @dev True only for tokens that expose a readable ERC-8056 multiplier.
    ///      This contract is for canonical Stock Tokens; it is not a generic
    ///      exact-share primitive for arbitrary ERC-20s, and it says so rather
    ///      than assuming 1:1 for anything it does not understand.
    function isSupported(address token) external view returns (bool) {
        (uint256 current,,) = guard.multiplierOf(token);
        return current > 0;
    }

    /*//////////////////////////////////////////////////////////////
                                EXECUTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Move exactly `uiShares` underlying shares of `token` to `to`.
    /// @dev Requires the caller to have approved this contract for the raw
    ///      amount. The contract never holds a balance between transactions.
    /// @param maxShortfall Shares the caller accepts losing to floor rounding.
    ///        Pass 0 to demand an exactly representable amount.
    /// @return raw Raw units moved.
    function transferShares(address token, address to, uint256 uiShares, uint256 maxShortfall)
        external
        returns (uint256 raw)
    {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (uiShares == 0) revert ZeroAmount();

        // Chain liveness still comes from the enum: that one genuinely is a
        // property of the chain, not of the token.
        if (guard.state(token) == DataState.SEQUENCER_DOWN) revert SequencerDown();

        // The unit check is asked separately and on purpose. Reading it off
        // `state()` meant a pending activation went unseen whenever the price
        // feed was STALE or the issuer had raised ORACLE_PAUSED, because a
        // single-valued enum has to pick one answer and price outranks unit
        // inside it. This contract does not care about the price at all; it
        // cares only how many raw units make a share, so it asks that directly.
        (bool unitMoving, uint256 effectiveAt) = guard.unitChangeImminent(token);
        if (unitMoving) revert MultiplierChangePending(token, effectiveAt);

        (uint256 multiplier,,) = guard.multiplierOf(token);
        // Fail closed. If the token will not tell us how many raw units make a
        // share, we do not move raw units.
        if (multiplier == 0) revert UnitUnavailable(token);
        raw = Math.mulDiv(uiShares, WAD, multiplier);

        // Shortfall is computed and checked BEFORE the zero-amount guard, so a
        // request that floors all the way down to nothing is reported as the
        // rounding problem it is rather than as a malformed input.
        uint256 delivered = Math.mulDiv(raw, multiplier, WAD);
        uint256 shortfall = uiShares > delivered ? uiShares - delivered : 0;
        if (shortfall > maxShortfall) revert ShareShortfall(uiShares, delivered, maxShortfall);
        if (raw == 0) revert ZeroAmount();

        uint256 senderRaw = IERC20(token).balanceOf(msg.sender);
        if (senderRaw < raw) revert InsufficientShareBalance(senderRaw, raw);

        _safeTransferFrom(token, msg.sender, to, raw);

        emit ExactShareTransfer(token, msg.sender, to, uiShares, delivered, raw, multiplier, maxShortfall);
    }

    /// @dev Handles both the bool-returning and the non-standard void ERC-20.
    function _safeTransferFrom(address token, address from, address to, uint256 value) internal {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, value));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed(token);
    }
}
