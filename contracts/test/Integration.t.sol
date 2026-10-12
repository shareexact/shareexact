// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ExampleCollateralPool} from "../src/examples/ExampleCollateralPool.sol";
import {ShareExactGuard} from "../src/ShareExactGuard.sol";
import {DataState, IShareExactGuard} from "../src/interfaces/IShareExactGuard.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";
import {MockFeed} from "./mocks/MockFeed.sol";

/// @notice Proof that `ShareExactGuard` is consumable by a protocol that is not
///         `ExactTransfer` and not the desk. Everything here exercises the guard
///         through a third-party contract's own public API.
contract IntegrationTest is Test {
    ShareExactGuard internal guard;
    ExampleCollateralPool internal pool;
    MockStockToken internal nvda;
    MockFeed internal feed;

    address internal constant OWNER = address(0xA11CE);
    address internal constant ALICE = address(0xA1);
    address internal constant KEEPER = address(0xCAFE);
    uint64 internal constant STALENESS = 26 hours;

    function setUp() public {
        vm.warp(1_800_000_000);
        guard = new ShareExactGuard(OWNER, 2 hours);
        nvda = new MockStockToken("NVIDIA Stock Token", "NVDA", 1e18);
        feed = new MockFeed(8, 100_00_000_000, block.timestamp); // $100.00
        vm.prank(OWNER);
        guard.setFeed(address(nvda), address(feed), STALENESS);

        pool = new ExampleCollateralPool(IShareExactGuard(address(guard)), address(nvda));

        nvda.mint(ALICE, 10e18); // 10 tokens, $1,000
        vm.prank(ALICE);
        nvda.approve(address(pool), type(uint256).max);
    }

    function _deposit() internal {
        vm.prank(ALICE);
        pool.deposit(10e18);
    }

    function test_depositAndBorrowWithinLtv() public {
        _deposit();
        vm.prank(ALICE);
        pool.borrow(400e18); // 40% of $1,000
        assertEq(pool.debtUsd18(ALICE), 400e18);
    }

    function test_borrowBeyondLtvIsRejected() public {
        _deposit();
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(ExampleCollateralPool.Undercollateralised.selector, 1_000e18, 600e18)
        );
        pool.borrow(600e18);
    }

    /// New debt demands an observed price.
    function test_borrowRefusedOnStaleMark() public {
        _deposit();
        vm.warp(block.timestamp + 50 hours);
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(ShareExactGuard.DataNotFresh.selector, address(nvda), DataState.STALE)
        );
        pool.borrow(100e18);
    }

    /// The health screen must keep rendering all weekend, with the age attached.
    function test_healthStillReadableWhileStale() public {
        _deposit();
        vm.prank(ALICE);
        pool.borrow(400e18);

        vm.warp(block.timestamp + 50 hours);
        (uint256 value, uint256 debt, DataState state, uint256 age) = pool.health(ALICE);
        assertEq(value, 1_000e18);
        assertEq(debt, 400e18);
        assertEq(uint256(state), uint256(DataState.STALE));
        assertEq(age, 50 hours);
    }

    /// The point of the whole exercise: a position that looks liquidatable on a
    /// Friday price is not liquidated on a Sunday, because nothing has been
    /// observed since and Monday can gap either way.
    function test_liquidationRefusedOnStaleMark() public {
        _deposit();
        vm.prank(ALICE);
        pool.borrow(500e18);

        // Price halves, then the market closes and the feed stops printing.
        feed.set(50_00_000_000, block.timestamp);
        vm.warp(block.timestamp + 50 hours);

        vm.prank(KEEPER);
        vm.expectRevert(
            abi.encodeWithSelector(ExampleCollateralPool.NotFresh.selector, address(nvda), DataState.STALE)
        );
        pool.liquidate(ALICE);
    }

    /// And once the market reopens and the feed prints again, it liquidates.
    function test_liquidationProceedsOnceFeedResumes() public {
        _deposit();
        vm.prank(ALICE);
        pool.borrow(500e18);

        feed.set(50_00_000_000, block.timestamp);
        vm.warp(block.timestamp + 50 hours);
        feed.set(50_00_000_000, block.timestamp); // opening print

        vm.prank(KEEPER);
        pool.liquidate(ALICE);
        assertEq(nvda.balanceOf(KEEPER), 10e18);
        assertEq(pool.debtUsd18(ALICE), 0);
    }

    function test_healthyPositionCannotBeLiquidated() public {
        _deposit();
        vm.prank(ALICE);
        pool.borrow(400e18);
        vm.prank(KEEPER);
        vm.expectRevert(
            abi.encodeWithSelector(ExampleCollateralPool.HealthyPosition.selector, 1_000e18, 400e18)
        );
        pool.liquidate(ALICE);
    }

    /// A pending split blocks new collateral: the ratio is about to move.
    function test_depositRefusedDuringCorporateAction() public {
        nvda.scheduleMultiplier(4e18, block.timestamp + 30 minutes);
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(
                ExampleCollateralPool.NotFresh.selector, address(nvda), DataState.CORP_ACTION
            )
        );
        pool.deposit(1e18);
    }

    /// The pool reports shares through the guard, so it cannot disagree with the
    /// desk about how many shares a deposit represents.
    function test_depositReportsSharesFromTheGuard() public {
        MockStockToken crwd = new MockStockToken("CrowdStrike", "CRWD", 4e18);
        MockFeed crwdFeed = new MockFeed(8, 400_00_000_000, block.timestamp);
        vm.prank(OWNER);
        guard.setFeed(address(crwd), address(crwdFeed), STALENESS);
        ExampleCollateralPool crwdPool =
            new ExampleCollateralPool(IShareExactGuard(address(guard)), address(crwd));

        crwd.mint(ALICE, 1e18);
        vm.startPrank(ALICE);
        crwd.approve(address(crwdPool), type(uint256).max);
        vm.expectEmit(true, true, true, true);
        emit ExampleCollateralPool.Deposited(ALICE, address(crwd), 1e18, 4e18);
        crwdPool.deposit(1e18);
        vm.stopPrank();
    }
}
