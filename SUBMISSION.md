# ShareExact — submission

**In one sentence:** ShareExact turns the share count you typed into the raw amount the chain will move, and reports a scheduled unit change that a fresh Chainlink round cannot see. It is not general corporate-action protection: a dividend with no future `effectiveAt` is not caught in advance.

**Track:** Robinhood Chain (Ethereum ecosystem) · Colosseum Crypto World's Fair
**Team:** solo — Ali
**Pitch:** [https://youtu.be/mlt8fNUDXaQ](https://youtu.be/mlt8fNUDXaQ) (2:06)
**Technical demo:** [https://youtu.be/TwiEW0ngcT0](https://youtu.be/TwiEW0ngcT0) (2:50)
**Live:** **[shareexact.com](https://shareexact.com)** — the desk, reading chain 4663 and signing transfers today
**Contracts:** written, tested (87 Foundry tests, 0 failed). Redeployed
25 Sep 2026. Current guard `0xa1042D6bE795d475E5ffe7A333d04e364CBf9da5`,
current ExactTransfer `0x032f454686d19a4753e4fBE955f5E52e86DEA346`.
`ExactTransfer` calls `unitChangeImminent` instead of reading the unit off
`state()`. The window cannot be set below 10 minutes. A dirty `uint80` does
not revert observation. Addresses in `deployments/chain-4663.json`. Eight
Chainlink feeds are registered on this guard. The owner is still the deploying
EOA. A timelock is `pendingOwner` and has not accepted. Runbook: `docs/DEPLOY.md`
**Proof of this deployment:** the deploy transactions in the record. No
`ExactShareTransfer` has been sent to `0x032f…A346` yet.

Prior deployment's proof transactions (retired guard `0x2dd1d4c1…`, replaced 20 Sep 2026 for the fix below):
[`0x7a6daf6d…1ada29`](https://robinhoodchain.blockscout.com/tx/0x7a6daf6d88386096d3b1d63bb46903782a78669200f24378098cfdb9be1ada29),
video demo tx [`0x1e8e80f3…9569f3`](https://robinhoodchain.blockscout.com/tx/0x1e8e80f32b847899f02d2c1ac4fdf2eee44bb28583a4372fd00eb23c499569f3)

Earlier direct-route send (before any guard was live):
[`0xf8da86e2…d649555`](https://robinhoodchain.blockscout.com/tx/0xf8da86e2e507b7adfcaacf85e97377956445c40f2b3b063b7e10fc0c3d649555)

---

## Corporate-action fix (20 Sep 2026, retired)

An external review found `ShareExactGuard._evaluate()` returned `NO_FEED` and
stopped before ever checking for a pending corporate action, so
`ExactTransfer` — which at that time blocked only on `CORP_ACTION` and
`SEQUENCER_DOWN` — settled straight across a pending split or dividend on any
Stock Token with no registered price feed. Fixed in commit `4123646` (contract)
and `bad3bae` (SDK/app classifier parity), covered by four regression tests in
`contracts/test/CorpActionCoverage.t.sol`. Because `ExactTransfer.guard` is
immutable, shipping this required a full redeploy: guard
`0x290558b05dec593af7b2ef6dbc26b9ffc38adb37`, ExactTransfer
`0x507b0d8e8558e899af3b511b083f73dfe17168ab`. Those two addresses are retired.
The share transfer on that helper is
[`0x3790392a…68e6b03`](https://robinhoodchain.blockscout.com/tx/0x3790392a8666788f867b0399e5557b77a5ad24764dce1ad9929a2701768e6b03).

## Unit check (25 Sep 2026, current)

`STALE` and `ORACLE_PAUSED` still outrank `CORP_ACTION` inside `state()`, so
reading the unit off the enum let a transfer through a scheduled change
whenever the feed was stale or paused. `ExactTransfer` now calls
`unitChangeImminent`, which reads the token and not the feed registry. The
window has a floor of 10 minutes. Observation loads round words directly.
Covered by `contracts/test/Hardening.t.sol`. Deployed in block 72442933 by
`0x9D2A73430A5D4D8D6Bc1bDb1d376576f57CC9408`. No share has moved through this
ExactTransfer.

## The problem, with a number

On a token with a 4x multiplier, someone moving $10,000 of stock — 25 shares at
$400 — computes 25 raw units the obvious way and sends 100 shares. $40,000. A
$30,000 overshoot, on a transfer that succeeds without a revert or a warning.

## The problem

A Robinhood Stock Token is a standard ERC-20 whose raw unit is not a share. One
raw unit is `uiMultiplier() / 1e18` shares, and that ratio moves on every
reinvested dividend and every split. Separately, the Chainlink feed that prices
it publishes 24/5 while the token trades 24/7.

Wallets and DEXs are unaffected, because they quote raw units and never mark to
an oracle. Everything above them is affected: lending, baskets, structured
products, portfolio and tax surfaces all have to convert to shares themselves,
and each one invents its own rounding, its own staleness policy and its own
corporate-action race. For roughly two thirds of every week, an integration that
does not check `updatedAt` is marking positions against a closed market and does
not know it.

## What we built

| Layer | What it is |
| --- | --- |
| `ShareExactGuard.sol` | Read-only, custody-free state machine: `FRESH`, `STALE`, `ORACLE_PAUSED`, `CORP_ACTION`, `SEQUENCER_DOWN`, `NO_FEED`. The enum is about data, not the NYSE calendar |
| `ExactTransfer.sol` | Moves an exact number of **shares**. Reads the multiplier inside the transaction, so a browser quote cannot settle against a changed ratio |
| `@shareexact/sdk` | Zero-dependency reader with the same precedence order, so other protocols do not rebuild this. Builds to `dist/` and is publishable |
| `ExampleCollateralPool` | Fifty-line third-party consumer of the guard. Declines to liquidate on a stale mark |
| Desk | Reads the registry, balances, multipliers and feeds live; labels every price with its provenance; signs the transfer |

Two design decisions worth a judge's attention:

**A transfer needs the multiplier, not the price.** Those fail independently, so
a weekend `STALE` transfer is allowed and a transfer quoted seconds before a
split is not. `test_weekendStalePriceStillAllowsTransfer` pins it.

**An unreadable multiplier is never assumed to be 1:1.** A contract cannot tell
"no multiplier" from "4x multiplier, call failed"; both arrive as a failed
staticcall. Assuming 1.0 sends four shares for a one-share request. We shipped
that bug, an external review caught it, and it is now fail-closed in the
contract, the SDK, the oracle layer and the wallet path.

## Demo, in order

Follow `docs/DEMO.md` exactly. The desk opens on Transfer by design.

1. Connect a wallet; registry and balances load from chain 4663.
2. Pick an asset whose multiplier is not 1.0; see the naive column against the
   exact column.
3. Sign. Open the Blockscout link.
4. Show staleness: either the live banner on a weekend, or
   `test_staleAfterWeekend`.
5. `forge test` — 87 tests, including `ExampleCollateralPool`: a third-party
   lending pool that refuses to liquidate on a weekend mark.
6. Only then, the risk view, labelled as simulation.

## What is real and what is not

Real: the registry, balances, multipliers, eight Chainlink feeds on the guard,
sequencer status, the contracts, and the signed transfer through ExactTransfer.

Simulation, and labelled in the UI: the stress scenarios and the volatility and
LTV tables in the risk view. These are demo heuristics. This is not a lending
market and does not claim to be one.

Not claimed: an audit. `docs/SECURITY.md` carries the trust model, the full
failure policy, and a point-by-point response to three rounds of external review
including the findings we declined and why.

## Prior work

`docs/DISCLOSURE.md` splits the repository honestly. The UI, the registry
integration and the conversion math predate the hackathon window. The contracts,
the oracle layer, transaction execution, the SDK and the security work do not.
Copy that file into the submission form verbatim.

## Run it

```bash
node --version    # 22.12 or newer
npm install
npm run dev
npm test          # 55 TypeScript tests + 65 Solidity tests
npm run deploy:verify
```

The eight registered names are priced from the Guard. Other names report
`NO_FEED` and the desk labels them indicative rather than presenting a demo
number as a live one.