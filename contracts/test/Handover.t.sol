// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ShareExactGuard} from "../src/ShareExactGuard.sol";
import {MockFeed} from "./mocks/MockFeed.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";

/// The ownership handover, end to end, before it is done on mainnet where it
/// cannot be undone. Proves the ceremony in script/Handover.s.sol works, that
/// the guard keeps functioning under timelock ownership, and that the ways to
/// get it wrong actually fail rather than silently half-succeed.
contract HandoverTest is Test {
    bytes32 internal constant SALT = keccak256("shareexact.guard.acceptOwnership.v1");
    uint256 internal constant DELAY = 24 hours;

    ShareExactGuard internal guard;
    TimelockController internal timelock;
    MockStockToken internal tok;
    MockFeed internal feed;

    address internal constant DEPLOYER = address(0xD3);
    address internal constant SAFE = address(0x5AFE);
    address internal constant ANYONE = address(0xA11);

    function setUp() public {
        vm.warp(1_800_000_000);

        // Deployed with the EOA as owner, exactly as Deploy.s.sol does, so the
        // feeds can be registered before the handover.
        guard = new ShareExactGuard(DEPLOYER, 2 hours);
        tok = new MockStockToken("Tok", "TOK", 4e18);
        feed = new MockFeed(8, 400e8, block.timestamp);
        vm.prank(DEPLOYER);
        guard.setFeed(address(tok), address(feed), 26 hours);

        address[] memory proposers = new address[](1);
        proposers[0] = SAFE;
        address[] memory executors = new address[](1);
        executors[0] = address(0); // open execution
        timelock = new TimelockController(DELAY, proposers, executors, address(0));
    }

    function _accept() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(ShareExactGuard.acceptOwnership.selector);
    }

    /*//////////////////////////////////////////////////////////////
                            THE HAPPY PATH
    //////////////////////////////////////////////////////////////*/

    function test_handoverCompletes() public {
        // 1. EOA points ownership at the timelock.
        vm.prank(DEPLOYER);
        guard.transferOwnership(address(timelock));
        assertEq(guard.owner(), DEPLOYER, "owner must not change until accepted");
        assertEq(guard.pendingOwner(), address(timelock));

        // 2. The Safe schedules acceptOwnership().
        vm.prank(SAFE);
        timelock.schedule(address(guard), 0, _accept(), bytes32(0), SALT, DELAY);

        bytes32 id = timelock.hashOperation(address(guard), 0, _accept(), bytes32(0), SALT);
        assertTrue(timelock.isOperationPending(id));
        assertFalse(timelock.isOperationReady(id), "must not be ready before the delay");

        // 3. Anyone executes once the delay has elapsed.
        vm.warp(block.timestamp + DELAY + 1);
        assertTrue(timelock.isOperationReady(id));
        vm.prank(ANYONE);
        timelock.execute(address(guard), 0, _accept(), bytes32(0), SALT);

        assertEq(guard.owner(), address(timelock), "handover did not complete");
        assertEq(guard.pendingOwner(), address(0), "pendingOwner should be cleared");
    }

    /// The point of the whole exercise: configuration still works, but only
    /// after the delay, and it is announced when scheduled.
    function test_configStillWorksUnderTimelockAndIsAnnouncedFirst() public {
        test_handoverCompletes();

        MockStockToken t2 = new MockStockToken("T2", "T2", 1e18);
        MockFeed f2 = new MockFeed(8, 100e8, block.timestamp);
        bytes memory setFeed =
            abi.encodeWithSelector(ShareExactGuard.setFeed.selector, address(t2), address(f2), uint64(26 hours));
        bytes32 salt2 = keccak256("setFeed.t2");

        // The EOA has no authority any more.
        vm.prank(DEPLOYER);
        vm.expectRevert(ShareExactGuard.NotOwner.selector);
        guard.setFeed(address(t2), address(f2), 26 hours);

        // Scheduling is public record before it takes effect.
        vm.prank(SAFE);
        timelock.schedule(address(guard), 0, setFeed, bytes32(0), salt2, DELAY);
        (address before,,) = guard.feedOf(address(t2));
        assertEq(before, address(0), "feed must not be set while merely scheduled");

        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(ANYONE);
        timelock.execute(address(guard), 0, setFeed, bytes32(0), salt2);

        (address after_,,) = guard.feedOf(address(t2));
        assertEq(after_, address(f2), "feed should be set after the delay");
    }

    /// A scheduled change can be pulled. OZ 5.x gives proposers CANCELLER_ROLE.
    function test_proposerCanCancelItsOwnMistake() public {
        test_handoverCompletes();

        bytes memory bad =
            abi.encodeWithSelector(ShareExactGuard.setCorpActionWindow.selector, uint64(7 days));
        bytes32 salt3 = keccak256("oops");

        vm.prank(SAFE);
        timelock.schedule(address(guard), 0, bad, bytes32(0), salt3, DELAY);
        bytes32 id = timelock.hashOperation(address(guard), 0, bad, bytes32(0), salt3);

        vm.prank(SAFE);
        timelock.cancel(id);
        assertFalse(timelock.isOperationPending(id), "cancel did not take");

        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(ANYONE);
        vm.expectRevert();
        timelock.execute(address(guard), 0, bad, bytes32(0), salt3);
        assertEq(guard.corpActionWindow(), 2 hours, "cancelled change must not land");
    }

    /*//////////////////////////////////////////////////////////////
                        THE WAYS TO GET IT WRONG
    //////////////////////////////////////////////////////////////*/

    /// The EOA cannot finish the handover itself. This is the step people
    /// assume they can send and cannot.
    function test_eoaCannotAcceptOnBehalfOfTheTimelock() public {
        vm.prank(DEPLOYER);
        guard.transferOwnership(address(timelock));
        vm.prank(DEPLOYER);
        vm.expectRevert(ShareExactGuard.NotOwner.selector);
        guard.acceptOwnership();
        assertEq(guard.owner(), DEPLOYER);
    }

    /// Executing early fails rather than half-applying.
    function test_executeBeforeTheDelayFails() public {
        vm.prank(DEPLOYER);
        guard.transferOwnership(address(timelock));
        vm.prank(SAFE);
        timelock.schedule(address(guard), 0, _accept(), bytes32(0), SALT, DELAY);

        vm.warp(block.timestamp + DELAY - 10);
        vm.prank(ANYONE);
        vm.expectRevert();
        timelock.execute(address(guard), 0, _accept(), bytes32(0), SALT);
        assertEq(guard.owner(), DEPLOYER, "ownership must not have moved");
    }

    /// A non-proposer cannot schedule, so the Safe really is the gate.
    function test_nonProposerCannotSchedule() public {
        vm.prank(DEPLOYER);
        guard.transferOwnership(address(timelock));
        vm.prank(ANYONE);
        vm.expectRevert();
        timelock.schedule(address(guard), 0, _accept(), bytes32(0), SALT, DELAY);
    }

    /// Transferring to a contract that can never call acceptOwnership leaves the
    /// guard with its EOA owner — recoverable, because the transfer can be
    /// re-pointed. This is the failure mode worth knowing is survivable.
    function test_transferToADeadOwnerIsRecoverable() public {
        address dead = address(new MockStockToken("dead", "DEAD", 1e18)); // no acceptOwnership

        vm.prank(DEPLOYER);
        guard.transferOwnership(dead);
        assertEq(guard.pendingOwner(), dead);
        assertEq(guard.owner(), DEPLOYER, "still the EOA, nothing lost yet");

        // Re-point at the real timelock and finish properly.
        vm.prank(DEPLOYER);
        guard.transferOwnership(address(timelock));
        vm.prank(SAFE);
        timelock.schedule(address(guard), 0, _accept(), bytes32(0), SALT, DELAY);
        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(ANYONE);
        timelock.execute(address(guard), 0, _accept(), bytes32(0), SALT);

        assertEq(guard.owner(), address(timelock));
    }

    /// Reading the guard is unaffected by who owns it. Integrators see no change.
    function test_observationIsUnaffectedByOwnership() public {
        uint256 stateBefore = uint256(guard.state(address(tok)));
        test_handoverCompletes();
        assertEq(uint256(guard.state(address(tok))), stateBefore);
        (uint256 m,,) = guard.multiplierOf(address(tok));
        assertEq(m, 4e18);
    }
}
