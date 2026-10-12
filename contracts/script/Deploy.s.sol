// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ExactTransfer} from "../src/ExactTransfer.sol";
import {ShareExactGuard} from "../src/ShareExactGuard.sol";
import {IShareExactGuard} from "../src/interfaces/IShareExactGuard.sol";

/// @notice Deploys the guard and the transfer helper, then registers feeds.
///
/// Feeds are NOT hardcoded here. Robinhood's own documentation says the
/// Chainlink feed list is the source of truth and should be read from there
/// rather than baked into source, so the script takes them from the
/// environment and the repo keeps a generated file under `app/src/lib/feeds`.
///
/// Usage:
///   export PRIVATE_KEY=0x...
///   export GUARD_OWNER=0x...
///   export SEQUENCER_FEED=0x...            # optional, "" disables the check
///   export FEED_TOKENS=0xtoken1,0xtoken2
///   export FEED_ADDRESSES=0xfeed1,0xfeed2
///   export FEED_STALENESS=93600            # 26h, sized for a 24/5 equity feed
///   forge script script/Deploy.s.sol --rpc-url robinhood --broadcast --verify
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address owner = vm.envOr("GUARD_OWNER", vm.addr(pk));
        uint64 corpActionWindow = uint64(vm.envOr("CORP_ACTION_WINDOW", uint256(2 hours)));
        uint64 staleness = uint64(vm.envOr("FEED_STALENESS", uint256(26 hours)));

        vm.startBroadcast(pk);

        ShareExactGuard guard = new ShareExactGuard(owner, corpActionWindow);
        ExactTransfer exact = new ExactTransfer(IShareExactGuard(address(guard)));

        address sequencer = vm.envOr("SEQUENCER_FEED", address(0));
        if (sequencer != address(0) && owner == vm.addr(pk)) {
            guard.setSequencerFeed(sequencer, uint64(vm.envOr("SEQUENCER_GRACE", uint256(30 minutes))));
        }

        if (owner == vm.addr(pk)) {
            address[] memory tokens = vm.envOr("FEED_TOKENS", ",", new address[](0));
            address[] memory feeds = vm.envOr("FEED_ADDRESSES", ",", new address[](0));
            require(tokens.length == feeds.length, "FEED_TOKENS / FEED_ADDRESSES length mismatch");
            for (uint256 i = 0; i < tokens.length; i++) {
                guard.setFeed(tokens[i], feeds[i], staleness);
            }
            console2.log("feeds registered:", tokens.length);
        }

        vm.stopBroadcast();

        console2.log("ShareExactGuard:", address(guard));
        console2.log("ExactTransfer:  ", address(exact));
        console2.log("owner:          ", owner);
    }
}
