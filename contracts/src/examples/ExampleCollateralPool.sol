// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../interfaces/IERC20.sol";
import {DataState, IShareExactGuard} from "../interfaces/IShareExactGuard.sol";

/// @title ExampleCollateralPool
/// @notice A deliberately tiny lending pool, included to answer one question a
///         reviewer is entitled to ask: is `ShareExactGuard` actually a
///         primitive other protocols can build on, or is it infrastructure in
///         name only, consumed by nothing but its own front end?
///
/// @dev This is an EXAMPLE. It is not deployed, not audited, has no interest
///      model, no liquidation incentive and no oracle for the debt asset. What
///      it does have is every call a real money market would have to make, and
///      it makes them in the order the guard is designed for:
///
///        deposit   → guard.state()      must be FRESH to value new collateral
///        borrow    → guard.usdValue()   strict, reverts on stale
///        health    → guard.usdValue()   allowStale, so a UI can always render
///        liquidate → guard.state()      must be FRESH; refuses on a stale feed
///
///      The interesting line is the last one. A conventional money market
///      liquidates whenever the health factor says so, and on this chain the
///      health factor is computed from a feed that stops updating at the closing
///      bell and resumes at the opening bell. A position marked against a Friday
///      price is not safe to liquidate on a Sunday: nothing has been observed
///      since, and Monday's open can gap either way. So this pool declines to
///      liquidate on stale data and says why.
///
///      That is the whole argument of ShareExact expressed in fifty lines of
///      somebody else's contract.
contract ExampleCollateralPool {
    error NotFresh(address token, DataState state);
    error Undercollateralised(uint256 valueUsd18, uint256 debtUsd18);
    error HealthyPosition(uint256 valueUsd18, uint256 debtUsd18);
    error NothingDeposited();
    error TransferFailed();

    event Deposited(address indexed user, address indexed token, uint256 raw, uint256 shares);
    event Borrowed(address indexed user, uint256 amountUsd18);
    event Liquidated(address indexed user, address indexed keeper, uint256 seizedRaw);
    /// @notice Emitted when a liquidation is declined because the mark is stale.
    event LiquidationDeclined(address indexed user, DataState state, uint256 markAge);

    /// Loan-to-value, in basis points. 50% for a single-name equity.
    uint256 public constant MAX_LTV_BPS = 5_000;
    /// Liquidation threshold, in basis points.
    uint256 public constant LIQUIDATION_BPS = 7_500;

    IShareExactGuard public immutable guard;
    address public immutable collateral;

    mapping(address user => uint256 raw) public collateralRaw;
    mapping(address user => uint256 usd18) public debtUsd18;

    constructor(IShareExactGuard guard_, address collateral_) {
        guard = guard_;
        collateral = collateral_;
    }

    /// @notice Deposit Stock Tokens as collateral.
    /// @dev New collateral is only accepted against an observed price. The
    ///      share figure in the event comes from the guard, not from a local
    ///      conversion, so this pool can never disagree with the desk about how
    ///      many shares a user deposited.
    function deposit(uint256 raw) external {
        _requireFresh();
        _safeTransferFrom(msg.sender, address(this), raw);
        collateralRaw[msg.sender] += raw;
        emit Deposited(msg.sender, collateral, raw, guard.rawToShares(collateral, raw));
    }

    /// @notice Borrow against deposited collateral.
    /// @dev `allowStale = false`: taking on new debt is exactly the moment to
    ///      insist on an observed price.
    function borrow(uint256 amountUsd18) external {
        uint256 raw = collateralRaw[msg.sender];
        if (raw == 0) revert NothingDeposited();

        uint256 value = guard.usdValue(collateral, raw, false);
        uint256 newDebt = debtUsd18[msg.sender] + amountUsd18;
        if (newDebt * 10_000 > value * MAX_LTV_BPS) revert Undercollateralised(value, newDebt);

        debtUsd18[msg.sender] = newDebt;
        emit Borrowed(msg.sender, amountUsd18);
    }

    /// @notice Health of a position, for display.
    /// @dev `allowStale = true`, and the staleness is returned alongside so a UI
    ///      can show "as of Friday" instead of a blank. A risk screen that
    ///      reverts every weekend is a risk screen nobody trusts.
    function health(address user)
        external
        view
        returns (uint256 valueUsd18, uint256 debt, DataState state, uint256 markAge)
    {
        uint256 raw = collateralRaw[user];
        valueUsd18 = raw == 0 ? 0 : guard.usdValue(collateral, raw, true);
        debt = debtUsd18[user];
        uint256 updatedAt;
        (, , updatedAt, state) = guard.priceOf(collateral);
        markAge = updatedAt == 0 || updatedAt > block.timestamp ? 0 : block.timestamp - updatedAt;
    }

    /// @notice Seize collateral from an unhealthy position.
    /// @dev Refuses on anything but FRESH. This is the line that makes the pool
    ///      different from a naive port of a crypto money market: it will not
    ///      liquidate a position on a price the market has not printed since the
    ///      closing bell.
    function liquidate(address user) external {
        DataState state = guard.state(collateral);
        if (state != DataState.FRESH) {
            (, , uint256 updatedAt, ) = guard.priceOf(collateral);
            emit LiquidationDeclined(
                user, state, updatedAt == 0 ? 0 : block.timestamp - updatedAt
            );
            revert NotFresh(collateral, state);
        }

        uint256 raw = collateralRaw[user];
        uint256 value = guard.usdValue(collateral, raw, false);
        uint256 debt = debtUsd18[user];
        if (debt * 10_000 <= value * LIQUIDATION_BPS) revert HealthyPosition(value, debt);

        collateralRaw[user] = 0;
        debtUsd18[user] = 0;
        _safeTransfer(msg.sender, raw);
        emit Liquidated(user, msg.sender, raw);
    }

    /// @dev Slither's `unchecked-transfer` fired on the first version of this
    ///      example, correctly: a token that returns false on failure would have
    ///      let a deposit book collateral that never arrived. Fixed here rather
    ///      than waved away, because an example whose static analysis is dirty
    ///      teaches the wrong lesson.
    function _safeTransferFrom(address from, address to, uint256 value) internal {
        (bool ok, bytes memory data) = collateral.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, value)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransfer(address to, uint256 value) internal {
        (bool ok, bytes memory data) =
            collateral.call(abi.encodeWithSelector(IERC20.transfer.selector, to, value));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _requireFresh() internal view {
        DataState state = guard.state(collateral);
        if (state != DataState.FRESH) revert NotFresh(collateral, state);
    }
}
