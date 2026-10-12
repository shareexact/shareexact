// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ExactTransfer} from "../src/ExactTransfer.sol";
import {ShareExactGuard} from "../src/ShareExactGuard.sol";
import {DataState, IShareExactGuard} from "../src/interfaces/IShareExactGuard.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";
import {MockFeed, MockSequencerFeed} from "./mocks/MockFeed.sol";
import {
    DirtyBoolToken,
    FutureFeed,
    MutatingMultiplierToken,
    RevertingMultiplierToken,
    ShortReturnToken,
    UndecodableFeed
} from "./mocks/HostileMocks.sol";

/// @notice Everything in this file is a case where a third party misbehaves:
///         a token that will not answer, a feed that lies about time, a word
///         that is not a bool. These are the cases where a safety layer either
///         earns its name or quietly does the wrong thing.
contract AdversarialTest is Test {
    ShareExactGuard internal guard;
    ExactTransfer internal exact;
    MockFeed internal feed;

    address internal constant OWNER = address(0xA11CE);
    address internal constant ALICE = address(0xA1);
    address internal constant BOB = address(0xB0);
    uint64 internal constant STALENESS = 26 hours;

    function setUp() public {
        vm.warp(1_800_000_000);
        guard = new ShareExactGuard(OWNER, 2 hours);
        exact = new ExactTransfer(IShareExactGuard(address(guard)));
        feed = new MockFeed(8, 178_40_000_000, block.timestamp);
    }

    /*//////////////////////////////////////////////////////////////
                  FAIL CLOSED ON AN UNREADABLE MULTIPLIER
    //////////////////////////////////////////////////////////////*/

    /// The regression test for the worst bug this codebase had: a failed
    /// `uiMultiplier()` read used to fall back to 1.0, so a transient failure on
    /// a 4x token would have moved four shares for a one-share request.
    function test_unreadableMultiplierDoesNotFallBackToOne() public {
        RevertingMultiplierToken broken = new RevertingMultiplierToken();
        (uint256 current, uint256 pending, uint256 effectiveAt) = guard.multiplierOf(address(broken));
        assertEq(current, 0, "unreadable multiplier must not become 1.0");
        assertEq(pending, 0);
        assertEq(effectiveAt, 0);
    }

    function test_conversionRevertsWhenMultiplierUnreadable() public {
        RevertingMultiplierToken broken = new RevertingMultiplierToken();
        vm.expectRevert(abi.encodeWithSelector(ShareExactGuard.NoMultiplier.selector, address(broken)));
        guard.sharesToRaw(address(broken), 1e18);
        vm.expectRevert(abi.encodeWithSelector(ShareExactGuard.NoMultiplier.selector, address(broken)));
        guard.rawToShares(address(broken), 1e18);
    }

    function test_transferRevertsWhenMultiplierUnreadable() public {
        RevertingMultiplierToken broken = new RevertingMultiplierToken();
        broken.mint(ALICE, 10e18);
        vm.startPrank(ALICE);
        broken.approve(address(exact), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(ExactTransfer.UnitUnavailable.selector, address(broken)));
        exact.transferShares(address(broken), BOB, 1e18, 0);
        vm.stopPrank();
    }

    function test_quoteDegradesInsteadOfRevertingOnBrokenToken() public {
        RevertingMultiplierToken broken = new RevertingMultiplierToken();
        (uint256 raw,,,, bool executable) = exact.quote(address(broken), 1e18);
        assertEq(raw, 0);
        assertFalse(executable);
    }

    function test_maxSharesDoesNotRevertOnUnreadableMultiplier() public {
        RevertingMultiplierToken broken = new RevertingMultiplierToken();
        assertEq(exact.maxShares(address(broken), ALICE), 0);
        ShortReturnToken short = new ShortReturnToken();
        assertEq(exact.maxShares(address(short), ALICE), 0);
    }

    function test_isSupportedRejectsPlainErc20() public {
        ShortReturnToken plain = new ShortReturnToken();
        assertFalse(exact.isSupported(address(plain)));
        MockStockToken real = new MockStockToken("Real", "REAL", 2e18);
        assertTrue(exact.isSupported(address(real)));
    }

    /*//////////////////////////////////////////////////////////////
                        MALFORMED EXTERNAL RETURNS
    //////////////////////////////////////////////////////////////*/

    /// A dirty bool word (2) reverts `abi.decode(_, (bool))`. Observation
    /// functions must survive it.
    function test_dirtyBoolDoesNotRevertObservation() public {
        DirtyBoolToken dirty = new DirtyBoolToken();
        vm.prank(OWNER);
        guard.setFeed(address(dirty), address(feed), STALENESS);
        // Treated as "could not read the flag", not as paused, and not as a revert.
        assertEq(uint256(guard.state(address(dirty))), uint256(DataState.FRESH));
    }

    function test_shortReturnDataDoesNotRevert() public {
        ShortReturnToken short = new ShortReturnToken();
        (uint256 current,,) = guard.multiplierOf(address(short));
        assertEq(current, 0);
        // No feed registered, and the call must still answer rather than throw.
        assertEq(uint256(guard.state(address(short))), uint256(DataState.NO_FEED));
    }

    /*//////////////////////////////////////////////////////////////
                              TIME EDGE CASES
    //////////////////////////////////////////////////////////////*/

    /// A feed timestamp in the future is a broken or hostile feed, not a
    /// maximally fresh one.
    function test_futureFeedTimestampIsStaleNotFresh() public {
        MockStockToken token = new MockStockToken("Fut", "FUT", 1e18);
        FutureFeed future = new FutureFeed(1 hours);
        vm.prank(OWNER);
        guard.setFeed(address(token), address(future), STALENESS);
        assertEq(uint256(guard.state(address(token))), uint256(DataState.STALE));
    }

    /// A sequencer feed whose `startedAt` is in the future would underflow the
    /// grace-period subtraction and revert a view function.
    function test_futureSequencerStartDoesNotRevert() public {
        MockStockToken token = new MockStockToken("Seq", "SEQ", 1e18);
        vm.prank(OWNER);
        guard.setFeed(address(token), address(feed), STALENESS);
        MockSequencerFeed seq = new MockSequencerFeed(0, block.timestamp + 1 days);
        vm.prank(OWNER);
        guard.setSequencerFeed(address(seq), 30 minutes);
        assertEq(uint256(guard.state(address(token))), uint256(DataState.SEQUENCER_DOWN));
    }

    /*//////////////////////////////////////////////////////////////
                            FEED CONFIGURATION
    //////////////////////////////////////////////////////////////*/

    function test_feedWithoutCodeIsRejected() public {
        MockStockToken token = new MockStockToken("T", "T", 1e18);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(ShareExactGuard.InvalidFeed.selector, address(0xDEAD)));
        guard.setFeed(address(token), address(0xDEAD), STALENESS);
    }

    function test_undecodableFeedIsRejectedAtConfigTime() public {
        MockStockToken token = new MockStockToken("T", "T", 1e18);
        UndecodableFeed bad = new UndecodableFeed();
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(ShareExactGuard.InvalidFeed.selector, address(bad)));
        guard.setFeed(address(token), address(bad), STALENESS);
    }

    /*//////////////////////////////////////////////////////////////
                          ARITHMETIC BOUNDARIES
    //////////////////////////////////////////////////////////////*/

    /// `uiShares * WAD` overflows a uint256 long before the result does.
    /// mulDiv keeps the intermediate in 512 bits, so a representable answer is
    /// returned instead of a revert.
    function test_largeConversionDoesNotOverflow() public {
        MockStockToken token = new MockStockToken("Big", "BIG", 4e18);
        uint256 huge = type(uint256).max / 4;
        uint256 raw = guard.sharesToRaw(address(token), huge);
        assertEq(raw, huge / 4);
    }

    function test_maxUintConversionIsExactNotReverting() public {
        MockStockToken token = new MockStockToken("Max", "MAX", 2e18);
        // shares -> raw halves the number, so the answer is representable.
        uint256 raw = guard.sharesToRaw(address(token), type(uint256).max);
        assertEq(raw, type(uint256).max / 2);
    }

    function test_usdValueSurvivesLargeBalances() public {
        MockStockToken token = new MockStockToken("V", "V", 1e18);
        vm.prank(OWNER);
        guard.setFeed(address(token), address(feed), STALENESS);
        // 1e30 raw units at $178.40 would overflow a naive price*1e10 scaling.
        uint256 value = guard.usdValue(address(token), 1e30, false);
        assertEq(value, 178.4e30);
    }

    /*//////////////////////////////////////////////////////////////
                           HOSTILE TOKEN BEHAVIOUR
    //////////////////////////////////////////////////////////////*/

    /// A token that changes its own multiplier inside `transferFrom` cannot be
    /// stopped from doing so, but the transfer still settles at the ratio that
    /// was quoted and logged, and the contract holds no balance afterwards.
    /// Documented rather than defended: this is out of scope for canonical
    /// Stock Tokens and `isSupported` is the boundary.
    function test_multiplierMutationDuringTransferSettlesAtQuotedRatio() public {
        MutatingMultiplierToken hostile = new MutatingMultiplierToken();
        hostile.mint(ALICE, 10e18);
        vm.startPrank(ALICE);
        hostile.approve(address(exact), type(uint256).max);
        uint256 raw = exact.transferShares(address(hostile), BOB, 4e18, 0);
        vm.stopPrank();
        // Quoted at 4x: four shares is one raw token.
        assertEq(raw, 1e18);
        assertEq(hostile.balanceOf(BOB), 1e18);
        assertEq(hostile.balanceOf(address(exact)), 0);
    }
}
