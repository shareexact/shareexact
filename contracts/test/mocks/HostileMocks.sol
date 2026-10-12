// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockStockToken} from "./MockStockToken.sol";

/// @notice `uiMultiplier()` reverts. Models a proxy mid-upgrade, a paused
///         implementation, or simply a bad RPC day surfacing as a failed
///         staticcall. The guard must refuse to guess.
contract RevertingMultiplierToken is MockStockToken {
    constructor() MockStockToken("Broken", "BRK", 4e18) {}

    function uiMultiplier() external pure override returns (uint256) {
        revert("no multiplier");
    }
}

/// @notice `oraclePaused()` returns a dirty word (2). `abi.decode(_, (bool))`
///         reverts on this, which would break the never-revert property of the
///         guard's observation functions.
contract DirtyBoolToken {
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;

    function uiMultiplier() external pure returns (uint256) {
        return 2e18;
    }

    function newUIMultiplier() external pure returns (uint256) {
        return 2e18;
    }

    function effectiveAt() external pure returns (uint256) {
        return 0;
    }

    function oraclePaused() external pure returns (uint256) {
        return 2;
    }
}

/// @notice Answers every call with two bytes. Nothing here is decodable.
contract ShortReturnToken {
    fallback() external {
        assembly {
            mstore(0, 1)
            return(0, 2)
        }
    }
}

/// @notice Changes its own multiplier inside `transferFrom`, so the ratio the
///         caller was quoted is not the ratio in force when the tokens move.
///         Only reachable by a hostile token, but the invariant is worth
///         pinning: the transfer settles at the quoted ratio or not at all.
contract MutatingMultiplierToken is MockStockToken {
    constructor() MockStockToken("Mutating", "MUT", 4e18) {}

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        scheduleMultiplier(8e18, block.timestamp);
        return super.transferFrom(from, to, value);
    }
}

/// @notice Reports a `latestRoundData` timestamp in the future.
contract FutureFeed {
    uint8 public constant decimals = 8;
    uint256 internal immutable _skew;

    constructor(uint256 skew) {
        _skew = skew;
    }

    function description() external pure returns (string memory) {
        return "FUTURE / USD";
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        uint256 ts = block.timestamp + _skew;
        return (1, 178_40_000_000, ts, ts, 1);
    }
}

/// @notice `decimals()` reverts, so the feed cannot be configured.
contract UndecodableFeed {
    function decimals() external pure returns (uint8) {
        revert("nope");
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 1e8, block.timestamp, block.timestamp, 1);
    }
}
