# Demo and submission

## The three-minute demo

Order matters. Everything real happens before anything simulated, because the
moment a judge sees a slider they start discounting what came before it.

**0:00 — the problem, in one sentence with a number on screen.**
Open the desk with a connected wallet. Show the live registry count in the
header (ACTIVE Stock Tokens on chain 4663) and a live multiplier that is not 1.0.

> "This token's multiplier is 1.000775. One raw unit is not one share. On a 4x
> token, someone moving $10,000 the obvious way sends $40,000 — and the transfer
> succeeds, with no revert and no warning."

**0:25 — provenance.**
Point at the price banner. On NVDA/AAPL/MSFT/GOOGL/TSLA/SPY/SLV/INTC it should
say Chainlink with an age. Other names still say indicative / `NO_FEED`. Say out
loud that the app refuses to show a mark it cannot source.

**0:50 — the exact transfer. This is the moment.**
Transfer view, pick the highest-multiplier asset, type a share amount. Show the
two columns: what a naive integration would move versus what actually moves.
Sign it. Open the Blockscout link. The recorded proof is the guarded route:
[0x7a6daf6d…1ada29](https://robinhoodchain.blockscout.com/tx/0x7a6daf6d88386096d3b1d63bb46903782a78669200f24378098cfdb9be1ada29).

> "The multiplier was read from the token two seconds before signing, not from
> the registry cache, and not from what the screen was showing."

**1:40 — staleness, shown not claimed.**
If it is a weekend, the banner already reads STALE with an age in days. If not,
show `test_staleAfterWeekend` in the terminal: the feed does not fail, it simply
stops moving, and `latestRoundData()` keeps answering a Friday price.

> "Two thirds of the week, an integration that does not check `updatedAt` is
> marking positions against a closed market and does not know it."

**2:10 — the contract.**
`forge test`. 87 tests. Call out three specifically:
`test_stalenessOutranksPause` (the issuer's pause flag is advisory, so it is
checked after staleness, not instead of it),
`test_weekendStalePriceStillAllowsTransfer` (a transfer needs the multiplier,
not the price — the asymmetry is the design), and
`test_unreadableMultiplierDoesNotFallBackToOne` (an unknown ratio is never
assumed to be 1:1, because a failed read on a 4x token would otherwise move four
shares for a one-share request).

If a judge asks what an external review found, say it plainly: the worst finding
was our own error handling reintroducing the bug the product prevents, it is
fixed, and `docs/SECURITY.md` answers every finding including the three we
declined and why.

**2:25 — somebody else's contract.**
`ExampleCollateralPool` deposits, borrows and liquidates through the guard, and
refuses to liquidate on a stale mark. Fifty lines, and it turns "this is
infrastructure" from a claim into a test that runs.

**2:40 — the simulation, clearly labelled.**
Risk view. Stress scenario, health degradation, suggested action. Say the word
"heuristic" before the judge has to ask.

**2:55 — the close.**

> "Stock Tokens are standard ERC-20s with non-standard financial meaning. We
> made that meaning readable on-chain and enforceable in a transaction, and we
> shipped it as an SDK so the next protocol does not have to rebuild it."

## What not to claim

- Not a production lending market. The LTV and volatility tables are demo
  heuristics and the UI says so.
- The guard is unaudited. Say it before someone asks.
- No affiliation with or endorsement by Robinhood. Do not use their logo.
- Stock Tokens are Regulation S instruments not offered to US persons. The
  frontend should geo-restrict before any public launch.

## Prior-work disclosure

Read `docs/DISCLOSURE.md` and copy it verbatim into the submission form. The UI,
registry integration and conversion math predate the hackathon window; the
contracts, oracle layer, transaction execution and SDK do not. Disclosing this
costs nothing and hiding it risks the entry.

## Checklist

- [x] Guard and ExactTransfer deployed and verified on 4663; addresses in README
      and `deployments/chain-4663.json`. `npm run deploy:verify` is 16/16.
- [x] Eight feeds on the Guard (AAPL GOOGL INTC MSFT NVDA SLV SPY TSLA). Other
      names still report `NO_FEED` / indicative — that is the remaining gap, not
      a missing deploy.
- [x] At least one exact transfer executed on mainnet through ExactTransfer,
      tx hash in the README
      ([0x7a6daf6d…1ada29](https://robinhoodchain.blockscout.com/tx/0x7a6daf6d88386096d3b1d63bb46903782a78669200f24378098cfdb9be1ada29))
- [ ] `npm test` green in CI, visible in the repo
- [ ] `@shareexact/sdk` published, or at minimum installable from the repo
- [ ] Pitch video and technical demo video recorded separately
- [ ] Prior-work disclosure pasted into the submission form
- [ ] 20+ real users tried the desk; feedback written down somewhere quotable
