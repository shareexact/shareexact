// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ExactTransfer} from "../src/ExactTransfer.sol";
import {ShareExactGuard} from "../src/ShareExactGuard.sol";
import {DataState, IShareExactGuard} from "../src/interfaces/IShareExactGuard.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";
import {MockFeed} from "./mocks/MockFeed.sol";

/// Regression suite for the 24 Sep hardening pass. Each test below fails
/// against the guard deployed on 20 Sep.
///
///   1. A pending unit change is reported whatever the price state. Registering
///      a price feed used to make a token LESS protected than leaving it
///      unregistered, because STALE and ORACLE_PAUSED outrank CORP_ACTION
///      inside the single-valued enum that ExactTransfer was reading.
///   2. Observation survives a dirty uint80 in a field the guard never uses.
///   3. corpActionWindow has a floor. Zero switched the check off silently.
///   4. quote() does not advertise an unexecutable request.

/// A feed with independently dirtiable uint80 fields.
contract DirtyFeed {
    uint256 public roundIdWord = 1;
    uint256 public answeredInRoundWord = 1;

    function setRoundId(uint256 w) external { roundIdWord = w; }
    function setAnsweredInRound(uint256 w) external { answeredInRoundWord = w; }

    fallback(bytes calldata data) external returns (bytes memory) {
        bytes4 sel = bytes4(data[:4]);
        if (sel == bytes4(keccak256("decimals()"))) return abi.encode(uint8(8));
        if (sel == bytes4(keccak256("latestRoundData()"))) {
            return abi.encode(roundIdWord, int256(400e8), block.timestamp, block.timestamp, answeredInRoundWord);
        }
        return abi.encode(uint256(0));
    }
}

