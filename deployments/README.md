# Deployments

This directory is the single place addresses live. It is not empty.

| | |
| --- | --- |
| Network | Robinhood Chain mainnet, 4663 |
| Record | [`chain-4663.json`](./chain-4663.json) |
| ShareExactGuard | [`0xa1042D6bE795d475E5ffe7A333d04e364CBf9da5`](https://robinhoodchain.blockscout.com/address/0xa1042D6bE795d475E5ffe7A333d04e364CBf9da5) |
| ExactTransfer | [`0x032f454686d19a4753e4fBE955f5E52e86DEA346`](https://robinhoodchain.blockscout.com/address/0x032f454686d19a4753e4fBE955f5E52e86DEA346) |
| Feeds on the guard | 8, verified against `description()`: AAPL GOOGL INTC MSFT NVDA SLV SPY TSLA |
| Share-transfer proof | none on this ExactTransfer. [`0x3790392a…68e6b03`](https://robinhoodchain.blockscout.com/tx/0x3790392a8666788f867b0399e5557b77a5ad24764dce1ad9929a2701768e6b03) settled on the retired 20 Sep helper `0x507b…68ab` |
| Rehearsal | [`chain-46630.json`](./chain-46630.json) on testnet |

`npm run deploy:verify` runs 16 checks against live chain state. That is the
proof, not this paragraph.

`"verified": true` in the JSON is a claim about something a reviewer can check
in one click on the explorer. Set it only after the click works.

The remaining symbols in `src/lib/feeds.generated.json` are shown by the desk
and report `NO_FEED` on-chain until registered. Registering one is a single
transaction and blocked by nothing but gas. `npm run feeds:parity` prints the gap.

## To deploy again

```bash
cd contracts
export PRIVATE_KEY=0x...
export GUARD_OWNER=0x...              # multisig for anything beyond a demo
export FEED_STALENESS=93600           # 26h, sized for a 24/5 equity feed
forge script script/Deploy.s.sol --rpc-url robinhood --broadcast --verify

cd ..
npm run deploy:record                 # writes chain-4663.json from the broadcast
npm run deploy:verify                 # proves it against the live chain
```

Rehearse on testnet (`--chain 46630`) first. Redeploying mainnet changes the
address: the 8 feeds and the proof transaction above would have to be rebuilt.
Do not do that unless the bytecode must change.
