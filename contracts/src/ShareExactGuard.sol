// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {DataState, IShareExactGuard} from "./interfaces/IShareExactGuard.sol";

/// @title ShareExactGuard
/// @notice The call every Robinhood Chain protocol should make before it moves
///         money against a Stock Token: what is the exact unit, is the price
///         trustworthy right now, and is a corporate action about to land.
///
/// @dev Design rules this contract holds itself to:
///
///      1. **Read-only and custody-free.** The guard never holds tokens and has
///         no function that can move them. Worst case for an integrator is a
///         wrong answer, never a stolen balance.
///
///      2. **Observation never reverts; conversion fails closed.** `state()` and
///         `priceOf()` swallow failures from third-party tokens and feeds and
///         degrade to an explicit state, because a risk layer that reverts when
///         the market closes is useless precisely when you need it. If the
///         multiplier cannot be read, `sharesToRaw` and `rawToShares` revert
///         rather than guess, because a wrong unit moves the wrong amount of
///         money. `usdValue` does not read the multiplier: the feed already
///         prices one raw token. `requireFresh()` and `usdValue(..., false)`
///         revert unless the price state is `FRESH`.
///
///      3. **Staleness is the primary guard.** Robinhood documents
///         `oraclePaused()` as advisory and not enforced on-chain, so it is
///         treated as a signal on top of the `updatedAt` check, never instead
///         of it.
///
///      4. **No calendar on-chain.** The contract reports STALE; it does not
///         claim to know it is Saturday.
contract ShareExactGuard is IShareExactGuard {
    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error NotOwner();
    error ZeroAddress();
    error StalenessOutOfRange(uint64 maxStaleness);
    error WindowOutOfRange(uint64 window);
    error DataNotFresh(address token, DataState state);
    error NoMultiplier(address token);
    error InvalidFeed(address feed);

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event FeedSet(address indexed token, address indexed feed, uint64 maxStaleness);
    event FeedRemoved(address indexed token);
    event SequencerFeedSet(address indexed feed, uint64 gracePeriod);
    event CorpActionWindowSet(uint64 window);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 internal constant WAD = 1e18;

    /// @dev Lower bound stops an operator from configuring a feed so tightly
    ///      that every read is STALE; upper bound stops a 30-day "fresh" window
    ///      from being waved through.
    uint64 public constant MIN_STALENESS = 60;
    uint64 public constant MAX_STALENESS = 7 days;
    uint64 public constant MIN_CORP_ACTION_WINDOW = 10 minutes;
    uint64 public constant MAX_CORP_ACTION_WINDOW = 7 days;
    uint64 public constant MAX_SEQUENCER_GRACE = 1 days;

    /// @dev ERC-8056 and Robinhood token selectors, called via staticcall so a
    ///      token that does not implement them degrades instead of reverting.
    bytes4 internal constant SEL_UI_MULTIPLIER = 0xa60bf13d; // uiMultiplier()
    bytes4 internal constant SEL_NEW_UI_MULTIPLIER = 0xdc767007; // newUIMultiplier()
    bytes4 internal constant SEL_EFFECTIVE_AT = 0x97a4064f; // effectiveAt()
    bytes4 internal constant SEL_ORACLE_PAUSED = 0x7706ba52; // oraclePaused()

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    struct FeedConfig {
        address feed;
        uint64 maxStaleness;
        uint8 decimals;
    }

    address public owner;
    address public pendingOwner;

    /// @notice Chainlink L2 Sequencer Uptime Feed. Zero disables the check.
    AggregatorV3Interface public sequencerFeed;
    uint64 public sequencerGracePeriod;

    uint64 internal _corpActionWindow;

    mapping(address token => FeedConfig) internal _feeds;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address owner_, uint64 corpActionWindow_) {
        if (owner_ == address(0)) revert ZeroAddress();
        if (corpActionWindow_ < MIN_CORP_ACTION_WINDOW || corpActionWindow_ > MAX_CORP_ACTION_WINDOW) {
            revert WindowOutOfRange(corpActionWindow_);
        }
        owner = owner_;
        _corpActionWindow = corpActionWindow_;
        emit OwnershipTransferred(address(0), owner_);
        emit CorpActionWindowSet(corpActionWindow_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                             CONFIGURATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Register the Chainlink feed that prices one raw unit of `token`.
    /// @param maxStaleness Seconds after which the answer is treated as STALE.
    ///        Set this from the feed's published heartbeat plus headroom — for a
    ///        24/5 equity feed anything below ~1 day will read STALE all weekend.
    function setFeed(address token, address feed, uint64 maxStaleness) external onlyOwner {
        if (token == address(0) || feed == address(0)) revert ZeroAddress();
        if (maxStaleness < MIN_STALENESS || maxStaleness > MAX_STALENESS) {
            revert StalenessOutOfRange(maxStaleness);
        }
        uint8 dec = _validateFeed(feed);
        _feeds[token] = FeedConfig({feed: feed, maxStaleness: maxStaleness, decimals: dec});
        emit FeedSet(token, feed, maxStaleness);
    }

    /// @dev An address with no code, or one that cannot answer `decimals()` and
    ///      `latestRoundData()`, is rejected at configuration time rather than
    ///      silently reported as STALE forever afterwards.
    function _validateFeed(address feed) internal view returns (uint8 dec) {
        if (feed.code.length == 0) revert InvalidFeed(feed);
        try AggregatorV3Interface(feed).decimals() returns (uint8 d) {
            if (d > 36) revert InvalidFeed(feed);
            dec = d;
        } catch {
            revert InvalidFeed(feed);
        }
        (bool ok,,) = _tryLatestRoundData(feed);
        if (!ok) revert InvalidFeed(feed);
    }

    function removeFeed(address token) external onlyOwner {
        delete _feeds[token];
        emit FeedRemoved(token);
    }

    /// @dev Validated on the same terms as `setFeed`. An unvalidated sequencer
    ///      feed is worse than none: a wrong address answers nothing, every read
    ///      becomes SEQUENCER_DOWN, and the whole guard silently stops working
    ///      while looking like it is being careful.
    function setSequencerFeed(address feed, uint64 gracePeriod) external onlyOwner {
        if (gracePeriod > MAX_SEQUENCER_GRACE) revert WindowOutOfRange(gracePeriod);
        if (feed != address(0)) {
            if (feed.code.length == 0) revert InvalidFeed(feed);
            (bool ok, int256 answer, uint256 startedAt) = _tryLatestRoundDataStarted(feed);
            // An uptime feed answers 0 (up) or 1 (down) and carries a start time.
            if (!ok || answer < 0 || answer > 1 || startedAt == 0) revert InvalidFeed(feed);
        }
        sequencerFeed = AggregatorV3Interface(feed);
        sequencerGracePeriod = gracePeriod;
        emit SequencerFeedSet(feed, gracePeriod);
    }

    /// @dev A floor, for the same reason `MIN_STALENESS` exists. The previous
    ///      version accepted zero, and zero does not merely narrow the warning —
    ///      it switches the check off, because `effectiveAt - block.timestamp
    ///      <= 0` is false for every genuinely future activation. An integrator
    ///      gating on `CORP_ACTION` would have gone quiet with no event that
    ///      says "protection disabled". Widening had a ceiling; narrowing had
    ///      nothing.
    function setCorpActionWindow(uint64 window) external onlyOwner {
        if (window < MIN_CORP_ACTION_WINDOW || window > MAX_CORP_ACTION_WINDOW) {
            revert WindowOutOfRange(window);
        }
        _corpActionWindow = window;
        emit CorpActionWindowSet(window);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        address previous = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, owner);
    }

    /// @inheritdoc IShareExactGuard
    function corpActionWindow() public view returns (uint64) {
        return _corpActionWindow;
    }

    /// @inheritdoc IShareExactGuard
    /// @dev The unit question, answered on its own.
    ///
    ///      `state()` returns a single value, and price states outrank the unit
    ///      state inside it: a `STALE` or `ORACLE_PAUSED` feed is reported
    ///      instead of a pending multiplier change that is also true at that
    ///      moment. A consumer that branches on `CORP_ACTION` therefore went
    ///      quiet exactly when the price was also unhealthy — and `ExactTransfer`
    ///      settled across the activation.
    ///
    ///      Registering a price feed made a token *less* protected than leaving
    ///      it unregistered, which is the opposite of what registration should
    ///      do. That is the same defect as the NO_FEED short-circuit fixed on
    ///      20 Sep, one branch further in: the unit fact was still gated behind
    ///      the price.
    ///
    ///      This does not read the feed registry, the staleness bound, or the
    ///      sequencer feed, and it does not revert. It does use
    ///      `corpActionWindow()`, which the owner can move between 10 minutes
    ///      and 7 days. When `newUIMultiplier()` cannot be read, that window is
    ///      ignored and any future `effectiveAt` is imminent.
    function unitChangeImminent(address token) public view returns (bool imminent, uint256 effectiveAt) {
        imminent = _corpActionImminent(token);
        (, uint256 e) = _tryUint(token, SEL_EFFECTIVE_AT);
        effectiveAt = e;
    }

    function feedOf(address token) external view returns (address feed, uint64 maxStaleness, uint8 decimals_) {
        FeedConfig memory cfg = _feeds[token];
        return (cfg.feed, cfg.maxStaleness, cfg.decimals);
    }

    /*//////////////////////////////////////////////////////////////
                                 STATE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IShareExactGuard
    function state(address token) public view returns (DataState) {
        (DataState s,,,) = _evaluate(token);
        return s;
    }

    /// @inheritdoc IShareExactGuard
    function priceOf(address token)
        public
        view
        returns (uint256 price, uint8 decimals_, uint256 updatedAt, DataState dataState)
    {
        (dataState, price, updatedAt, decimals_) = _evaluate(token);
    }

    /// @inheritdoc IShareExactGuard
    function requireFresh(address token) public view {
        DataState s = state(token);
        if (s != DataState.FRESH) revert DataNotFresh(token, s);
    }

    /// @dev Single evaluation path shared by `state`, `priceOf` and `usdValue`
    ///      so the three can never disagree with each other.
    function _evaluate(address token)
        internal
        view
        returns (DataState dataState, uint256 price, uint256 updatedAt, uint8 decimals_)
    {
        // 1. Chain liveness first: on an L2 every other reading is meaningless
        //    while the sequencer is down, because feeds cannot be updated.
        if (!_sequencerOk()) return (DataState.SEQUENCER_DOWN, 0, 0, 0);

        FeedConfig memory cfg = _feeds[token];
        if (cfg.feed == address(0)) {
            // A transfer needs the unit, not the price. Do not hide a pending
            // multiplier change behind NO_FEED.
            if (_corpActionImminent(token)) return (DataState.CORP_ACTION, 0, 0, 0);
            return (DataState.NO_FEED, 0, 0, 0);
        }
        decimals_ = cfg.decimals;

        // 2. Price read. A reverting or malformed feed is treated as STALE
        //    rather than bubbling up, so integrators keep a usable answer.
        (bool ok, int256 answer, uint256 ts) = _tryLatestRoundData(cfg.feed);
        if (!ok || answer <= 0 || ts == 0) return (DataState.STALE, 0, ts, decimals_);
        // A timestamp in the future is not fresher than fresh, it is a broken or
        // hostile feed. Treat it as unusable rather than as maximally current.
        if (ts > block.timestamp) return (DataState.STALE, 0, ts, decimals_);
        price = uint256(answer);
        updatedAt = ts;

        // 3. Staleness is the primary guard and is checked before the advisory
        //    pause flag: a stale price is unusable whether or not it is paused.
        if (block.timestamp > ts && block.timestamp - ts > cfg.maxStaleness) {
            return (DataState.STALE, price, updatedAt, decimals_);
        }

        // 4. Advisory issuer flag.
        (bool pausedOk, bool paused) = _tryBool(token, SEL_ORACLE_PAUSED);
        if (pausedOk && paused) return (DataState.ORACLE_PAUSED, price, updatedAt, decimals_);

        // 5. Imminent corporate action: the multiplier is about to move, so any
        //    share-denominated arithmetic quoted now may settle against a
        //    different ratio. Callers should wait it out rather than guess.
        if (_corpActionImminent(token)) return (DataState.CORP_ACTION, price, updatedAt, decimals_);

        return (DataState.FRESH, price, updatedAt, decimals_);
    }

    function _sequencerOk() internal view returns (bool) {
        AggregatorV3Interface feed = sequencerFeed;
        if (address(feed) == address(0)) return true; // check disabled
        (bool ok, int256 answer, uint256 startedAt) = _tryLatestRoundDataStarted(address(feed));
        if (!ok) return false;
        if (answer != 0) return false; // 0 == up
        if (startedAt == 0) return false;
        // Guard the subtraction: a future `startedAt` would underflow and revert
        // a view function that is documented not to.
        if (startedAt > block.timestamp) return false;
        return block.timestamp - startedAt > sequencerGracePeriod;
    }

    function _corpActionImminent(address token) internal view returns (bool) {
        (bool okEff, uint256 effectiveAt) = _tryUint(token, SEL_EFFECTIVE_AT);
        if (!okEff || effectiveAt == 0) return false;
        if (effectiveAt <= block.timestamp) return false; // already applied
        // FAIL CLOSED. A readable `effectiveAt` in the near future means a
        // multiplier change is scheduled. If `newUIMultiplier()` will not tell us
        // what it changes to, that is the moment to be *more* careful, not less:
        // we know the ratio is about to move and we do not know where to. The
        // previous `return false` here was the one place the contract answered
        // "probably fine" to a question it could not read.
        (bool okNew, uint256 pending) = _tryUint(token, SEL_NEW_UI_MULTIPLIER);
        if (!okNew) return true;
        (bool okCur, uint256 current) = _tryUint(token, SEL_UI_MULTIPLIER);
        if (!okCur || pending == current) return false; // scheduled no-op
        return effectiveAt - block.timestamp <= _corpActionWindow;
    }

    /*//////////////////////////////////////////////////////////////
                          UNITS AND VALUATION
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IShareExactGuard
    /// @dev FAIL CLOSED. An unreadable multiplier returns zero, it does not fall
    ///      back to 1.0.
    ///
    ///      The earlier version returned WAD when `uiMultiplier()` could not be
    ///      read, reasoning that a plain ERC-20 is 1:1. That reasoning is sound
    ///      and the behaviour was still wrong, because the contract cannot tell
    ///      "this token has no multiplier" apart from "this token has a 4x
    ///      multiplier and the call just failed". Collapsing both to 1.0 meant a
    ///      transient read failure on a 4x token would send four shares where
    ///      one was asked for — the exact bug this whole codebase exists to
    ///      prevent, reintroduced by its own error handling.
    ///
    ///      Consequence, accepted deliberately: this guard serves tokens that
    ///      implement ERC-8056. A plain ERC-20 is out of scope rather than
    ///      silently assumed to be 1:1.
    function multiplierOf(address token)
        public
        view
        returns (uint256 current, uint256 pending, uint256 effectiveAt)
    {
        (bool ok, uint256 m) = _tryUint(token, SEL_UI_MULTIPLIER);
        if (!ok || m == 0) return (0, 0, 0);
        current = m;
        (bool okNew, uint256 p) = _tryUint(token, SEL_NEW_UI_MULTIPLIER);
        pending = okNew ? p : current;
        (bool okEff, uint256 e) = _tryUint(token, SEL_EFFECTIVE_AT);
        effectiveAt = okEff ? e : 0;
    }

    /// @inheritdoc IShareExactGuard
    /// @dev raw = floor(uiShares * 1e18 / uiMultiplier)
    function sharesToRaw(address token, uint256 uiShares) public view returns (uint256 raw) {
        (uint256 current,,) = multiplierOf(token);
        if (current == 0) revert NoMultiplier(token);
        // mulDiv keeps the intermediate product in 512 bits, so the conversion
        // is exact across the full uint256 domain instead of reverting on an
        // overflow that never had to happen.
        raw = Math.mulDiv(uiShares, WAD, current);
    }

    /// @inheritdoc IShareExactGuard
    /// @dev uiShares = floor(raw * uiMultiplier / 1e18)
    function rawToShares(address token, uint256 raw) public view returns (uint256 uiShares) {
        (uint256 current,,) = multiplierOf(token);
        if (current == 0) revert NoMultiplier(token);
        uiShares = Math.mulDiv(raw, current, WAD);
    }

    /// @inheritdoc IShareExactGuard
    function usdValue(address token, uint256 raw, bool allowStale) external view returns (uint256 value18) {
        (DataState s, uint256 price, , uint8 dec) = _evaluate(token);
        if (!allowStale && s != DataState.FRESH) revert DataNotFresh(token, s);
        if (price == 0) return 0;
        // The feed prices ONE raw token and already includes the multiplier, so
        // the multiplier must NOT be applied again here.
        //
        // `raw` carries 18 decimals and `price` carries `dec`, so the 18-decimal
        // value is raw * price / 10**dec in a single mulDiv. Scaling the price
        // up first and dividing by WAD afterwards is algebraically the same but
        // rounds twice and can overflow the intermediate; doing it the other way
        // round — dividing to whole units first and multiplying by 1e18 after —
        // would throw away every fractional digit.
        value18 = Math.mulDiv(raw, price, 10 ** dec);
    }

    /*//////////////////////////////////////////////////////////////
                            SAFE STATICCALLS
    //////////////////////////////////////////////////////////////*/

    function _tryUint(address target, bytes4 selector) internal view returns (bool, uint256) {
        (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSelector(selector));
        if (!ok || data.length < 32) return (false, 0);
        return (true, abi.decode(data, (uint256)));
    }

    /// @dev `abi.decode(data, (bool))` reverts on a dirty word (anything other
    ///      than 0 or 1), which would break the never-revert property on a
    ///      malformed third-party token. Read the word directly and treat an
    ///      out-of-range value as "could not read".
    function _tryBool(address target, bytes4 selector) internal view returns (bool, bool) {
        (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSelector(selector));
        if (!ok || data.length < 32) return (false, false);
        uint256 word;
        assembly {
            word := mload(add(data, 32))
        }
        if (word > 1) return (false, false);
        return (true, word == 1);
    }

    /// @dev Words are loaded directly instead of `abi.decode`d.
    ///
    ///      `latestRoundData()` returns `(uint80 roundId, int256 answer,
    ///      uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)`.
    ///      `abi.decode` range-checks the two `uint80` fields and reverts when a
    ///      word does not fit — exactly the trap `_tryBool` already avoids for a
    ///      dirty boolean, and which was left standing here. A feed returning a
    ///      full 160-byte payload with a dirty `roundId` or `answeredInRound`
    ///      therefore reverted `state()`, `priceOf()` and `usdValue()`, all
    ///      three documented never to.
    ///
    ///      This contract never uses `roundId` or `answeredInRound`. The fix is
    ///      to stop reading them at all, so a dirty value in a field we ignore
    ///      cannot take down an observation function.
    function _tryLatestRoundData(address feed) internal view returns (bool ok, int256 answer, uint256 updatedAt) {
        (bool success, bytes memory data) =
            feed.staticcall(abi.encodeWithSelector(AggregatorV3Interface.latestRoundData.selector));
        if (!success || data.length < 160) return (false, 0, 0);
        assembly {
            answer := mload(add(data, 64)) // word 1: answer
            updatedAt := mload(add(data, 128)) // word 3: updatedAt
        }
        ok = true;
    }

    /// @dev Same reasoning as `_tryLatestRoundData`, for the sequencer read.
    function _tryLatestRoundDataStarted(address feed)
        internal
        view
        returns (bool ok, int256 answer, uint256 startedAt)
    {
        (bool success, bytes memory data) =
            feed.staticcall(abi.encodeWithSelector(AggregatorV3Interface.latestRoundData.selector));
        if (!success || data.length < 160) return (false, 0, 0);
        assembly {
            answer := mload(add(data, 64)) // word 1: answer
            startedAt := mload(add(data, 96)) // word 2: startedAt
        }
        ok = true;
    }
}
