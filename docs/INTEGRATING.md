# Integrating ShareExactGuard

For protocol engineers deciding whether to put this contract in front of a
risk-sensitive path. It answers the questions an auditor asks before adding an
external dependency, including the ones where the answer is unflattering.

Guard: [`0xa1042D6bE795d475E5ffe7A333d04e364CBf9da5`](https://robinhoodchain.blockscout.com/address/0xa1042D6bE795d475E5ffe7A333d04e364CBf9da5) · chain 4663 · deployed 25 Sep 2026. The 20 Sep guard `0x290558…db37` is retired.

---

## What problem this is for

A Robinhood Stock Token is an ERC-20 whose raw unit is not one share.
`uiMultiplier()` moves on splits and reinvested dividends. The Chainlink feed
prices **one token** — the multiplier is already in it — so `rawBalance ×
latestRoundData()` is the correct valuation, and Robinhood's docs say so
explicitly. If you are doing that, your unit math is right.

The part that is not enforced on-chain is the *coordination*. Through a split
the feed freezes, the multiplier flips, and the oracle unpauses with both
aligned — which keeps the token price continuous. `oraclePaused()` is advisory;
nothing on-chain makes a round wait for it. If a round prints while a multiplier
change is pending, the price and the unit disagree, and a staleness check will
not flag it, because the round is fresh.

Freshness and unit-correctness are different invariants. This guard reports the
second one.

## State precedence

`state()` returns exactly one value, in this order:

```
SEQUENCER_DOWN
  → (no feed registered)  CORP_ACTION if a change is pending, else NO_FEED
  → STALE
  → ORACLE_PAUSED
  → CORP_ACTION
  → FRESH
```

Consequences worth knowing before you branch on it:

- `CORP_ACTION` means the pause flag is **not** set, `effectiveAt` is inside
  `corpActionWindow()`, and the feed is still fresh. It is the *missed* pause.
- If the pause flag **is** set, you get `ORACLE_PAUSED` instead. Check both if
  you want the official pause and the missed one.
- Staleness is checked first, so a feed older than its configured
  `maxStaleness` returns `STALE` and masks both.
- For a token with no feed registered here, `state()` returns `CORP_ACTION`
  when a change is pending and `NO_FEED` otherwise.

**`NO_FEED` is not a blocker, and the snippet below does not treat it as one.**
`state()` never answers `FRESH` for a token it cannot see, but a gate that
rejects only `CORP_ACTION` and `ORACLE_PAUSED` lets `NO_FEED` through by
design. If you want unknown collateral to fail closed, that is `requireFresh()`
— and you almost certainly do not want it here. These feeds publish 24/5 with a
26h staleness bound, so from Friday's close to Monday's open (~65h) every one of
them is `STALE`. `requireFresh()` would stop your lending every weekend.

## Availability

**`state()` does not revert on a dirty round.** A failed `staticcall`, short
return data, and a dirty boolean are swallowed. `_tryBool` reads the word
directly because `abi.decode(_, (bool))` reverts on anything other than 0 or 1.
`_tryLatestRoundData` does the same for the two `uint80` fields: it loads
`answer` and `updatedAt` with `mload` and never range-checks `roundId` or
`answeredInRound`. A 160-byte payload whose round ids do not fit does not
revert `state()`, `priceOf()`, or `usdValue()`. The retired guard did, and an
earlier revision of this file said the live one still did. That revision is
wrong for `0xa104…9da5`. `_tryUint` is unchanged. A `uint256` word has no range
check, so `multiplierOf` does not revert on a dirty word either.

The sequencer subtraction is guarded against underflow. The adversarial suite
covers dirty booleans, short return data, reverting feeds, future timestamps,
and a dirty `uint80`.

**No upgrade path.** No proxy, no `delegatecall`, no initializer. Both contracts
are immutable; `ExactTransfer.guard` is an `immutable` field. The decode fix
shipped as this guard and as `ExactTransfer`
`0x032f454686d19a4753e4fBE955f5E52e86DEA346`, which points at it.

**No custody.** The guard holds no tokens and has no function that can move
them. The worst case for an integrator is a wrong answer, never a stolen
balance.

**The owner surface, stated precisely.** The owner can call `setFeed`,
`removeFeed`, `setSequencerFeed` and `setCorpActionWindow`. Bounds are enforced
in the contract: `MIN_STALENESS` 60s, `MAX_STALENESS` 7 days,
`MIN_CORP_ACTION_WINDOW` 10 minutes, `MAX_CORP_ACTION_WINDOW` 7 days,
`MAX_SEQUENCER_GRACE` 1 day.

What the owner **cannot** do: the multiplier and `effectiveAt` are read from the
token, never from owner-controlled storage, so the owner cannot forge a
corporate action. `_corpActionImminent` returns false when `effectiveAt` is
zero or already past.

What the owner **can** do, inside those bounds:

- Narrow `corpActionWindow` down to 10 minutes, not to zero. Zero reverts
  `WindowOutOfRange`. Ten minutes still shortens how early a readable pending
  change reports as imminent. An unreadable `newUIMultiplier()` ignores the
  window and fails closed on any future `effectiveAt`.
- Point `setSequencerFeed` at a contract that answers `0` or `1` at
  configuration time and answers `1` later. The check does not stick.
  `state()` then returns `SEQUENCER_DOWN`, and `ExactTransfer` reverts
  `SequencerDown` for every token. On 26 Sep 2026 the live `sequencerFeed` was
  unset, so this lever was not armed. It is still a lever.
- Replace a registered price feed with another contract that passed
  `decimals()` and `latestRoundData()` once. `ExactTransfer` does not read the
  price. `usdValue` does.

Widening the live 7200s window, up to 7 days, is one lever. Narrowing it to
10 minutes is another. Neither is "the owner cannot block you". A sequencer
feed that reports down blocks transfers with no corporate action pending. The
owner today is still the deployer EOA `0x9D2A73430A5D4D8D6Bc1bDb1d376576f57CC9408`.
`pendingOwner` is the timelock `0x1586de8B6eEBf195faC0f8604825dD331aA74d41`.
It cannot accept before 2026-09-26 19:08:35 UTC. Until `acceptOwnership` lands,
the EOA can still change feeds and the window.

Ownership is two-step (`transferOwnership` / `acceptOwnership`).

### Depending on none of that

If the owner surface is unacceptable for your risk path — a reasonable
position — read the token directly through the guard instead:

```solidity
(uint256 current, uint256 pending, uint256 effectiveAt) = GUARD.multiplierOf(token);
```

`multiplierOf` touches no owner-controlled state: not the feed registry, not the
sequencer feed, not the corporate-action window. It reads the token and nothing
else, and it never reverts. Apply your own window and the guard is a decoder,
not a policy dependency.

One caveat on that path, stated plainly: when `newUIMultiplier()` cannot be
read, `multiplierOf` returns `pending == current`. A caller comparing
`pending != current` sees "no change". `unitChangeImminent` and `state()` fail
closed in that same situation and ignore the window. The do-it-yourself path is
slightly less conservative than the built-in one.

## Put this in front of debt creation only

Refusing **new debt** while the unit is ambiguous is unconditionally
conservative: the worst case is a borrow that waits.

```solidity
import {IShareExactGuard} from "shareexact/interfaces/IShareExactGuard.sol";

IShareExactGuard constant GUARD =
    IShareExactGuard(0xa1042D6bE795d475E5ffe7A333d04e364CBf9da5);

error UnitChangePending(address collateral);

// borrow(). Ask the unit question. Do not read it off state().
// STALE and ORACLE_PAUSED outrank CORP_ACTION inside that enum, so a
// pending multiplier change disappears from it whenever the price is also
// unhealthy. unitChangeImminent does not read the feed registry.
(bool unitMoving,) = GUARD.unitChangeImminent(collateral);
if (unitMoving) revert UnitChangePending(collateral);
```

`unitChangeImminent` does not report `ORACLE_PAUSED`. That flag is a price
signal with no duration bound. If you also want to refuse new debt while the
issuer says the oracle is paused, check `state()` for `ORACLE_PAUSED` as a
second condition. Do not use that check as a substitute for the unit call.

**Do not put this gate on `liquidate()`.** Refusing liquidation is a different
risk: it can stop you from closing positions that are genuinely unhealthy, and
the two states are not equally bounded. When both multipliers can be read,
`CORP_ACTION` lasts at most `corpActionWindow()`, 7200s today. When
`newUIMultiplier()` cannot be read, it lasts until `effectiveAt`, which can be
further out than the window. `ORACLE_PAUSED` has no bound; its duration is the
issuer's operational choice.
Blocking forced repayment for an unbounded period is a decision about your own
book, and this contract should not make it for you. If you already refuse to
liquidate on a dead feed, keep that logic yours and do not couple it to an
external dependency.

`ExampleCollateralPool` in this repo refuses to liquidate on anything but
`FRESH`. That is a deliberate choice for that example and it has a real cost:
over a weekend it cannot liquidate at all. It is an illustration of the guard's
states, not a recommendation for your liquidation path.

## What this does not cover

- **Instantaneous corporate actions.** A dividend applied with no future
  `effectiveAt` is not visible in advance. This is a circuit breaker for
  *scheduled* transitions, not a general solution to share-unit/oracle
  atomicity.
- **`state()` still masks a pending change.** For a token with a feed
  registered here, `STALE` outranks `CORP_ACTION`, and `ORACLE_PAUSED` does
  too. `ExactTransfer` does not use that path. It calls `unitChangeImminent`,
  which is why a stale feed no longer lets a transfer through a scheduled
  split. A caller who only branches on `state() == CORP_ACTION` still misses
  it. Use the snippet above, or `multiplierOf` if you will not depend on the
  window.
- **Production history.** This guard was deployed 25 Sep 2026. Robinhood's
  corporate-actions list shows a completed GOOGL cash dividend with process
  date 14 Sep, before either this guard or the retired 20 Sep one. Nothing in
  that list is marked completed since. Later entries, including NVDA on 1 Oct,
  are still in progress. The scheduled path has not been observed against a
  live event. These invariants have run against mocks and a fuzzer, not against
  a real split or dividend.
- **Hostile tokens.** The guard's staticcalls forward all remaining gas. A
  malicious token could grief a caller. Not a concern for canonical Stock
  Tokens; relevant if you ever point this at an arbitrary ERC-20.

## Current status

| | |
| --- | --- |
| Guard owner | deployer EOA `0x9D2A…9408`. Timelock is `pendingOwner`, not accepted |
| Upgradeability | none |
| Tests | 87 Foundry, 0 failed, including the adversarial and hardening suites |
| Audit | none. Reviewed twice externally; both rounds are in `docs/SECURITY.md` |

The owner key is the thing to weigh. Until the timelock accepts, the answer is
still an EOA. Weigh it accordingly, or take the `multiplierOf` path above,
which does not depend on it.
