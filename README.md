# ShareExact

[![CI](https://github.com/aa2hr/shareexact/actions/workflows/ci.yml/badge.svg)](https://github.com/aa2hr/shareexact/actions/workflows/ci.yml)

## Demo

- **Pitch video (2:06):** https://youtu.be/mlt8fNUDXaQ
- **Technical demo (2:50):** https://youtu.be/TwiEW0ngcT0
- **Live app:** https://shareexact.com

**The call every Robinhood Chain protocol should make before it moves money against a Stock Token.**

ShareExact turns the share count you typed into the raw amount the chain will
move, and reports a scheduled unit change that a fresh Chainlink round cannot
see. It is not general corporate-action protection: a dividend with no future
`effectiveAt` is not caught in advance.

Integrators: [`docs/INTEGRATING.md`](docs/INTEGRATING.md).

**Concretely:** on a token with a 4x multiplier, someone moving $10,000 of
stock — 25 shares at $400 — computes 25 raw units the obvious way and sends
100 shares, $40,000, a $30,000 overshoot. The ERC-20 transfer succeeds. No
revert, no warning, no way to tell from the receipt.

A Robinhood Stock Token is a plain ERC-20 whose raw unit is not a share. One raw
unit is `uiMultiplier() / 1e18` underlying shares, and that ratio moves every
time a dividend is reinvested or the underlying splits. Meanwhile the Chainlink
feed that prices it publishes 24/5, while the token itself trades 24/7.

So there are two silent failure modes sitting under every product on this chain:

1. **Unit drift.** Anything that quotes shares — a lending market, a basket, a
   portfolio screen — has to convert to raw units itself, and each one invents
   its own rounding and its own corporate-action race.
2. **Confident staleness.** For roughly two thirds of every week the feed is
   holding a value from the last time the cash market was open. An integration
   that does not check `updatedAt` renders a Friday price as if it were live,
   and a risk engine built on that will happily compute a health factor from it.

ShareExact is the layer that makes both of those explicit: a contract, an SDK,
and a desk that refuses to show a number it cannot source.

---

## Live

| | |
| --- | --- |
| Desk | **[shareexact.com](https://shareexact.com)** |
| ShareExactGuard | [`0xa1042D6bE795d475E5ffe7A333d04e364CBf9da5`](https://robinhoodchain.blockscout.com/address/0xa1042D6bE795d475E5ffe7A333d04e364CBf9da5) |
| ExactTransfer | [`0x032f454686d19a4753e4fBE955f5E52e86DEA346`](https://robinhoodchain.blockscout.com/address/0x032f454686d19a4753e4fBE955f5E52e86DEA346) |
| Deployed | 25 Sep 2026, 18:30 UTC, block 72442933, by `0x9D2A…9408` |
| Share-transfer proof | none on this ExactTransfer. The 20 Sep proof below hit the retired helper |
| Video demo tx | [`0x1e8e80f3…9569f3`](https://robinhoodchain.blockscout.com/tx/0x1e8e80f32b847899f02d2c1ac4fdf2eee44bb28583a4372fd00eb23c499569f3) |
| Record | [`deployments/chain-4663.json`](deployments/chain-4663.json) |
| Chain | Robinhood Chain mainnet, 4663 |
| Feeds | 8 Chainlink feeds registered on the guard, each verified against `description()`: AAPL GOOGL INTC MSFT NVDA SLV SPY TSLA |

Both contracts are on Robinhood Chain mainnet, 4663, redeployed 25 Sep 2026.
`ExactTransfer` asks `unitChangeImminent` rather than inferring the unit from
`state()`, so a stale or paused feed no longer hides a scheduled multiplier
change. The corporate-action window cannot be set below 10 minutes. Round words
are loaded directly, so a dirty `uint80` does not revert `state()`. The eight
feeds were registered on this guard. The owner is still the deploying EOA.
`pendingOwner` is a timelock and has not accepted. That acceptance is not done
until `owner()` is the timelock and `pendingOwner` is zero.

The 20 Sep proof, [`0x3790392a…68e6b03`](https://robinhoodchain.blockscout.com/tx/0x3790392a8666788f867b0399e5557b77a5ad24764dce1ad9929a2701768e6b03),
moved shares through the retired ExactTransfer `0x507b…68ab`. No
`ExactShareTransfer` has been sent to `0x032f…A346`. Do not cite the older hash
as proof of this deployment. `npm run deploy:verify` checks the bytecode's
wiring and the eight feeds. It does not check a share transfer.

None of that has to be taken on trust:

```bash
npm run deploy:verify    # 16 checks against live chain state
npm run feeds:parity     # does the desk agree with the guard about every feed
```

## What is in here

```
contracts/     Foundry project — ShareExactGuard + ExactTransfer + example integration, 87 tests
sdk/           @shareexact/sdk — zero-dependency reader for other protocols
deployments/   Live 4663 record: Guard, ExactTransfer, 8 feeds, proof tx. See deployments/README.md
src/lib/       Oracle reads, ABI codec, data-state classifier, money path
src/components/desk/   The desk UI
docs/          Architecture, deploy runbook, domain setup, security, demo script
```

### `ShareExactGuard.sol`

A read-only, custody-free state machine. Given a token it answers one question:
can this price be trusted right now, and why not.

```solidity
enum DataState { FRESH, STALE, ORACLE_PAUSED, CORP_ACTION, SEQUENCER_DOWN, NO_FEED }
```

The enum is about **data**, not about the NYSE calendar. A contract cannot know
it is Saturday. It can know the feed stopped updating, the sequencer is down,
the issuer paused the oracle, or a multiplier change is imminent — and that is
all this contract claims to know. Session labelling lives off-chain.

Design constraints it holds to:

- **Conversion fails closed. Observation does not revert on a bad round.** A
  failed call, short return data, a dirty boolean, and a `uint80` that does not
  fit do not revert `state()` or `priceOf()`. The round words are loaded
  directly. The retired guard decoded them and could revert. If the multiplier
  cannot be read, `sharesToRaw`, `rawToShares` and a transfer all revert rather
  than guess (`usdValue` does not, because a feed prices one raw token and
  never needs the multiplier). See `docs/INTEGRATING.md` and `docs/SECURITY.md`.
- Staleness outranks the advisory `oraclePaused()` flag, because Robinhood
  documents that flag as not enforced on-chain.
- No custody, no upgradeability, no admin function that can move a token. The
  worst case for an integrator is a wrong answer, never a stolen balance.

### `ExactTransfer.sol`

Moves an exact number of **shares** rather than an exact number of raw units.
The multiplier is read inside the transaction, so a quote built minutes ago in a
browser cannot settle against a ratio that has since changed. Rounding is floor
and the caller states the shortfall it accepts, so truncation cannot pass
unnoticed.

One deliberate asymmetry, and it is the detail worth arguing about in a review:
**a transfer does not need a fresh price, only an intact multiplier.** A weekend
(`STALE`) transfer is allowed. A scheduled multiplier change is not, and that
question is `unitChangeImminent`, not `state() == CORP_ACTION`. `STALE` and
`ORACLE_PAUSED` still outrank `CORP_ACTION` inside the enum. They no longer
hide the change from `ExactTransfer`.

---

## Run it

Node 22.12 or newer is required: the unit tests execute TypeScript directly
through `--experimental-strip-types`. `npm test` checks this first and says so
rather than failing with a syntax error.

```bash
npm install
npm run dev                 # desk on :8080
npm test                    # TypeScript unit tests + Solidity tests
npm run typecheck
```

Contracts on their own:

```bash
cd contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts   # first time only
forge test -vv
```

### Prices

The live Guard on 4663 has eight Chainlink feeds registered (AAPL, GOOGL, INTC,
MSFT, NVDA, SLV, SPY, TSLA). `npm run deploy:verify` and `npm run feeds:parity`
check that the desk and the guard agree about those eight.

A fresh local clone without `ROBINHOOD_FEEDS` still labels unknown names as
indicative / `NO_FEED`. That is intentional: the remaining symbols in
`src/lib/feeds.generated.json` are shown by the desk and are not registered on
the guard. Registering one is a single transaction. To point a local desk at a
feed map:

```bash
FEED_DIRECTORY_URL=<chainlink feed directory for chain 4663> npm run feeds:sync
# or
export ROBINHOOD_FEEDS='{"NVDA":{"feed":"0x…","maxStaleness":93600,"decimals":8}}'
```

Feed addresses are never hardcoded in source. Robinhood's docs point at
Chainlink's published list as the source of truth, and a pinned address is
indistinguishable from a dead market the first time a feed is migrated.

### Environment

| Variable | Purpose |
| --- | --- |
| `ROBINHOOD_RPC_URL` | Dedicated RPC. Falls back to the public endpoint, which is a demo path only |
| `ROBINHOOD_FEEDS` | JSON feed map, highest priority |
| `ROBINHOOD_SEQUENCER_FEED` | Chainlink L2 uptime feed. Empty disables the check |
| `ROBINHOOD_SEQUENCER_GRACE` | Seconds after the sequencer recovers before data is trusted. Default 1800 |
| `ROBINHOOD_CORP_ACTION_WINDOW` | Seconds before a multiplier change to warn. Default 7200 |
| `VITE_EXACT_TRANSFER` | Deployed ExactTransfer address from `deployments/chain-4663.json`. Unset uses the direct-transfer route |

---

## What is real and what is not

Being precise about this is the whole point of the project, so it applies to the
project's own claims too.

**Real, reading live from chain 4663:**
token registry from Robinhood's `/rhj/assets`, balances via batched `balanceOf`,
`uiMultiplier()` / `newUIMultiplier()` / `effectiveAt()` / `oraclePaused()` read
from each token, Chainlink `latestRoundData()` for the eight registered feeds,
sequencer uptime, and signed ERC-20 transfers computed from the live multiplier.

Live exact send through the retired 20 Sep ExactTransfer `0x507b…68ab`:
[0x3790392a8666788f867b0399e5557b77a5ad24764dce1ad9929a2701768e6b03](https://robinhoodchain.blockscout.com/tx/0x3790392a8666788f867b0399e5557b77a5ad24764dce1ad9929a2701768e6b03).
The current helper, deployed 25 Sep 2026, has not yet moved a share.

Prior deployment (17 Sep 2026, retired), 0.002 UI shares →
0.001998450882483378 raw at multiplier `1.000775159164630595`:
[0x7a6daf6d88386096d3b1d63bb46903782a78669200f24378098cfdb9be1ada29](https://robinhoodchain.blockscout.com/tx/0x7a6daf6d88386096d3b1d63bb46903782a78669200f24378098cfdb9be1ada29).

Earlier direct-route send (14 Sep 2026), NVDA 0.0003 UI shares →
`0.000299767632372506` raw:
[0xf8da86e2e507b7adfcaacf85e97377956445c40f2b3b063b7e10fc0c3d649555](https://robinhoodchain.blockscout.com/tx/0xf8da86e2e507b7adfcaacf85e97377956445c40f2b3b063b7e10fc0c3d649555).

Video demo tx (19 Sep 2026), 0.01 NVDA → `0.009992254412416894` raw:
[0x1e8e80f32b847899f02d2c1ac4fdf2eee44bb28583a4372fd00eb23c499569f3](https://robinhoodchain.blockscout.com/tx/0x1e8e80f32b847899f02d2c1ac4fdf2eee44bb28583a4372fd00eb23c499569f3).
This is the transaction shown in the technical demo.

Blockscout reports the raw ERC-20 amount because explorers do not read
`uiMultiplier`. That disagreement is the product.

**Real on the eight registered names; indicative on the rest:** a name the Guard
does not have a feed for reports `NO_FEED` and the desk labels the mark as
indicative. It does not present a demo number as a live one.

**Simulation, and labelled as such in the UI:** the stress scenarios, the
volatility and LTV tables, and the hypothetical credit line in the risk view.
These are demo heuristics for showing the shape of the problem. They are not
credit parameters and nothing in this repo is a lending market.

Stock Tokens are Regulation S instruments issued by Robinhood Assets (Jersey)
Limited and are not offered to US persons. This project is unaffiliated with
Robinhood.

The trust model, the failure policy and an answer to every finding from an
external security review are in `docs/SECURITY.md`. Read it before integrating.
