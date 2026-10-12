// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Chainlink-shaped price feed whose answer and timestamp are settable.
contract MockFeed {
    uint8 public decimals;
    int256 internal _answer;
    uint256 internal _updatedAt;
    uint80 internal _roundId = 1;
    bool public reverts;

    constructor(uint8 decimals_, int256 answer_, uint256 updatedAt_) {
        decimals = decimals_;
        _answer = answer_;
        _updatedAt = updatedAt_;
    }

    function description() external pure returns (string memory) {
        return "MOCK / USD";
    }

    function set(int256 answer_, uint256 updatedAt_) external {
        _answer = answer_;
        _updatedAt = updatedAt_;
        _roundId += 1;
    }

    function setReverts(bool value) external {
        reverts = value;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        require(!reverts, "feed down");
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }
}

/// @notice Chainlink L2 Sequencer Uptime Feed shape: answer 0 == up, 1 == down,
///         and `startedAt` is when the current status began.
contract MockSequencerFeed {
    int256 internal _answer;
    uint256 internal _startedAt;

    constructor(int256 answer_, uint256 startedAt_) {
        _answer = answer_;
        _startedAt = startedAt_;
    }

    function decimals() external pure returns (uint8) {
        return 0;
    }

    function set(int256 answer_, uint256 startedAt_) external {
        _answer = answer_;
        _startedAt = startedAt_;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (1, _answer, _startedAt, _startedAt, 1);
    }
}
