# Deploy runbook

Target: `ShareExactGuard` and `ExactTransfer` live and verified on chain 4663,
addresses recorded in the repository, the desk switched from **preflight** to
**guarded** settlement, and at least one Chainlink feed registered so prices
stop reading "indicative".

Budget about 40 minutes the first time. Do the testnet pass first — it costs
nothing and catches every mistake that matters.

---

## 0. Before you start

You need three things and none of them are code:

**A deployer key.** Generate a fresh one for this. Do not use a wallet that
holds anything.

```bash
cast wallet new
```

Store it outside the repository — `D:\Docker\shareexact\secrets\` or
equivalent. The root `.gitignore` covers `.env` and `*.key`, but the safest key
is one that was never in a project directory at all: a repository that has ever
contained a private key is compromised whether or not the commit was pushed.

**Gas.** ETH is the gas token on both networks.

- Testnet (46630): free, from `https://faucet.testnet.chain.robinhood.com`.
  Robinhood's own support pages point there. QuickNode also runs one at
  `https://faucet.quicknode.com/robinhood/testnet` if the first is empty.
- Mainnet (4663): bridge a small amount through the canonical bridge.
  Deployment plus feed registration is well under 0.01 ETH. Bridging in is
  immediate; bridging back out is the 7-day optimistic window, so send only what
  you are willing to leave there.

Explorers: `https://robinhoodchain.blockscout.com` for mainnet,
`https://explorer.testnet.chain.robinhood.com` for testnet.

**The Chainlink feed addresses.** From Chainlink's published directory for this
chain. Do not copy them from a blog post, and do not let the sync script guess:
`symbolFromPair` uses a regular expression and a wrong ticker means a token
priced by the wrong asset, which is the single worst failure this whole
repository is built to prevent.

---

## 1. Testnet first (chain 46630)

```bash
cd contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts@v5.1.0
forge build
forge test -vv            # 87 tests must be green before anything leaves your machine

export PRIVATE_KEY=0x...
export GUARD_OWNER=$(cast wallet address --private-key $PRIVATE_KEY)
export CORP_ACTION_WINDOW=7200

forge script script/Deploy.s.sol \
  --rpc-url robinhood_testnet \
  --broadcast
```

Then, from the repository root:

```bash
node scripts/record-deployment.mjs --chain 46630
node scripts/verify-deployment.mjs --chain 46630
```

The verifier reads the live chain and checks things `forge test` cannot: that
the address holds bytecode, that `ExactTransfer.guard()` points at the guard you
actually deployed, that the owner is not the zero address, and that an
unregistered token answers `NO_FEED` with a zero multiplier rather than
reverting or claiming 1.0.

If that passes, repeat on mainnet. If it does not, fix it here where it is free.

---

## 2. Mainnet (chain 4663)

```bash
cd contracts
export PRIVATE_KEY=0x...
export GUARD_OWNER=0x...              # see the ownership note below
export CORP_ACTION_WINDOW=7200
export SEQUENCER_FEED=0x...           # Chainlink L2 uptime feed, or omit
export SEQUENCER_GRACE=1800

forge script script/Deploy.s.sol \
  --rpc-url robinhood \
  --broadcast \
  --verify \
  --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api
```

If `--verify` fails during the broadcast — it often does on a young explorer —
deploy anyway and verify afterwards:

```bash
forge verify-contract <GUARD_ADDRESS> src/ShareExactGuard.sol:ShareExactGuard \
  --chain 4663 --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api \
  --constructor-args $(cast abi-encode "constructor(address,uint64)" $GUARD_OWNER 7200)

forge verify-contract <EXACT_TRANSFER_ADDRESS> src/ExactTransfer.sol:ExactTransfer \
  --chain 4663 --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api \
  --constructor-args $(cast abi-encode "constructor(address)" <GUARD_ADDRESS>)
```

Record and verify:

```bash
npm run deploy:record
npm run deploy:verify
```

Then open both explorer links from `deployments/chain-4663.json`, confirm the
source tab shows verified code, and flip `"verified": true` in the JSON. That
field is a claim about something a reviewer can check in one click, so it should
never be true before the click works.