contract HardeningTest is Test {
    ShareExactGuard internal guard;
    ExactTransfer internal exact;
    MockStockToken internal tok;
    MockFeed internal feed;

    address internal constant OWNER = address(0xA11CE);
    address internal constant ALICE = address(0xA1);
    address internal constant BOB = address(0xB0);

    function setUp() public {
        vm.warp(1_800_000_000);
        guard = new ShareExactGuard(OWNER, 2 hours);
        exact = new ExactTransfer(IShareExactGuard(address(guard)));
        tok = new MockStockToken("Tok", "TOK", 4e18);
        feed = new MockFeed(8, 400e8, block.timestamp);
        vm.prank(OWNER);
        guard.setFeed(address(tok), address(feed), 26 hours);
        tok.mint(ALICE, 10e18);
        vm.prank(ALICE);
        tok.approve(address(exact), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                1. THE UNIT CHECK DOES NOT HIDE BEHIND PRICE
    //////////////////////////////////////////////////////////////*/

    function test_staleFeedNoLongerMasksAPendingChange() public {
        tok.scheduleMultiplier(8e18, block.timestamp + 100);
        vm.warp(block.timestamp + 27 hours); // past the 26h bound
        tok.scheduleMultiplier(8e18, block.timestamp + 100);

        // The enum still reports the price problem. That is correct and stays.
        assertEq(uint256(guard.state(address(tok))), uint256(DataState.STALE));

        // The unit question is answered separately, and truthfully.
        (bool imminent, uint256 effectiveAt) = guard.unitChangeImminent(address(tok));
        assertTrue(imminent, "unit change hidden behind STALE");
        assertEq(effectiveAt, block.timestamp + 100);

        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(ExactTransfer.MultiplierChangePending.selector, address(tok), block.timestamp + 100)
        );
        exact.transferShares(address(tok), BOB, 1e18, 0);
    }

    function test_pausedOracleNoLongerMasksAPendingChange() public {
        tok.scheduleMultiplier(8e18, block.timestamp + 100);
        tok.setOraclePaused(true);
        assertEq(uint256(guard.state(address(tok))), uint256(DataState.ORACLE_PAUSED));

        (bool imminent,) = guard.unitChangeImminent(address(tok));
        assertTrue(imminent, "unit change hidden behind ORACLE_PAUSED");

        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(ExactTransfer.MultiplierChangePending.selector, address(tok), block.timestamp + 100)
        );
        exact.transferShares(address(tok), BOB, 1e18, 0);
    }

    /// The asymmetry that made registration a downgrade is gone: registered and
    /// unregistered tokens now answer the unit question identically.
    function test_registeredAndUnregisteredAgreeOnTheUnit() public {
        MockStockToken bare = new MockStockToken("Bare", "BARE", 4e18);
        tok.scheduleMultiplier(8e18, block.timestamp + 100);
        bare.scheduleMultiplier(8e18, block.timestamp + 100);
        vm.warp(block.timestamp + 27 hours);
        tok.scheduleMultiplier(8e18, block.timestamp + 100);
        bare.scheduleMultiplier(8e18, block.timestamp + 100);

        (bool a,) = guard.unitChangeImminent(address(tok)); // has a stale feed
        (bool b,) = guard.unitChangeImminent(address(bare)); // has no feed
        assertTrue(a && b, "registration still changes the unit answer");
    }

    /// A stale price with no pending change must still let a transfer through.
    /// The weekend case has to keep working.
    function test_staleWithoutAPendingChangeStillTransfers() public {
        vm.warp(block.timestamp + 50 hours);
        assertEq(uint256(guard.state(address(tok))), uint256(DataState.STALE));
        vm.prank(ALICE);
        assertEq(exact.transferShares(address(tok), BOB, 2e18, 0), 0.5e18);
    }

    function test_unitChangeImminentTouchesNoOwnerState() public {
        MockStockToken bare = new MockStockToken("Bare", "BARE", 4e18);
        bare.scheduleMultiplier(8e18, block.timestamp + 100);
        // No feed, no sequencer feed, nothing registered for this token at all.
        (bool imminent,) = guard.unitChangeImminent(address(bare));
        assertTrue(imminent);
        assertEq(uint256(guard.state(address(bare))), uint256(DataState.CORP_ACTION));
    }

    /*//////////////////////////////////////////////////////////////
                    2. A DIRTY uint80 NO LONGER REVERTS
    //////////////////////////////////////////////////////////////*/

    function _survives(address target, bytes memory cd) internal view returns (bool ok) {
        (ok,) = target.staticcall(cd);
    }

    function test_dirtyRoundIdDoesNotRevertObservation() public {
        DirtyFeed df = new DirtyFeed();
        MockStockToken t2 = new MockStockToken("T2", "T2", 1e18);
        vm.prank(OWNER);
        guard.setFeed(address(t2), address(df), 26 hours);
        df.setRoundId(type(uint256).max);

        assertTrue(_survives(address(guard), abi.encodeWithSelector(ShareExactGuard.state.selector, address(t2))), "state");
        assertTrue(_survives(address(guard), abi.encodeWithSelector(ShareExactGuard.priceOf.selector, address(t2))), "priceOf");
        assertTrue(
            _survives(address(guard), abi.encodeWithSelector(ShareExactGuard.usdValue.selector, address(t2), uint256(1e18), true)),
            "usdValue"
        );
        assertTrue(
            _survives(address(exact), abi.encodeWithSelector(ExactTransfer.quote.selector, address(t2), uint256(1e18))),
            "quote"
        );
        // And the answer is still usable: the ignored field changes nothing.
        assertEq(uint256(guard.state(address(t2))), uint256(DataState.FRESH));
    }

    function test_dirtyAnsweredInRoundDoesNotRevertObservation() public {
        DirtyFeed df = new DirtyFeed();
        MockStockToken t2 = new MockStockToken("T2", "T2", 1e18);
        vm.prank(OWNER);
        guard.setFeed(address(t2), address(df), 26 hours);
        df.setAnsweredInRound(type(uint256).max);

        assertTrue(_survives(address(guard), abi.encodeWithSelector(ShareExactGuard.state.selector, address(t2))), "state");
        assertEq(uint256(guard.state(address(t2))), uint256(DataState.FRESH));
    }

    /*//////////////////////////////////////////////////////////////
                        3. THE WINDOW HAS A FLOOR
    //////////////////////////////////////////////////////////////*/

    function test_windowCannotBeSetToZero() public {
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(ShareExactGuard.WindowOutOfRange.selector, uint64(0)));
        guard.setCorpActionWindow(0);
    }

    function test_windowFloorIsEnforcedAtConstruction() public {
        vm.expectRevert(abi.encodeWithSelector(ShareExactGuard.WindowOutOfRange.selector, uint64(60)));
        new ShareExactGuard(OWNER, 60);
    }

    function test_windowStillMovesInsideTheBounds() public {
        vm.startPrank(OWNER);
        guard.setCorpActionWindow(guard.MIN_CORP_ACTION_WINDOW());
        assertEq(guard.corpActionWindow(), guard.MIN_CORP_ACTION_WINDOW());
        guard.setCorpActionWindow(guard.MAX_CORP_ACTION_WINDOW());
        assertEq(guard.corpActionWindow(), guard.MAX_CORP_ACTION_WINDOW());
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                        4. QUOTE MATCHES EXECUTION
    //////////////////////////////////////////////////////////////*/

    function test_quoteZeroIsNotExecutable() public view {
        (,,,, bool executable) = exact.quote(address(tok), 0);
        assertFalse(executable, "quote(0) still advertises a send that reverts");
    }

    function test_quoteIsNotExecutableDuringAMaskedUnitChange() public {
        tok.scheduleMultiplier(8e18, block.timestamp + 100);
        vm.warp(block.timestamp + 27 hours);
        tok.scheduleMultiplier(8e18, block.timestamp + 100);
        (,,, DataState s, bool executable) = exact.quote(address(tok), 1e18);
        assertEq(uint256(s), uint256(DataState.STALE));
        assertFalse(executable, "quote advertised a pending split as executable");
    }

    function test_quoteDoesNotRevertOnAnOverflowingRequest() public {
        MockStockToken small = new MockStockToken("Small", "SML", 1); // multiplier 1 wei
        (bool ok, bytes memory ret) = address(exact).staticcall(
            abi.encodeWithSelector(ExactTransfer.quote.selector, address(small), type(uint256).max)
        );
        assertTrue(ok, "quote reverted on overflow despite never-reverts");
        (,,,, bool executable) = abi.decode(ret, (uint256, uint256, uint256, DataState, bool));
        assertFalse(executable);
    }

    /// A normal request is still executable, so none of the above is a blanket no.
    function test_healthyQuoteStillExecutable() public view {
        (uint256 raw,,,, bool executable) = exact.quote(address(tok), 4e18);
        assertEq(raw, 1e18);
        assertTrue(executable);
    }
}
