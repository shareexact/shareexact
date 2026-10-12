// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal stand-in for a Robinhood Stock Token: a normal ERC-20 with
///         the ERC-8056 multiplier surface and the advisory oracle pause flag.
contract MockStockToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    uint256 internal _uiMultiplier = 1e18;
    uint256 internal _newUIMultiplier = 1e18;
    uint256 internal _effectiveAt;
    bool internal _oraclePaused;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp);

    constructor(string memory name_, string memory symbol_, uint256 multiplier_) {
        name = name_;
        symbol = symbol_;
        _uiMultiplier = multiplier_;
        _newUIMultiplier = multiplier_;
    }

    /*//////////////////////////////// ERC-20 ////////////////////////////////*/

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
        totalSupply += value;
        emit Transfer(address(0), to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) public virtual returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    /*//////////////////////////////// ERC-8056 ////////////////////////////////*/

    function uiMultiplier() external view virtual returns (uint256) {
        if (_effectiveAt != 0 && block.timestamp >= _effectiveAt) return _newUIMultiplier;
        return _uiMultiplier;
    }

    function newUIMultiplier() external view returns (uint256) {
        return _newUIMultiplier;
    }

    function effectiveAt() external view returns (uint256) {
        return _effectiveAt;
    }

    function balanceOfUI(address account) external view returns (uint256) {
        return (balanceOf[account] * _currentMultiplier()) / 1e18;
    }

    function totalSupplyUI() external view returns (uint256) {
        return (totalSupply * _currentMultiplier()) / 1e18;
    }

    function _currentMultiplier() internal view returns (uint256) {
        if (_effectiveAt != 0 && block.timestamp >= _effectiveAt) return _newUIMultiplier;
        return _uiMultiplier;
    }

    function oraclePaused() external view returns (bool) {
        return _oraclePaused;
    }

    /*//////////////////////////////// Test hooks ////////////////////////////////*/

    function scheduleMultiplier(uint256 newMultiplier, uint256 effectiveAt_) public {
        _newUIMultiplier = newMultiplier;
        _effectiveAt = effectiveAt_;
        emit UIMultiplierUpdated(_uiMultiplier, newMultiplier, effectiveAt_);
    }

    function setOraclePaused(bool paused) external {
        _oraclePaused = paused;
    }
}

/// @notice An ordinary ERC-20 with no ERC-8056 surface at all, to prove the
///         guard treats it as out of scope rather than quietly assuming 1:1.
contract PlainToken {
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function transferFrom(address from, address to, uint256 value) public virtual returns (bool) {
        require(allowance[from][msg.sender] >= value, "allowance");
        allowance[from][msg.sender] -= value;
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        return true;
    }
}