### Small transactions need a bigger gas limit than Foundry estimates

Learned on testnet on 25 Sep, which is the only reason it was not learned on
mainnet after a 24-hour wait.

Chain 4663 is an Arbitrum L2: part of every transaction's gas pays for L1 data,
and that fixed component is charged from the transaction's own gas limit. On a
call needing only ~45k of L2 execution it is a large share of the total, and
Foundry's default estimate does not cover it.

The rehearsal's `execute` was sent with a 62,507 limit, consumed all 62,507 and
reverted — `gasUsed == gasLimit`, the signature of running out. Replaying it
with `cast run` succeeded using 45,255, which proved the logic was fine and only
the limit was wrong. Re-sent with a larger limit it went through. The mainnet
`execute` later used **45,255** — the number the replay had predicted exactly.

Deploys carry enough slack to survive the default. Small calls do not:

```bash
--gas-limit 300000                 # cast send
--gas-estimate-multiplier 400      # forge script
```

on `transferOwnership`, on `schedule`, on `execute`, and on anything else under
a few hundred thousand gas. Unused gas is refunded, so the margin costs nothing.

A failure of this kind loses nothing. A reverted `execute` leaves the timelock
operation still scheduled and still ready, because `_afterCall` never ran. Check
`isOperationReady` and send it again.

### Ownership

