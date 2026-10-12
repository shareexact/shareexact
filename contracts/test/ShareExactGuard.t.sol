// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ShareExactGuard} from "../src/ShareExactGuard.sol";
import {DataState} from "../src/interfaces/IShareExactGuard.sol";
import {MockStockToken, PlainToken} from "./mocks/MockStockToken.sol";
import {MockFeed, MockSequencerFeed} from "./mocks/MockFeed.sol";

contract ShareExactGuardTest is Test {
    ShareExactGuard internal guard;
    MockStockToken internal nvda;
    MockFeed internal feed;

    address internal constant OWNER = address(0xA11CE);

    /// 24/5 equity feeds hold their last value all weekend, so a realistic
    /// staleness bound for a Stock Token is measured in days, not minutes.
    uint64 internal constant STALENESS = 26 hours;

    function setUp() public {
        vm.warp(1_800_000_000);
        guard = new ShareExactGuard(OWNER, 2 hours);
        nvda = new MockStockToken("NVIDIA Stock Token", "NVDA", 1.000775159164630595e18);
        feed = new MockFeed(8, 178_40_000_000, block.timestamp);
        vm.prank(OWNER);
        guard.setFeed(address(nvda), address(feed), STALENESS);
    }

    /*//////////////////////////////////////////////////////////////
                                  STATE
    //////////////////////////////////////////////////////////////*/

    function test_freshWhenFeedRecent() public view {
        assertEq(uint256(guard.state(address(nvda))), uint256(DataState.FRESH));
    }

    function test_noFeedForUnregisteredToken() public {
        MockStockToken other = new MockStockToken("Apple", "AAPL", 1e18);
        assertEq(uint256(guard.state(address(other))), uint256(DataState.NO_FEED));
    }

    /// The weekend case this whole layer exists for: the feed does not fail,
    /// it simply stops moving, and `latestRoundData()` keeps answering.
    function test_staleAfterWeekend() public {
        vm.warp(block.timestamp + 50 hours);
        assertEq(uint256(guard.state(address(nvda))), uint256(DataState.STALE));

        (uint256 price,, uint256 updatedAt, DataState s) = guard.priceOf(address(nvda));
        assertEq(uint256(s), uint256(DataState.STALE));
        // A stale price is still returned, with its real timestamp, so a UI can
        // show "as of Friday 22:00" rather than a blank or a zero.
        assertGt(price, 0);
        assertGt(updatedAt, 0);
    }

    function test_staleWhenFeedReverts() public {
        feed.setReverts(true);
        assertEq(uint256(guard.state(address(nvda))), uint256(DataState.STALE));
    }

    function test_staleWhenAnswerNonPositive() public {
        feed.set(0, block.timestamp);
        assertEq(uint256(guard.state(address(nvda))), uint256(DataState.STALE));
    }

    function test_oraclePausedFlag() public {
        nvda.setOraclePaused(true);
        assertEq(uint256(guard.state(address(nvda))), uint256(DataState.ORACLE_PAUSED));
    }

    /// Staleness outranks the advisory pause flag: a stale price is unusable
    /// whether or not the issuer has raised the flag.
    function test_stalenessOutranksPause() public {
        nvda.setOraclePaused(true);
        vm.warp(block.timestamp + 50 hours);
        assertEq(uint256(guard.state(address(nvda))), uint256(DataState.STALE));
    }

    function test_corpActionWithinWindow() public {
        nvda.scheduleMultiplier(4e18, block.timestamp + 1 hours);
        assertEq(uint256(guard.state(address(nvda))), uint256(DataState.CORP_ACTION));
    }

    function test_corpActionOutsideWindowIsFresh() public {
        nvda.scheduleMultiplier(4e18, block.timestamp + 5 days);
        assertEq(uint256(guard.state(address(nvda))), uint256(DataState.FRESH));
    }

    function test_scheduledNoOpIsNotCorpAction() public {
        (uint256 current,,) = guard.multiplierOf(address(nvda));
        nvda.scheduleMultiplier(current, block.timestamp + 1 hours);
        assertEq(uint256(guard.state(address(nvda))), uint256(DataState.FRESH));
    }

    function test_sequencerDownOutranksEverything() public {
        MockSequencerFeed seq = new MockSequencerFeed(1, block.timestamp);
        vm.prank(OWNER);
        guard.setSequencerFeed(address(seq), 30 minutes);
        assertEq(uint256(guard.state(address(nvda))), uint256(DataState.SEQUENCER_DOWN));
    }

    function test_sequencerGracePeriod() public {
        MockSequencerFeed seq = new MockSequencerFeed(0, block.timestamp);
        vm.prank(OWNER);
        guard.setSequencerFeed(address(seq), 30 minutes);
        // Back up, but inside the grace period: still not trusted.
        assertEq(uint256(guard.state(address(nvda))), uint256(DataState.SEQUENCER_DOWN));
        vm.warp(block.timestamp + 31 minutes);
        feed.set(178_40_000_000, block.timestamp);
        assertEq(uint256(guard.state(address(nvda))), uint256(DataState.FRESH));
    }

    function test_requireFreshReverts() public {
        vm.warp(block.timestamp + 50 hours);
        vm.expectRevert(
            abi.encodeWithSelector(ShareExactGuard.DataNotFresh.selector, address(nvda), DataState.STALE)
        );
        guard.requireFresh(address(nvda));
    }

    /*//////////////////////////////////////////////////////////////
                                  UNITS
    //////////////////////////////////////////////////////////////*/

    function test_multiplierRoundTrip() public view {
        uint256 raw = guard.sharesToRaw(address(nvda), 12e18);
        uint256 back = guard.rawToShares(address(nvda), raw);
        // Floor rounding can lose at most one wei of a share.
        assertLe(12e18 - back, 1);
    }

    /// A plain ERC-20 has no ERC-8056 surface, and the guard refuses to assume
    /// it is therefore 1:1. Assuming 1:1 is indistinguishable from a 4x token
    /// whose multiplier read just failed, and guessing wrong moves four times
    /// the intended amount. Out of scope beats silently wrong.
    function test_plainErc20IsOutOfScopeNotAssumedOneToOne() public {
        PlainToken plain = new PlainToken();
        (uint256 current, uint256 pending, uint256 eff) = guard.multiplierOf(address(plain));
        assertEq(current, 0);
        assertEq(pending, 0);
        assertEq(eff, 0);
        vm.expectRevert(abi.encodeWithSelector(ShareExactGuard.NoMultiplier.selector, address(plain)));
        guard.sharesToRaw(address(plain), 5e18);
    }

    /// A 4x multiplier is the demo case: the naive path treats a typed "1 share"
    /// as 1e18 raw units, which is four shares.
    function test_fourXMultiplierTrap() public {
        MockStockToken crwd = new MockStockToken("CrowdStrike", "CRWD", 4e18);
        uint256 raw = guard.sharesToRaw(address(crwd), 1e18);
        assertEq(raw, 0.25e18);
        assertEq(guard.rawToShares(address(crwd), 1e18), 4e18);
    }

    /*//////////////////////////////////////////////////////////////
                                VALUATION
    //////////////////////////////////////////////////////////////*/

    function test_usdValueScalesFeedDecimals() public view {
        // 1 raw token at $178.40 on an 8-decimal feed.
        uint256 value = guard.usdValue(address(nvda), 1e18, false);
        assertEq(value, 178.4e18);
    }

    /// The feed already includes the multiplier, so the guard must not apply it
    /// a second time. This test is the regression guard for double-counting.
    function test_usdValueDoesNotReapplyMultiplier() public {
        MockStockToken crwd = new MockStockToken("CrowdStrike", "CRWD", 4e18);
        MockFeed crwdFeed = new MockFeed(8, 400_00_000_000, block.timestamp);
        vm.prank(OWNER);
        guard.setFeed(address(crwd), address(crwdFeed), STALENESS);
        assertEq(guard.usdValue(address(crwd), 1e18, false), 400e18);
    }

    function test_usdValueRevertsWhenStale() public {
        vm.warp(block.timestamp + 50 hours);
        vm.expectRevert(
            abi.encodeWithSelector(ShareExactGuard.DataNotFresh.selector, address(nvda), DataState.STALE)
        );
        guard.usdValue(address(nvda), 1e18, false);
    }

    function test_usdValueAllowStale() public {
        vm.warp(block.timestamp + 50 hours);
        assertEq(guard.usdValue(address(nvda), 1e18, true), 178.4e18);
    }

    /*//////////////////////////////////////////////////////////////
                               PERMISSIONS
    //////////////////////////////////////////////////////////////*/

    function test_onlyOwnerCanSetFeed() public {
        vm.expectRevert(ShareExactGuard.NotOwner.selector);
        guard.setFeed(address(nvda), address(feed), STALENESS);
    }

    function test_stalenessBoundsAreEnforced() public {
        vm.startPrank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(ShareExactGuard.StalenessOutOfRange.selector, uint64(1)));
        guard.setFeed(address(nvda), address(feed), 1);
        vm.expectRevert(abi.encodeWithSelector(ShareExactGuard.StalenessOutOfRange.selector, uint64(30 days)));
        guard.setFeed(address(nvda), address(feed), 30 days);
        vm.stopPrank();
    }

    function test_twoStepOwnership() public {
        address next = address(0xB0B);
        vm.prank(OWNER);
        guard.transferOwnership(next);
        assertEq(guard.owner(), OWNER);
        vm.prank(next);
        guard.acceptOwnership();
        assertEq(guard.owner(), next);
    }

    function testFuzz_roundTripNeverInflates(uint96 shares, uint64 multiplier) public {
        vm.assume(multiplier > 0.01e18 && multiplier < 100e18);
        MockStockToken t = new MockStockToken("Fuzz", "FUZZ", multiplier);
        uint256 raw = guard.sharesToRaw(address(t), shares);
        uint256 back = guard.rawToShares(address(t), raw);
        // Floor rounding may only ever lose value, never create it.
        assertLe(back, shares);
    }
}
