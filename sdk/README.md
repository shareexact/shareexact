# @shareexact/sdk

Zero dependencies. One job: stop your protocol from treating a raw ERC-20 unit
as a share, and stop it from treating a Friday price as a live one.

```ts
import { readStockToken, rpcCaller, isPriceable, sharesToRaw } from "@shareexact/sdk";

const call = rpcCaller("https://rpc.mainnet.chain.robinhood.com");

const nvda = await readStockToken(call, "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", {
  feed: "0x…",          // Chainlink aggregator; omit and you get NO_FEED, not a guess
  maxStaleness: 93_600, // 26h, sized for a 24/5 equity feed
});

nvda.multiplier;   // 1000775159164630595n  — one raw token is 1.0007… shares
nvda.dataState;    // "FRESH" | "STALE" | "ORACLE_PAUSED" | "CORP_ACTION" | ...
nvda.ageSeconds;   // 140_400 on a Sunday afternoon

if (isPriceable(nvda.dataState)) {
  // safe to mark, lend against, liquidate on
}

const raw = sharesToRaw(12n * 10n ** 18n, nvda.multiplier); // exact units for 12 shares
```

## What the states mean

| State | What happened | What you should do |
| --- | --- | --- |
| `FRESH` | Feed inside its heartbeat | Price freely |
| `STALE` | Feed is holding its last value | Normal every weekend and holiday. Do not liquidate on it |
| `ORACLE_PAUSED` | Issuer raised `oraclePaused()` | Advisory only; staleness still governs |
| `CORP_ACTION` | A new `uiMultiplier` activates soon | Do not settle share-denominated quotes across it |
| `SEQUENCER_DOWN` | L2 uptime feed down or in grace | Trust nothing |
| `NO_FEED` | No aggregator configured | Show a dash, not a number |

## Why `isShareConversionExecutable` is weaker than `isPriceable`

Moving shares needs the multiplier. Pricing shares needs the feed. Those fail
independently, so they get separate checks: a weekend transfer is perfectly
safe, and a transfer quoted seconds before a stock split is not.

The precedence order here is identical to `ShareExactGuard.sol`, and both are
covered by tests, so the SDK and the chain cannot give different answers.