On Robinhood Chain mainnet this move is already done. `owner()` is the timelock
`0x1586de8B6eEBf195faC0f8604825dD331aA74d41` as of
[`0x40be6a34…229cd1`](https://robinhoodchain.blockscout.com/tx/0x40be6a3424371ee120bc8e291c905a2c1d956f2653e9bac45b293567df229cd1)
(2026-09-26 20:18:21 UTC, block 73363250). `pendingOwner` is zero. The proposer
is the Safe `0x588BbB3A33E61F081CFa2423FF507682450Ef3aC`.

For a later deployment the verifier prints a note while the owner is still the
deploying EOA. Before anyone lends against that deployment, move it. The target
is a `TimelockController` proposed to by a Safe, not a bare multisig: a solo
operator cannot honestly claim the multisig half, and the half an integrator
actually needs is not "nobody can change the config" but "nobody can change it
without you seeing it first".

**Register the feeds first.** `Deploy.s.sol` registers them only when
`owner == deployer`, and once the timelock owns the guard every `setFeed`
becomes a scheduled operation that waits out the full delay. Doing this in the
wrong order turns eight cheap transactions into eight 24-hour waits.

```bash
# 1. the timelock, with the Safe as proposer
export TIMELOCK_DELAY=86400
export TIMELOCK_PROPOSERS=<SAFE>
forge script script/DeployTimelock.s.sol --rpc-url robinhood --broadcast --verify

# 2. guard + ExactTransfer, owned by the EOA.
#    Feeds are registered in this broadcast only when FEED_TOKENS and
#    FEED_ADDRESSES are both set and GUARD_OWNER is the deployer.
#    With neither variable set, this command registers nothing. Do section 3
#    before step 3 if you still need them.
forge script script/Deploy.s.sol --rpc-url robinhood --broadcast --verify

# 3. point ownership at the timelock. Reversible: owner does not move yet
export GUARD=<GUARD>
export TIMELOCK=<TIMELOCK>
forge script script/Handover.s.sol --sig "transfer()" \
  --rpc-url robinhood --broadcast --gas-estimate-multiplier 400

# 4. calldata for the Safe to schedule acceptOwnership()
forge script script/Handover.s.sol --sig "calldata_()" --rpc-url robinhood
```

Step 4 produces the hex for the Safe's Transaction Builder in **Custom data**
mode: `To` is the timelock, value 0. The Safe cannot `cast send`, and it cannot
call `acceptOwnership()` directly — the timelock is the pending owner, so the
timelock is what must make that call, and it will only make it after the delay.

Before collecting signatures, simulate it. A `0x` return means it will not
revert. The predecessor is `bytes32(0)`, written out in full so it can be
copied:

```bash
cast call <TIMELOCK> "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" \
  <GUARD> 0 0x79ba5097 \
  0x0000000000000000000000000000000000000000000000000000000000000000 \
  <SALT> 86400 --from <SAFE> --rpc-url robinhood
```

After the delay anyone may execute — executors are open, so a lost proposer key
cannot strand an already-public change:

```bash
cast send <TIMELOCK> "execute(address,uint256,bytes,bytes32,bytes32)" \
  <GUARD> 0 0x79ba5097 \
  0x0000000000000000000000000000000000000000000000000000000000000000 \
  <SALT> --gas-limit 300000 \
  --rpc-url robinhood --private-key $PRIVATE_KEY

forge script script/Handover.s.sol --sig "confirm()" --rpc-url robinhood
```

`confirm()` reverts unless `owner == timelock` and `pendingOwner == 0`.

Two-step ownership on purpose: `owner` does not move until `acceptOwnership()`
succeeds, so a wrong address in step 3 is recoverable — point it elsewhere and
try again. The unrecoverable mistake is completing a handover to a timelock with
no working proposer, which freezes configuration for good. Rehearse the whole
chain on testnet first; the ceremony is pinned in
`contracts/test/Handover.t.sol` and has been walked end to end on 46630 and 4663.

Record the result so `deploy:verify` can check it, using the `governance` block
in `deployments/chain-4663.json`. Without it the verifier skips the governance
checks entirely and still reports every other check green — a wrong owner, a
half-finished transfer, a shortened delay, or a proposer that has lost its role
would all pass unnoticed.

---

## 3. Register feeds

This is the step that turns the price banner from "indicative demo marks" into a
live Chainlink read, and it is the one the demo actually depends on.

```bash
export FEED_STALENESS=93600   # 26h — sized for a 24/5 equity feed, see SECURITY.md

cast send <GUARD> "setFeed(address,address,uint64)" \
  <NVDA_TOKEN> <NVDA_FEED> $FEED_STALENESS \
  --rpc-url https://rpc.mainnet.chain.robinhood.com --private-key $PRIVATE_KEY
```

`setFeed` validates the aggregator before storing it: it must have bytecode,
answer `decimals()`, and answer `latestRoundData()`. A wrong address is rejected
at configuration time rather than reported as STALE forever afterwards.

Three or four symbols is enough for a demo. Pick at least one with a multiplier
that is not 1.0 — that is the asset the whole opening argument rests on.

Then mirror the same map into the app so the desk reads them:

```bash
export ROBINHOOD_FEEDS='{"NVDA":{"feed":"0x…","maxStaleness":93600,"decimals":8}}'
```

and record them under `feeds.registered` in the deployment JSON so
`deploy:verify` checks them on every run.

---

## 4. Switch the desk to guarded settlement

```bash
export VITE_EXACT_TRANSFER=<EXACT_TRANSFER_ADDRESS>
npm run dev
```

The Transfer tab badge should now read **Exact settlement** instead of
**Preflight settlement**. That is not cosmetic: preflight computes the raw
amount from a multiplier read seconds earlier, while guarded re-reads it inside
the transaction. Only the second one is exact-share settlement and only the
second one should be demonstrated as such.

---

## 5. Produce the proof transaction

With a wallet holding a Stock Token, send a small share amount to a second
address of your own through the Transfer tab. Take the hash and attach it:

```bash
node scripts/record-deployment.mjs --tx 0x…
```

Then put that hash and both contract addresses at the top of `SUBMISSION.md`.
A reviewer opening the explorer is the first minute of judging; everything else
is downstream of that minute going well.

---

## Done when

- [ ] `npm run deploy:verify` exits zero against chain 4663
- [ ] Both explorer source tabs show verified contracts
- [ ] `"verified": true` in `deployments/chain-4663.json`, set after checking
- [ ] At least three feeds registered, one with a multiplier above 1.0
- [ ] Price banner reads Chainlink with an age, not "indicative"
- [ ] Transfer badge reads "Exact settlement"
- [ ] A guarded-route transaction hash recorded and linked
- [ ] README and SUBMISSION carry the addresses
