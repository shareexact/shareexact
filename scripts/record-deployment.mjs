#!/usr/bin/env node
/**
 * Turn a `forge script` broadcast into the repository's deployment record.
 *
 * This exists because a deployment that lives only in a terminal scrollback is
 * not a deployment anyone else can verify. A reviewer's first move is to open
 * the explorer, and the address has to be somewhere they can find it without
 * asking. So the run writes `deployments/chain-4663.json`, and the README and
 * the desk read from there.
 *
 * Usage, straight after `forge script script/Deploy.s.sol --broadcast`:
 *
 *   node scripts/record-deployment.mjs
 *   node scripts/record-deployment.mjs --chain 46630          # testnet
 *   node scripts/record-deployment.mjs --tx 0xabc…            # attach a proof tx
 *
 * It reads the broadcast file Foundry already wrote, so there is nothing to
 * copy by hand and nothing to mistype.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const CHAINS = {
  4663: {
    name: "Robinhood Chain mainnet",
    explorer: "https://robinhoodchain.blockscout.com",
  },
  46630: {
    name: "Robinhood Chain testnet",
    explorer: "https://explorer.testnet.chain.robinhood.com",
  },
};

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const chainId = Number(arg("--chain", "4663"));
const chain = CHAINS[chainId];
if (!chain) {
  console.error(`Unknown chain ${chainId}. Known: ${Object.keys(CHAINS).join(", ")}`);
  process.exit(1);
}

const broadcastPath = resolve(
  `contracts/broadcast/Deploy.s.sol/${chainId}/run-latest.json`,
);

if (!existsSync(broadcastPath)) {
  console.error(
    [
      "",
      `  No broadcast found at ${broadcastPath}`,
      "",
      "  Deploy first:",
      "    cd contracts",
      "    forge script script/Deploy.s.sol --rpc-url robinhood --broadcast --verify",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const broadcast = JSON.parse(readFileSync(broadcastPath, "utf8"));

/** Foundry records every CREATE in `transactions`; pick out the two we care about. */
function addressOf(name) {
  const tx = broadcast.transactions?.find(
    (t) => t.transactionType === "CREATE" && t.contractName === name,
  );
  return tx?.contractAddress ?? null;
}

const guard = addressOf("ShareExactGuard");
const exactTransfer = addressOf("ExactTransfer");

if (!guard || !exactTransfer) {
  console.error(
    `Could not find both contracts in the broadcast. Guard=${guard} ExactTransfer=${exactTransfer}`,
  );
  process.exit(1);
}

let commit = "unknown";
try {
  commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
} catch {
  // Not a git checkout, or git is unavailable. The record is still useful
  // without a commit, so this is not fatal.
}

const outPath = resolve(`deployments/chain-${chainId}.json`);
const previous = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : {};

const record = {
  chainId,
  network: chain.name,
  deployedAt: new Date().toISOString(),
  commit,
  deployer: broadcast.transactions?.[0]?.transaction?.from ?? null,
  contracts: {
    ShareExactGuard: {
      address: guard,
      explorer: `${chain.explorer}/address/${guard}`,
      verified: false,
    },
    ExactTransfer: {
      address: exactTransfer,
      guard,
      explorer: `${chain.explorer}/address/${exactTransfer}`,
      verified: false,
    },
  },
  feeds: previous.feeds ?? {
    note: "Symbol -> { feed, maxStaleness, decimals } as registered on the guard.",
    registered: {},
  },
  proofTransactions: {
    ...(previous.proofTransactions ?? {}),
    ...(arg("--tx") ? { exactShareTransfer: arg("--tx") } : {}),
  },
};

mkdirSync(resolve("deployments"), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

console.log(`
  Recorded ${outPath}

    ShareExactGuard  ${guard}
    ExactTransfer    ${exactTransfer}

  Next:

    1. Verify on Blockscout, then flip "verified" to true in the JSON:
         cd contracts
         forge verify-contract ${guard} src/ShareExactGuard.sol:ShareExactGuard \\
           --chain ${chainId} --verifier blockscout \\
           --verifier-url ${chain.explorer}/api

    2. Point the desk at the deployed helper so it uses guarded settlement:
         VITE_EXACT_TRANSFER=${exactTransfer}

    3. Prove it works against the live chain:
         node scripts/verify-deployment.mjs --chain ${chainId}
`);
