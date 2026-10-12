# Security

Unaudited. Deployed for a hackathon. This document states what the contracts
assume, what they refuse to assume, and what an external audit would still need
to look at.

## Trust model

| Actor | Power | Bound |
| --- | --- | --- |
| Guard owner | Registers feeds, sets staleness bounds and the sequencer feed | **This is the main trust assumption.** An owner who registers a wrong feed can make a bad price read FRESH. All configuration emits events; ownership transfer is two-step. For anything beyond a demo this key must be a multisig behind a timelock |
| Token issuer | Controls `uiMultiplier` and `oraclePaused` on the Stock Token | Out of scope. If the issuer lies about the ratio, nothing downstream can detect it |
| Chainlink | Supplies price and sequencer uptime | Feed correctness is assumed; freshness is not — that is the entire point of the guard |
| `ExactTransfer` | None | Holds no balance, has no admin function, cannot be upgraded. Spends an existing allowance inside the transfer and retains nothing afterwards |

## Failure policy

The single table that describes the system's behaviour:

| Condition | Behaviour |
| --- | --- |
| Multiplier unreadable | **Revert.** Never assumed to be 1:1 |
| Token has no ERC-8056 surface | Out of scope. Not treated as a 1:1 token |
| Multiplier unreadable in the desk's oracle read | Reported as `unitAvailable: false` and banner-flagged. The registry value stays visible for reference and no share-denominated send executes against it |
| Feed malformed, reverting, or returning a dirty word | Reported STALE / unreadable, never a revert in an observation function |
| Feed timestamp in the future | STALE. A future timestamp is a broken feed, not a fresher one |
| Sequencer down or inside grace | SEQUENCER_DOWN; transfers revert |
| Corporate action imminent | CORP_ACTION; transfers revert |
| Price stale (weekend, holiday) | Pricing blocked, **transfers allowed** |
| Oracle paused by issuer | Pricing blocked, **transfers allowed** |
| Rounding shortfall above the caller's tolerance | Revert, on both routes |
| Rounding shortfall within tolerance | Executes. `ExactShareTransfer` logs the requested shares, the delivered shares and the `maxShortfall` the sender declared, so an indexer can tell an accepted rounding from an unnoticed one |

Two rows deserve emphasis because they look like inconsistencies and are not.
Moving shares needs the multiplier; pricing shares needs the feed. Those fail
independently, so a weekend transfer is safe and a transfer quoted seconds
before a split is not.

## What "never reverts" means here, precisely

An earlier version of this README claimed view functions never revert. That was
an overclaim and has been narrowed:

- **Observation does not revert on a failed call, short data, or a dirty boolean.**
  It does revert when `latestRoundData()` returns 160 bytes and a `uint80`
  field does not fit. That takes `state()`, `priceOf()`, `usdValue()`, and
  `ExactTransfer.quote()` with it. `multiplierOf()` never reads a round, so a
  dirty word there does not revert. This decode is still in the deployed guard.
  See `docs/INTEGRATING.md`.
- **Conversion fails closed.** `sharesToRaw()` and `rawToShares()` revert when
  the multiplier cannot be read, because returning a wrong unit moves a wrong
  amount of money. `usdValue()` is not in that list: a Chainlink feed prices one
  raw token and already includes the multiplier, so valuation never reads it.
  `usdValue` fails closed on price freshness instead, via `allowStale`. That is a deliberate revert, not an
  unhandled one.

All conversions use `Math.mulDiv`, so the intermediate product is held in 512
bits and an arithmetic overflow cannot revert a conversion whose result is
representable.

## Response to the second-round audit

Findings adopted:

