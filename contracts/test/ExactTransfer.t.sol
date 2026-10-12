// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ExactTransfer} from "../src/ExactTransfer.sol";
import {ShareExactGuard} from "../src/ShareExactGuard.sol";
import {DataState, IShareExactGuard} from "../src/interfaces/IShareExactGuard.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";
import {MockFeed, MockSequencerFeed} from "./mocks/MockFeed.sol";

contract ExactTransferTest is Test {
    ShareExactGuard internal guard;
    ExactTransfer internal exact;
    MockStockToken internal crwd;
    MockFeed internal feed;

    address internal constant OWNER = address(0xA11CE);
    address internal constant ALICE = address(0xA1);
    address internal constant BOB = address(0xB0);

    function setUp() public {
        vm.warp(1_800_000_000);
        guard = new ShareExactGuard(OWNER, 2 hours);
        exact = new ExactTransfer(IShareExactGuard(address(guard)));

        // 4x multiplier: one raw token is four underlying shares.
        crwd = new MockStockToken("CrowdStrike Stock Token", "CRWD", 4e18);
        feed = new MockFeed(8, 400_00_000_000, block.timestamp);
        vm.prank(OWNER);
        guard.setFeed(address(crwd), address(feed), 26 hours);

        crwd.mint(ALICE, 10e18); // 10 raw tokens == 40 shares
        vm.prank(ALICE);
        crwd.approve(address(exact), type(uint256).max);
    }

    function test_movesSharesNotRawUnits() public {
        vm.prank(ALICE);
        uint256 raw = exact.transferShares(address(crwd), BOB, 1e18, 0);

        // One share is a quarter of a raw token at a 4x multiplier. The naive
        // path would have moved 1e18 raw units, which is four shares.
        assertEq(raw, 0.25e18);
        assertEq(crwd.balanceOf(BOB), 0.25e18);
        assertEq(crwd.balanceOfUI(BOB), 1e18);
    }

    function test_quoteMatchesExecution() public {
        (uint256 qRaw, uint256 qShares,, DataState s, bool executable) = exact.quote(address(crwd), 3e18);
        assertTrue(executable);
        assertEq(uint256(s), uint256(DataState.FRESH));
        vm.prank(ALICE);
        uint256 raw = exact.transferShares(address(crwd), BOB, 3e18, 0);
        assertEq(raw, qRaw);
        assertEq(crwd.balanceOfUI(BOB), qShares);
    }

    /// The core race this contract closes: a quote produced before a scheduled
    /// split must not be allowed to settle after it.
    function test_revertsWhenMultiplierChangeIsImminent() public {
        crwd.scheduleMultiplier(8e18, block.timestamp + 30 minutes);
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(
                ExactTransfer.MultiplierChangePending.selector, address(crwd), block.timestamp + 30 minutes
            )
        );
        exact.transferShares(address(crwd), BOB, 1e18, 0);
    }

    /// A transfer does not need a price, so a stale feed must not block it.
    /// This is the deliberate asymmetry between pricing and unit conversion.
    function test_weekendStalePriceStillAllowsTransfer() public {
        vm.warp(block.timestamp + 50 hours);
        assertEq(uint256(guard.state(address(crwd))), uint256(DataState.STALE));
        vm.prank(ALICE);
        uint256 raw = exact.transferShares(address(crwd), BOB, 2e18, 0);
        assertEq(raw, 0.5e18);
    }

    function test_revertsWhenSequencerDown() public {
        MockSequencerFeed seq = new MockSequencerFeed(1, block.timestamp);
        vm.prank(OWNER);
        guard.setSequencerFeed(address(seq), 30 minutes);
        vm.prank(ALICE);
        vm.expectRevert(ExactTransfer.SequencerDown.selector);
        exact.transferShares(address(crwd), BOB, 1e18, 0);
    }

    function test_shortfallIsSurfacedNotSwallowed() public {
        // A multiplier of 3 makes most share amounts not exactly representable.
        MockStockToken odd = new MockStockToken("Odd", "ODD", 3e18);
        odd.mint(ALICE, 10e18);
        vm.startPrank(ALICE);
        odd.approve(address(exact), type(uint256).max);

        uint256 want = 1e18 + 1;
        vm.expectRevert(
            abi.encodeWithSelector(ExactTransfer.ShareShortfall.selector, want, 1e18 - 1, 0)
        );
        exact.transferShares(address(odd), BOB, want, 0);

        // With an explicit tolerance the caller opts in knowingly.
        uint256 raw = exact.transferShares(address(odd), BOB, want, 2);
        assertEq(odd.balanceOfUI(BOB), 1e18 - 1);
        assertGt(raw, 0);
        vm.stopPrank();
    }

    /// A request so small that flooring erases it entirely is a rounding
    /// failure, not a malformed input: the caller is told what it lost.
    function test_dustRequestReportsShortfall() public {
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(ExactTransfer.ShareShortfall.selector, 1, 0, 0));
        exact.transferShares(address(crwd), BOB, 1, 0);
    }

    function test_insufficientBalanceUsesRawTerms() public {
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(ExactTransfer.InsufficientShareBalance.selector, 10e18, 25e18)
        );
        exact.transferShares(address(crwd), BOB, 100e18, 0);
    }

    function test_maxShares() public view {
        // 10 raw tokens at 4x is 40 shares.
        assertEq(exact.maxShares(address(crwd), ALICE), 40e18);
    }

    function test_rejectsZeroes() public {
        vm.startPrank(ALICE);
        vm.expectRevert(ExactTransfer.ZeroAddress.selector);
        exact.transferShares(address(crwd), address(0), 1e18, 0);
        vm.expectRevert(ExactTransfer.ZeroAmount.selector);
        exact.transferShares(address(crwd), BOB, 0, 0);
        vm.stopPrank();
    }

    /// The event is the consent record, so it has to carry what the sender
    /// agreed to lose as well as what they actually lost.
    function test_eventRecordsAcceptedShortfall() public {
        MockStockToken odd = new MockStockToken("Odd", "ODD", 3e18);
        odd.mint(ALICE, 10e18);
        vm.startPrank(ALICE);
        odd.approve(address(exact), type(uint256).max);

        uint256 want = 1e18 + 1;
        vm.expectEmit(true, true, true, true);
        emit ExactTransfer.ExactShareTransfer(
            address(odd), ALICE, BOB, want, 1e18 - 1, 333333333333333333, 3e18, 2
        );
        exact.transferShares(address(odd), BOB, want, 2);
        vm.stopPrank();
    }

    /// The contract must never be able to hold a balance between calls.
    function test_contractHoldsNoBalance() public {
        vm.prank(ALICE);
        exact.transferShares(address(crwd), BOB, 4e18, 0);
        assertEq(crwd.balanceOf(address(exact)), 0);
    }
}
