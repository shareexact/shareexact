// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title DeployTimelock
/// @notice Deploys the contract that will own ShareExactGuard.
///
/// @dev Why a timelock and not just a multisig.
///
///      `SECURITY.md` names multisig *and* timelock as prerequisites for a
///      lending integration. A solo operator cannot honestly deliver the first
///      half: a 1-of-1 Safe is the same key with extra steps. The timelock is
///      the half that can be delivered alone, and it is the half an integrator
///      actually needs — not "nobody can change the config" but "nobody can
///      change it without you seeing it first". A lending protocol reading this
///      guard can watch `CallScheduled` and unwind before a change lands.
///
///      Roles, and why:
///        proposers  — the Safe. Also canceller: OZ 5.x grants CANCELLER_ROLE
///                     to every proposer, so a mistaken schedule can be pulled.
///        executors  — address(0), meaning anyone. Execution after the delay is
///                     not a privilege worth gatekeeping, and an open executor
///                     means a lost key cannot strand an already-public change.
///        admin      — address(0). No superuser. The timelock administers
///                     itself, so even a role change waits out the delay.
///
///      The honest risk, stated here rather than discovered later: if every
///      proposer key is lost, the guard's configuration is frozen permanently.
///      There is no proxy and no escape hatch. Pass two proposers if you can.
///
/// Usage:
///   export PRIVATE_KEY=0x...
///   export TIMELOCK_DELAY=86400                 # seconds; 24h
///   export TIMELOCK_PROPOSERS=0xSafe,0xBackup   # at least one
///   forge script script/DeployTimelock.s.sol --rpc-url robinhood --broadcast --verify
contract DeployTimelock is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        uint256 delay = vm.envOr("TIMELOCK_DELAY", uint256(24 hours));
        address[] memory proposers = vm.envAddress("TIMELOCK_PROPOSERS", ",");

        require(proposers.length > 0, "TIMELOCK_PROPOSERS is empty: the timelock would be unusable");
        for (uint256 i = 0; i < proposers.length; i++) {
            require(proposers[i] != address(0), "proposer is the zero address");
                        // On mainnet the proposer must not be the deploying key, or the
            // timelock is just that key with extra steps. On a rehearsal chain
            // it may be, so the ceremony can be walked with one funded account.
            if (block.chainid == 4663) {
                require(proposers[i] != vm.addr(pk), "proposer is the deployer EOA: that defeats the point");
            }
        }
                // The floor is a mainnet property. On any other chain this is a
        // rehearsal, and the point of a rehearsal is to walk the whole ceremony
        // without waiting out a real notice period.
        if (block.chainid == 4663) {
            require(delay >= 1 hours, "delay under an hour is not notice, it is decoration");
        }

        // Open execution. Anyone may push a scheduled call through once its
        // delay has elapsed; the delay, not the executor set, is the control.
        address[] memory executors = new address[](1);
        executors[0] = address(0);

        vm.startBroadcast(pk);
        TimelockController timelock = new TimelockController(delay, proposers, executors, address(0));
        vm.stopBroadcast();

        console2.log("TimelockController:", address(timelock));
        console2.log("minDelay (seconds):", delay);
        console2.log("proposers:         ", proposers.length);
        console2.log("");
        console2.log("Next: deploy the guard with the deployer EOA as owner so the");
        console2.log("script can register the feeds cheaply, then hand over with");
        console2.log("script/Handover.s.sol. Do not set GUARD_OWNER to this address:");
        console2.log("Deploy.s.sol skips feed registration when it does not own the guard.");
    }
}