| Finding | Action |
| --- | --- |
| Multiplier read failure fell back to 1x | Fixed. `multiplierOf` returns zero; conversions and transfers revert. Regression test: `test_unreadableMultiplierDoesNotFallBackToOne` |
| Direct route ignored `maxShortfall` | Fixed. Both routes enforce the same contract, default tolerance zero, and the UI now requires an explicit checkbox rather than showing a warning. Tests: `exact-transfer.test.ts` |
| Overflow-prone arithmetic and the absolute never-revert claim | Fixed with `Math.mulDiv` and a narrowed claim, above |
| AI endpoints unauthenticated and unbounded | Fixed: auth middleware, per-caller quota, ceilings on every free-text and numeric field. See the caveat below |
| `abi.decode(_, (bool))` reverts on a dirty word | Fixed with a direct word read; values above 1 are "unreadable" |
| Future timestamp underflowed the sequencer grace subtraction | Fixed, and future feed timestamps are now STALE in both the contract and the off-chain twin |
| `setFeed` accepted any address | Fixed: code-length and `decimals()` / `latestRoundData()` validation at configuration time |
| `isTransferSafe` was too broad a name | Renamed to `isShareConversionExecutable`; the old name is a deprecated alias |
| SDK "never throws" was false for a caller-supplied `CallFn` | Fixed with an internal `safeCall` wrapper |
| SDK `feedDecimals` unvalidated | Fixed: integer, 0–36 |
| `sendExactTransfer` hardcoded 18 decimals while preflight took a parameter | Fixed: one exported constant |

Findings adopted with a different fix than proposed:

- **Canonical token registry.** The audit proposed an owner-controlled
  allowlist. Rejected, because it widens the owner's power in the same document
  that flags owner power as the main trust assumption. Fail-closed multiplier
  reads already exclude every token that does not implement ERC-8056, which is
  the same protection without a new privileged role. `ExactTransfer.isSupported`
  exposes the boundary on-chain.
- **`usdValue` scaling.** The proposed replacement,
  `Math.mulDiv(raw, price, 10 ** dec) * 1e18`, is off by a factor of 1e18 and
  truncates to whole units before scaling, discarding every fractional digit.
  The correct single expression is `Math.mulDiv(raw, price, 10 ** dec)`, which is
  what is implemented, with `test_usdValueSurvivesLargeBalances` covering the
  overflow case the finding was really about.
- **AI auth.** Adding `authMiddleware` alone would have been a fix in appearance
  only: with `VITE_AUTH_ENABLED=false` — the shipped default — that middleware
  resolves a shared development user instead of rejecting anonymous callers. The
  middleware is applied, but the controls that actually bound cost are the
  per-caller quota and the input ceilings, and when auth is off the whole
  deployment deliberately shares one bucket.

Fixed after the audit, found while reconciling the docs against the code:

- `oracle.ts` still fell back to a 1.0 multiplier on an unreadable read. Same
  fail-open class as HIGH-1 but on the read path, so the desk would have
  displayed a confident ratio it never obtained. Now reported as
  `unitAvailable: false`.
- An unreadable multiplier could be classified `CORP_ACTION`, because a pending
  value differed from a current value of zero. A unit failure is not a corporate
  action; it now travels in `unitAvailable` and leaves the price state alone.

Third-round reconcilation (docs vs code, 14 Sep). Every leftover claim that
"the three classifiers are identical" and "observation never reverts" hid a
real drift:

- The SDK classifier skipped the future-`updatedAt` → STALE check that the
  contract and `market-state.ts` already had, so a hostile feed timestamp
  classified as FRESH off-chain and STALE on-chain.
- The SDK and `decodeBool` treated any non-zero word as `oraclePaused = true`.
  The contract treats words `> 1` as unreadable. A dirty bool would have paused
  the desk and not the chain.
- The SDK still classified an unreadable current multiplier plus a dangling
  pending as `CORP_ACTION`. The desk's `oracle.ts` had already been fixed; the
  SDK had not. Integrators using only the SDK would have seen a corporate-action
  lock on a token that simply failed to answer `uiMultiplier()`.
- `ExactTransfer.maxShares` called `rawToShares`, which reverts on an
  unreadable multiplier, while `quote()` is documented never to revert. Now
  returns 0.
- Zero-address "example" feed rows in `feeds.generated.json` would have been
  accepted by `feeds.ts` as a configured feed (STALE, not NO_FEED). Rejected.
- Test counts in `contracts/README.md` (35) and `DISCLOSURE.md` (35 then 50)
  did not match the suite. Demo script claimed 95 Stock Tokens.

Found by a third audit round, and by reconciling every written claim against the
code it describes:

- `usdValue` was documented as reverting on an unreadable multiplier. It never
  reads one. Documentation corrected rather than behaviour.
- `VITE_SHAREEXACT_GUARD` appeared in the README environment table and was
  exported but never consumed. Removed: a configuration key that does nothing is
  worse than an undocumented one, because someone will set it and believe it took
  effect.
