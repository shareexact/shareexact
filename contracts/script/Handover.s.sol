// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ShareExactGuard} from "../src/ShareExactGuard.sol";

/// @title Handover
/// @notice Moves ShareExactGuard ownership from the deploying EOA to the timelock.
///
/// @dev The order matters and is not reversible.
///
///      Register the eight feeds FIRST, while the deployer EOA still owns the
///      guard. `Deploy.s.sol` only registers feeds when `owner == deployer`, and
///      once the timelock owns the guard every `setFeed` becomes a scheduled
///      operation that waits out the full delay.
///
///      Ownership is two-step, so the handover is two transactions on two
///      different senders:
///
///        1. EOA       guard.transferOwnership(timelock)    — sets pendingOwner
///        2. timelock  guard.acceptOwnership()              — scheduled, then executed
///
///      Step 2 cannot be sent by the EOA. It has to travel through the timelock,
///      which means schedule, wait, execute. Between the two steps the guard has
///      an EOA owner and a pending timelock owner; nothing is broken in that
///      window, and `transferOwnership` can be re-pointed if the timelock turns
///      out to be wrong.
///
///      REHEARSE ON TESTNET FIRST. If the timelock has no working proposer or no
///      executor, `acceptOwnership()` can never be called, `pendingOwner` stays
///      set, and the guard keeps its EOA owner forever — or worse, a later
///      transfer to a broken address freezes configuration permanently. There is
///      no proxy and no recovery.
///
/// Usage, mainnet — step 1, from the deployer EOA:
///   export PRIVATE_KEY=0x...
///   export GUARD=0x...
///   export TIMELOCK=0x...
///   forge script script/Handover.s.sol --sig "transfer()" --rpc-url robinhood --broadcast
///
/// Usage, mainnet — step 2, calldata to paste into the Safe:
///   forge script script/Handover.s.sol --sig "calldata_()" --rpc-url robinhood
///
/// Usage, testnet rehearsal (deployer is the proposer, short delay):
///   forge script script/Handover.s.sol --sig "rehearseSchedule()" --rpc-url robinhood_testnet --broadcast
///   ... wait out the delay ...
///   forge script script/Handover.s.sol --sig "rehearseExecute()" --rpc-url robinhood_testnet --broadcast
///   forge script script/Handover.s.sol --sig "confirm()" --rpc-url robinhood_testnet
contract Handover is Script {
    /// @dev Fixed salt so the scheduled operation id is reproducible from any
    ///      machine. The id is what you watch for, and what `cancel` takes.
    bytes32 internal constant SALT = keccak256("shareexact.guard.acceptOwnership.v1");

    function _guard() internal view returns (address) {
        return vm.envAddress("GUARD");
    }

    function _timelock() internal view returns (address) {
        return vm.envAddress("TIMELOCK");
    }

    function _acceptCalldata() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(ShareExactGuard.acceptOwnership.selector);
    }

    /*//////////////////////////////////////////////////////////////
                           STEP 1: FROM THE EOA
    //////////////////////////////////////////////////////////////*/

    function transfer() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        ShareExactGuard guard = ShareExactGuard(_guard());
        address timelock = _timelock();

        require(guard.owner() == vm.addr(pk), "deployer does not own the guard");
        require(timelock.code.length > 0, "TIMELOCK has no code");
        // A timelock with no delay is not a timelock.
        require(TimelockController(payable(timelock)).getMinDelay() > 0, "timelock delay is zero");

        (address feed,,) = guard.feedOf(vm.envOr("FEED_CHECK_TOKEN", address(0)));
        if (vm.envOr("FEED_CHECK_TOKEN", address(0)) != address(0)) {
            require(feed != address(0), "feeds not registered yet: register them before handing over");
        }

        vm.startBroadcast(pk);
        guard.transferOwnership(timelock);
        vm.stopBroadcast();

        console2.log("pendingOwner set to:", guard.pendingOwner());
        console2.log("owner still:        ", guard.owner());
        console2.log("");
        console2.log("Now schedule acceptOwnership() from the Safe. Run --sig \"calldata_()\" for the fields.");
    }

    /*//////////////////////////////////////////////////////////////
                    STEP 2: CALLDATA FOR THE SAFE
    //////////////////////////////////////////////////////////////*/

    function calldata_() external view {
        address guard = _guard();
        address timelock = _timelock();
        uint256 delay = TimelockController(payable(timelock)).getMinDelay();
        bytes memory accept = _acceptCalldata();

        bytes memory scheduleCd = abi.encodeWithSelector(
            TimelockController.schedule.selector, guard, uint256(0), accept, bytes32(0), SALT, delay
        );
        bytes memory executeCd = abi.encodeWithSelector(
            TimelockController.execute.selector, guard, uint256(0), accept, bytes32(0), SALT
        );
        bytes32 id = TimelockController(payable(timelock)).hashOperation(guard, 0, accept, bytes32(0), SALT);

        console2.log("--- Safe transaction 1: schedule ---");
        console2.log("to:   ", timelock);
        console2.log("value: 0");
        console2.log("data: ");
        console2.logBytes(scheduleCd);
        console2.log("");
        console2.log("operation id (watch this, and cancel() takes it):");
        console2.logBytes32(id);
        console2.log("");
        console2.log("--- After the delay: execute (anyone can send this) ---");
        console2.log("to:   ", timelock);
        console2.log("value: 0");
        console2.log("data: ");
        console2.logBytes(executeCd);
        console2.log("");
        console2.log("delay (seconds):", delay);
    }

    /*//////////////////////////////////////////////////////////////
                          TESTNET REHEARSAL
    //////////////////////////////////////////////////////////////*/

    function rehearseSchedule() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        TimelockController timelock = TimelockController(payable(_timelock()));
        address guard = _guard();
        bytes memory accept = _acceptCalldata();
        uint256 delay = timelock.getMinDelay();

        vm.startBroadcast(pk);
        timelock.schedule(guard, 0, accept, bytes32(0), SALT, delay);
        vm.stopBroadcast();

        bytes32 id = timelock.hashOperation(guard, 0, accept, bytes32(0), SALT);
        console2.log("scheduled. operation id:");
        console2.logBytes32(id);
        console2.log("ready at (unix):", timelock.getTimestamp(id));
        console2.log("wait, then run --sig \"rehearseExecute()\"");
    }

    function rehearseExecute() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        TimelockController timelock = TimelockController(payable(_timelock()));
        address guard = _guard();
        bytes memory accept = _acceptCalldata();

        bytes32 id = timelock.hashOperation(guard, 0, accept, bytes32(0), SALT);
        require(timelock.isOperationReady(id), "not ready yet: the delay has not elapsed");

        vm.startBroadcast(pk);
        timelock.execute(guard, 0, accept, bytes32(0), SALT);
        vm.stopBroadcast();

        console2.log("executed.");
    }

    function confirm() external view {
        ShareExactGuard guard = ShareExactGuard(_guard());
        address timelock = _timelock();
        address owner = guard.owner();
        console2.log("guard.owner():      ", owner);
        console2.log("expected (timelock):", timelock);
        console2.log("pendingOwner():     ", guard.pendingOwner());
        require(owner == timelock, "handover did not complete");
        require(guard.pendingOwner() == address(0), "pendingOwner should be cleared");
        console2.log("");
        console2.log("Handover complete. Every setFeed / setCorpActionWindow / setSequencerFeed");
        console2.log("from here waits out the timelock delay. Record the timelock in");
        console2.log("deployments/chain-<id>.json so deploy:verify can check it.");
    }
}
