// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ExactTransfer} from "../src/ExactTransfer.sol";
import {ShareExactGuard} from "../src/ShareExactGuard.sol";
import {DataState, IShareExactGuard} from "../src/interfaces/IShareExactGuard.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";
import {MockFeed} from "./mocks/MockFeed.sol";

/// Corporate-action checks must not be gated on a price feed. A transfer
/// reads the unit, not the price, so an unregistered token with a pending
/// multiplier change is CORP_ACTION, not NO_FEED.
contract CorpActionCoverageTest is Test {
    ShareExactGuard internal guard;
    ExactTransfer internal exact;
    MockStockToken internal registered;
    MockStockToken internal unregistered;
    MockFeed internal feed;

    address internal constant OWNER = address(0xA11CE);
    address internal constant ALICE = address(0xA1);
    address internal constant BOB = address(0xB0);

    function setUp() public {
        vm.warp(1_800_000_000);
        guard = new ShareExactGuard(OWNER, 2 hours);
        exact = new ExactTransfer(IShareExactGuard(address(guard)));

        registered = new MockStockToken("Registered", "REG", 4e18);
        unregistered = new MockStockToken("Unregistered", "UNREG", 4e18);
        feed = new MockFeed(8, 400_00_000_000, block.timestamp);

        vm.prank(OWNER);
        guard.setFeed(address(registered), address(feed), 26 hours);

        registered.mint(ALICE, 10e18);
        unregistered.mint(ALICE, 10e18);
        vm.startPrank(ALICE);
        registered.approve(address(exact), type(uint256).max);
        unregistered.approve(address(exact), type(uint256).max);
        vm.stopPrank();
    }

    function test_registeredTokenIsProtected() public {
        registered.scheduleMultiplier(8e18, block.timestamp + 30 minutes);
        assertEq(uint256(guard.state(address(registered))), uint256(DataState.CORP_ACTION));
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(
                ExactTransfer.MultiplierChangePending.selector, address(registered), block.timestamp + 30 minutes
            )
        );
        exact.transferShares(address(registered), BOB, 1e18, 0);
    }

    function test_unregisteredTokenStillReportsCorpAction() public {
        unregistered.scheduleMultiplier(8e18, block.timestamp + 30 minutes);
        assertEq(uint256(guard.state(address(unregistered))), uint256(DataState.CORP_ACTION));
    }

    function test_quoteIsNotExecutableDuringPendingSplit() public {
        unregistered.scheduleMultiplier(8e18, block.timestamp + 30 minutes);
        (,,,, bool executable) = exact.quote(address(unregistered), 1e18);
        assertFalse(executable);
    }

    function test_unregisteredTransferRevertsDuringPendingSplit() public {
        unregistered.scheduleMultiplier(8e18, block.timestamp + 30 minutes);
        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(
                ExactTransfer.MultiplierChangePending.selector, address(unregistered), block.timestamp + 30 minutes
            )
        );
        exact.transferShares(address(unregistered), BOB, 1e18, 0);
    }
}
