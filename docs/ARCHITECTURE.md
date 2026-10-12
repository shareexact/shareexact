# Architecture

## The thesis in one paragraph

Stock Tokens are standard ERC-20s with non-standard financial meaning. The raw
unit is not a share, the multiplier that relates them moves on corporate
actions, and the price feed underneath publishes on a 24/5 schedule while the
token trades 24/7. Wallets and DEXs are unaffected because they quote raw units
and never mark to an oracle. Everything above them — lending, baskets,
structured products, portfolio and tax surfaces — is affected, and each one is
currently solving it privately, badly, or not at all. ShareExact makes that
meaning legible on-chain, once, so it does not have to be reinvented per
protocol.

## Layers

```
┌──────────────────────────────────────────────────────────────┐
│  Desk UI            brief · holdings · night · transfer · risk │
│                     every price carries its provenance         │
├──────────────────────────────────────────────────────────────┤
│  src/lib            oracle.ts    batched chain reads           │
│                     market-state.ts  off-chain twin of guard   │
│                     exact-transfer.ts  wallet money path       │
│                     abi.ts · rpc.ts · feeds.ts                 │
├──────────────────────────────────────────────────────────────┤
│  @shareexact/sdk    same classifier, zero dependencies,        │
│                     for other protocols on the chain           │
├──────────────────────────────────────────────────────────────┤
│  contracts          ShareExactGuard   data-trust state machine │
│                     ExactTransfer     share-denominated moves  │
├──────────────────────────────────────────────────────────────┤
│  Robinhood Chain 4663   Stock Tokens (ERC-8056) · Chainlink    │
└──────────────────────────────────────────────────────────────┘
```

## The two ideas that are deliberately not merged

**`DataState`** answers "can I trust this price". It is derived only from things
a contract can observe: sequencer status, feed age, the issuer's pause flag, and
a pending multiplier. It lives in `ShareExactGuard.sol` and is mirrored exactly
in `src/lib/market-state.ts` and in the SDK.

**`SessionKind`** answers "what do humans call this time of day" — cash session,
pre-market, after hours, weekend. It is derived from the NYSE calendar, which no
contract can know, and lives only in `src/lib/session.ts`.

Keeping them apart matters because they fail independently. A feed can go stale
at 11am on a Tuesday (that is a problem). A feed is stale at 11am on a Sunday
(that is Sunday). Conflating them produces either false alarms or false comfort.

## Unit correctness and oracle freshness are separate invariants

This is the distinction the whole design turns on, and it is worth drawing,
because most integrations only implement the right-hand branch:

```
                        ShareExact
                             │
          ┌──────────────────┴──────────────────┐
          │                                     │
   unit correctness                     oracle freshness
          │                                     │
   multiplierOf()                       feed state + updatedAt
   reads the token only,                reads the registered feed
   no registry, no owner state          and its configured bound
          │                                     │
   scheduled changes                    STALE / FRESH
          │
   CORP_ACTION · ORACLE_PAUSED
```

A `latestRoundData()` round can be perfectly fresh and still price the wrong
share/unit regime, because the freeze/flip/unpause sequence that keeps the token
price continuous through a corporate action is operational, not enforced
on-chain. A staleness check covers the right branch and sees nothing on the
left.

The two branches are also two ways to integrate. `state()` collapses both into
one value and is the easy path. `multiplierOf()` gives a consumer the left
branch alone, with its own window and no dependency on this contract's owner —
which is the cleaner separation when a protocol wants its risk policy to stay
its own. `docs/INTEGRATING.md` covers both.

## Precedence order

Identical in the contract, the app, and the SDK, and pinned by tests in all
three (`ShareExactGuard.t.sol`, `market-state.test.ts`, `sdk/src/index.test.ts`):

1. `SEQUENCER_DOWN` — on an L2 nothing else is meaningful, because feeds cannot
   be updated while the sequencer is down.
2. **No feed registered** — the evaluation branches here rather than stopping.
   A missing *price* feed does not make the *unit* safe, so a pending multiplier
   change is still reported: `CORP_ACTION` when one is imminent, `NO_FEED`
   otherwise. The earlier flat `NO_FEED` return is what let a transfer settle
   across a pending split on any unregistered token; see the 20 Sep fix in
   `SUBMISSION.md` and `contracts/test/CorpActionCoverage.t.sol`.
3. `STALE` — no answer, a non-positive answer, or an answer older than the
   configured bound.
4. `ORACLE_PAUSED` — the issuer's advisory flag, checked *after* staleness
   because Robinhood documents it as not enforced on-chain.
5. `CORP_ACTION` — a pending multiplier that differs from the current one and
   activates inside the warning window. A scheduled no-op does not count.
6. `FRESH`.

One consequence of 2 and 3 together, worth stating rather than discovering: for
a token that *does* have a feed registered, `STALE` outranks `CORP_ACTION`, so a
stale feed masks a pending change — while an unregistered token reports
`CORP_ACTION` directly. `state()` is single-valued, so something has to lose.
Consumers that care about the unit specifically should read `multiplierOf()`,
which is described above and depends on no registry state at all.

