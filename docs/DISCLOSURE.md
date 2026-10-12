# Prior-work disclosure

Copy this into the hackathon submission form. Colosseum's rules allow work begun
before the start date but judge only what was built inside the window, and
require prior work to be disclosed. Git history in this repo matches what is
written below.

---

**Built before the hackathon window** (commit timestamps 3–13 September):

- The desk UI and its views: brief, holdings, thesis, night, transfer, risk.
- Twelve-language copy and RTL support.
- Robinhood `/rhj/assets` registry integration and batched `balanceOf` wallet
  scanning on chain 4663.
- `conversion.ts`: the BigInt share/raw conversion math and its error types.
- EIP-6963 wallet discovery and chain 4663 add/switch.
- Server-side advisory AI analysis.
- The heuristic risk engine in `risk.ts` (concentration, volatility,
  collateral capacity, stress scenarios).

**Built inside the hackathon window:**

- `contracts/` in full: `ShareExactGuard.sol`, `ExactTransfer.sol`, the ERC-8056
  and Chainlink interfaces, mocks, 87 Foundry tests, deployment script.
- `src/lib/oracle.ts`, `rpc.ts`, `abi.ts`, `feeds.ts`, `market-state.ts`: live
  Chainlink and ERC-8056 reads from chain 4663, the data-state classifier, and
  the feed-configuration layer.
- `src/lib/exact-transfer.ts` and the rewritten `TransferView`: on-chain
  preflight through the user's own wallet and real signed transfers. Before the
  window, the transfer screen only previewed and never sent a transaction.
- Price provenance throughout (`PriceSource`) and the `OracleStatus` banner.
  Before the window, every price in the app was a hardcoded demo number
  presented without distinction from a live one.
- `@shareexact/sdk`.
- `scripts/fetch-feeds.mjs`.
- 55 TypeScript unit tests and 65 Solidity tests covering conversion,
  classification, the ABI codec, the transfer routes, rate limiting, and
  adversarial token and feed behaviour.
- Documentation: README, architecture, security policy and threat model, demo
  script, submission summary, Slither report, this file.
- `ExampleCollateralPool` and its integration suite: a third-party consumer of
  the guard that refuses to liquidate on a stale mark.
- CI pipeline, Slither static analysis, publishable SDK build.
- Security hardening after an external review: fail-closed multiplier reads in
  the contract, the SDK, the oracle layer and the wallet path; `Math.mulDiv`
  conversions; shortfall enforcement on both transfer routes with explicit user
  consent in the UI; auth, per-caller quota and bounded inputs on the AI
  endpoints; adversarial test suite.

**Team:** solo. No outside funding raised.

---

The honest summary of what changed: before the window this was a well-built
interface that described a real problem using invented numbers. Inside the
window it became something that reads the chain, states where every number came
from, and signs a transaction.
