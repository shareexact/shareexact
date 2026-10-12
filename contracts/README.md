# ShareExact contracts

Two contracts. Neither holds a balance, neither can be upgraded, and neither has
an admin function that can move a token.

```bash
forge install foundry-rs/forge-std   # first time only
forge build
forge test -vv                       # 51 tests
```

## ShareExactGuard

A read-only state machine over one question: can this price be trusted right
now.

```solidity
function state(address token) external view returns (DataState);
function priceOf(address token) external view
    returns (uint256 price, uint8 decimals, uint256 updatedAt, DataState);
function requireFresh(address token) external view;
function multiplierOf(address token) external view
    returns (uint256 current, uint256 pending, uint256 effectiveAt);
function sharesToRaw(address token, uint256 uiShares) external view returns (uint256);
function rawToShares(address token, uint256 raw) external view returns (uint256);
function usdValue(address token, uint256 raw, bool allowStale) external view returns (uint256);
```

Owner-only configuration: `setFeed`, `removeFeed`, `setSequencerFeed`,
`setCorpActionWindow`, two-step `transferOwnership` / `acceptOwnership`.

Three properties worth checking in review:

- **Conversion fails closed. Observation does not.** A failed call, short
  return data, a dirty boolean, and a `uint80` that does not fit are all
  swallowed. `state()`, `priceOf()` and `usdValue` load the round words
  directly instead of `abi.decode`, so a dirty round id does not revert them.
  `multiplierOf()` does not read a round. `sharesToRaw` and `rawToShares`
  revert when the multiplier cannot be read. `usdValue` does not read the
  multiplier. `requireFresh()` and `usdValue(..., false)` revert unless the
  price state is `FRESH`. The retired guard at `0x290558…db37` still decoded
  the `uint80` fields and could revert. This one does not.
- **Staleness outranks `oraclePaused()`.** Robinhood documents that flag as
  advisory and not enforced on-chain, so it is a signal on top of the age check,
  never a replacement for it.
- **The feed already includes the multiplier**, so `usdValue` must not apply it
  again. `test_usdValueDoesNotReapplyMultiplier` is the regression guard for the
  double-counting bug that this design invites.

## ExactTransfer

```solidity
function quote(address token, uint256 uiShares) external view
    returns (uint256 raw, uint256 deliveredShares, uint256 multiplier, DataState, bool executable);
function maxShares(address token, address holder) external view returns (uint256);
function transferShares(address token, address to, uint256 uiShares, uint256 maxShortfall)
    external returns (uint256 raw);
```

Requires an ERC-20 approval. Reverts on `CORP_ACTION` and `SEQUENCER_DOWN`, and
on a rounding shortfall larger than the caller declared. Allows `STALE`, on
purpose: moving shares needs an intact multiplier, not a fresh price.

## Deploy

```bash
export PRIVATE_KEY=0x...
export GUARD_OWNER=0x...
export SEQUENCER_FEED=0x...                 # optional
export FEED_TOKENS=0xtoken1,0xtoken2
export FEED_ADDRESSES=0xfeed1,0xfeed2
export FEED_STALENESS=93600                 # 26h

forge script script/Deploy.s.sol --rpc-url robinhood --broadcast --verify
```

Feed addresses come from the environment rather than source, because Chainlink's
published directory is the source of truth and a pinned address is
indistinguishable from a dead market the first time a feed migrates.

## Status

Unaudited. Deployed for a hackathon demo. The rounding, staleness and
corporate-action behaviour is test-covered; the economic parameters an
integrator would layer on top are not part of these contracts and are not
endorsed by them.

## Scope

These contracts serve tokens that implement the ERC-8056 multiplier surface. A
token whose `uiMultiplier()` cannot be read is out of scope and every conversion
against it reverts — it is never assumed to be 1:1, because an unreadable ratio
and a 1:1 ratio are indistinguishable from the outside and guessing wrong moves
the wrong amount of money. `ExactTransfer.isSupported(token)` exposes that
boundary on-chain.

See `../docs/SECURITY.md` for the trust model and the full failure policy.