If those three implementations ever drift, a user reading the UI and a contract
reading the chain would disagree about whether a price can be trusted, which is
the exact failure this product exists to prevent. `market-state.test.ts` and
`ShareExactGuard.t.sol` assert the same eleven cases against both.

## Staleness sizing

Robinhood equity feeds follow market hours and explicitly have no heartbeat
off-hours. A bound tighter than roughly one day therefore reports `STALE` every
single weekend, which trains users to ignore the warning. The default is 26
hours: long enough to survive an ordinary overnight gap, short enough to catch a
genuinely dead feed. `setFeed` enforces a floor of 60 seconds and a ceiling of 7
days so an operator cannot configure the check into meaninglessness in either
direction.

## The money path

No JavaScript `Number` appears anywhere between a typed amount and a signed
transaction. A double carries 53 bits of mantissa and an 18-decimal balance
routinely needs more, and the error surfaces as dust that a user experiences as
the app losing their money. `conversion.ts` is `BigInt`-only, written without
TypeScript parameter properties so the whole path runs under
`node --experimental-strip-types --test` with no bundler in the loop.

Rounding is always floor, in both directions, so a conversion can only ever lose
a wei — never create one. `conversion.test.ts` pins the 4× trap and a round trip;
`testFuzz_roundTripNeverInflates` in `ShareExactGuard.t.sol` runs the same
invariant over Foundry's default 256 fuzz pairs.

Two execution routes:

- **direct** — plain `transfer(address,uint256)` with the raw amount computed
  from a multiplier read seconds earlier through the user's own provider. Works
  today against any Stock Token with no deployment and no approval.
- **contract** — `ExactTransfer.transferShares(...)`, which re-reads the
  multiplier inside the transaction and reverts on an imminent corporate action.
  Requires an approval and `VITE_EXACT_TRANSFER`.

The direct route narrows the race window to seconds. The contract route closes
it. The UI shows which one it used, because the difference is real.

## Failure behaviour

The system draws a hard line between **observing** and **converting**, and the
two have opposite failure policies on purpose.

**Observation degrades.** A failed JSON-RPC batch falls back to sequential
calls; a failed call returns `null`; an unreachable, reverting or malformed feed
reports `STALE`; a dirty boolean word from `oraclePaused()` reads as "could not
determine" rather than reverting. One dead feed must not blank out a portfolio,
and a view function that throws when the market closes is a liability in a risk
layer.

**Conversion fails closed.** If `uiMultiplier()` cannot be read, the guard
returns zero and every share conversion and transfer against that token reverts.
It is *not* treated as a 1.0 multiplier.

Valuation is a separate axis and must not be lumped in with conversion, which an
earlier draft of this document did. `usdValue` never reads the multiplier at
all: a Chainlink feed prices one raw token and the multiplier is already inside
that price. It fails closed on a different thing — price freshness, via
`allowStale`. Units and prices fail independently, so they get independent
guards.

That second rule is the one worth defending, because the opposite rule looks
more reasonable at first: a plain ERC-20 really is 1:1, so why not say so? The
answer is that a contract cannot distinguish "this token has no multiplier" from
"this token has a 4x multiplier and the call just failed". Both arrive as a
failed staticcall. Collapsing them to 1.0 means a transient read failure on a 4x
token sends four shares for a one-share request — the exact bug this codebase
exists to prevent, reintroduced through its own error handling. The accepted
cost is narrower scope: these contracts serve tokens implementing ERC-8056, and
`ExactTransfer.isSupported()` states that boundary on-chain.

Prices follow the same principle at the product layer. If no feed is configured
the app does not invent a number — it marks the value indicative and says so in
a banner on every screen.

The full failure table, the trust model and the response to an external security
review are in `SECURITY.md`.

## Deliberately out of scope

Arbitrary ERC-20s, custody, upgradeability, admin keys, pausing, and anything
resembling a lending market. The guard holds no balance and has no privileged function that can move
a token; `ExactTransfer` never holds a balance between transactions
(`test_contractHoldsNoBalance`). Both contracts are small enough to read end to
end in a few minutes, which for an unaudited risk primitive is a feature and not
a limitation.

## Consumers

`contracts/src/examples/ExampleCollateralPool.sol` exists so the word
"primitive" has evidence behind it. It is a fifty-line money market that does
every guard call a real one would — `state()` before accepting collateral,
`usdValue(strict)` before extending credit, `usdValue(allowStale)` for the
health screen so it renders all weekend, and `state()` again before seizing
anything. It refuses to liquidate on a stale mark, which is the one place a
naive port of a crypto money market would do real damage on this chain.

## Next

1. Register real feeds and publish the guard address so other protocols can
   point at it.
2. Derive volatility from on-chain history instead of the hardcoded table in
   `risk.ts`, and drop the hardcoded LTV table entirely once there is something
   defensible to replace it with.
3. Corporate-action ingestion: reconcile `UIMultiplierUpdated` events against
   registry history so a position's total-return basis is auditable.
4. Only then, a testnet collateral vault with explicit caps. Not before the
   invariants above have run against real corporate actions in production.