- `ExactShareTransfer` did not carry the accepted shortfall the security policy
  claimed it recorded. The event now carries it, because consent belongs on
  chain.
- `rpc.ts` described itself as server-only. It is bundled into the client, which
  is the exact misconception that caused a blank-page failure earlier in
  development.
- `maxUiFromRaw` and `previewFromMultiplier` accepted a `decimals` argument that
  cannot be honoured: ERC-8056 fixes the scale at 1e18. Fuzzing showed 0 failures
  in 20,000 cases at 18 decimals and 5,000 of 5,000 at 6. The parameter is now
  validated instead of silently mixing scales.
- `APP_VERSION` and `package.json` disagreed (3.0.5 against 3.0.1).
  `scripts/check-version.mjs` now fails the test run if they drift again.

Found by a fourth review round:

- `_corpActionImminent` returned `false` when `newUIMultiplier()` could not be
  read, while `effectiveAt` said a change was scheduled. That is the one place
  the contract answered "probably fine" to a question it could not read: a
  change is coming and we do not know where to. Now fail-closed — an unreadable
  pending value with a scheduled activation reports `CORP_ACTION`.
- `setSequencerFeed` accepted any address without validation, unlike `setFeed`.
  A wrong address answers nothing, every read becomes `SEQUENCER_DOWN`, and the
  guard silently stops working while appearing careful. Now validated, with a
  1-day ceiling on the grace period.
- The off-chain sequencer check measured its grace period against `Date.now()`
  while the contract measures against `block.timestamp`. Two clocks means the
  desk and the chain can disagree for seconds either side of the boundary, in a
  product whose thesis is that they agree. One clock source now, passed
  explicitly.
- The "direct" transfer route was labelled exact in the API and the UI while the
  documentation admitted a multiplier race. Renamed: `guarded` settlement reads
  the multiplier inside the transaction and is exact by construction;
  `preflight` settlement does not and no longer claims to be.
- `RegistryAsset.multiplier` is now explicitly typed and documented as a
  snapshot with a `multiplierSource` field. It was already excluded from the
  send path; now the type says so.
- `ExampleCollateralPool` ignored ERC-20 return values on its first draft.
  Caught by Slither, fixed, documented in `analysis/slither.md`.

Known and not fixed:

- Guard configuration is single-owner. Two-step transfer and events are in
  place; multisig and timelock are prerequisites for any lending integration and
  are not claimed to exist.
- A hostile token can change its own multiplier inside `transferFrom`. Pinned by
  `test_multiplierMutationDuringTransferSettlesAtQuotedRatio`, which shows the
  transfer settles at the quoted ratio and the contract retains no balance. Out
  of scope for canonical Stock Tokens.
- `MAX_STALENESS` allows up to 7 days. That is a ceiling on operator error, not
  a recommendation; an integrator should apply its own, tighter bound.
- Risk parameters in `risk.ts` are demo heuristics, labelled as such in the UI.
- The AI rate limiter is an in-process map. Across multiple instances the real
  quota is the limit times the instance count. A shared store or an edge limiter
  is the production answer; this is sized to stop a script, not a botnet.
- AI responses are parsed as JSON but not schema-validated, so a model returning
  a nonsense stance or a weight of 9000 would reach the UI. The AI layer is
  advisory and sits off the money path, but this is a real gap.
- The EIP-6963 wallet discovery adds a listener per call rather than using a
  singleton. A lifecycle wart, not a vulnerability.
- `src/lib/multiplayer/p2p.ts` calls an `/api/rtc` route that does not exist in
  this repository. Dead code from the project template; slated for removal.
- Feed configuration has no cryptographic provenance. `feeds.generated.json`
  records its source URL and timestamp but no content hash, so a compromised
  directory would be trusted. Acceptable for a demo, not for production.
- `symbolFromPair` in the feed sync script guesses a ticker with a regular
  expression. A financial parser should demand an explicit symbol field and
  reject otherwise; this one does not yet.
- `change1d` and `afterHours` do not carry the price-provenance labelling that
  `price` does. They come from demo data. Fixing this needs real market history
  and is on the roadmap, not in this build.
- Asset-specific `tradingCapabilities` from the registry are not yet enforced.
  Chain availability and per-asset trading availability are not the same thing.

## Reporting

Open an issue, or for anything exploitable, contact the maintainers privately
before disclosing.
