#!/usr/bin/env node
/**
 * Does the desk agree with the chain about which tokens have a price?
 *
 * ShareExact's central claim is that the contract, the app and the SDK give the
 * same answer about whether a price can be trusted. That claim has a quieter
 * precondition nobody checks: they must first agree about which tokens *have* a
 * feed at all.
 *
 * They can drift trivially. `npm run feeds:sync` writes 51 feeds into the app's
 * config in one command; registering them on the guard is 51 separate
 * transactions. The gap is invisible in the UI — the banner counts live prices
 * from the app's config — and a reviewer calling `state()` on a token the desk
 * is happily pricing gets NO_FEED. Same product, two answers.
 *
 * This script makes that gap explicit:
 *
 *   node scripts/check-feed-parity.mjs
 *   node scripts/check-feed-parity.mjs --chain 46630
 *   node scripts/check-feed-parity.mjs --strict     # non-zero exit on any drift
 *
 * Read-only. Sends nothing, needs no key.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const RPC = {
  4663: process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
  46630: process.env.ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com",
};

/** keccak256(signature)[0:4] */
const SELECTOR = {
  feedOf: "0x4b45e8a6", // feedOf(address)
  state: "0x31e658a5", // state(address)
  description: "0x7284e416", // description()
};

const STATE_NAME = ["FRESH", "STALE", "ORACLE_PAUSED", "CORP_ACTION", "SEQUENCER_DOWN", "NO_FEED"];

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const chainId = Number(arg("--chain", "4663"));
const strict = process.argv.includes("--strict");
const rpc = RPC[chainId];

let id = 0;
async function rpcCall(method, params) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

const call = (to, data) => rpcCall("eth_call", [{ to, data }, "latest"]);
const pad = (addr) => addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/** Decode a bare ABI string return (offset, length, bytes). */
function decodeString(hex) {
  if (!hex || hex.length < 130) return "";
  try {
    const len = parseInt(hex.slice(66, 130), 16);
    const bytes = hex.slice(130, 130 + len * 2);
    return Buffer.from(bytes, "hex").toString("utf8").trim();
  } catch {
    return "";
  }
}

async function main() {
  const recordPath = resolve(`deployments/chain-${chainId}.json`);
  if (!existsSync(recordPath)) {
    console.error(`\n  No deployment recorded for chain ${chainId}. Run deploy:record first.\n`);
    process.exit(1);
  }
  const guard = JSON.parse(readFileSync(recordPath, "utf8")).contracts?.ShareExactGuard?.address;
  if (!guard) {
    console.error("\n  No ShareExactGuard address in the deployment record.\n");
    process.exit(1);
  }

  // The app's view: symbol -> feed.
  const generatedPath = resolve("src/lib/feeds.generated.json");
  const appFeeds = existsSync(generatedPath)
    ? (JSON.parse(readFileSync(generatedPath, "utf8")).feeds ?? {})
    : {};

  // The registry's view: symbol -> token address.
  const registry = await fetch("https://api.robinhood.com/rhj/assets").then((r) => r.json());
  const tokens = new Map();
  for (const asset of registry.assets ?? []) {
    const deployment = (asset.deployments ?? []).find((d) => Number(d.chainId) === chainId);
    if (deployment && asset.status === "ASSET_STATUS_ACTIVE") {
      tokens.set(String(asset.tokenSymbol).toUpperCase(), {
        address: deployment.contractAddress,
        multiplier: asset.currentMultiplier,
      });
    }
  }

  console.log(`\n  Feed parity — chain ${chainId}, guard ${guard}\n`);

  const symbols = [...new Set([...Object.keys(appFeeds), ...tokens.keys()])].sort();
  const onlyApp = [];
  const onlyChain = [];
  const mismatched = [];
  const agreed = [];

  for (const symbol of symbols) {
    const token = tokens.get(symbol);
    if (!token) continue; // a feed for a symbol with no token on this chain

    const appFeed = appFeeds[symbol]?.feed ?? null;
    const raw = await call(guard, SELECTOR.feedOf + pad(token.address));
    const chainFeed = raw && raw.length >= 66 ? `0x${raw.slice(26, 66)}` : null;
    const registered = chainFeed && !/^0x0{40}$/.test(chainFeed);

    if (appFeed && !registered) onlyApp.push({ symbol, appFeed, token: token.address });
    else if (!appFeed && registered) onlyChain.push({ symbol, chainFeed, token: token.address });
    else if (appFeed && registered && appFeed.toLowerCase() !== chainFeed.toLowerCase()) {
      mismatched.push({ symbol, appFeed, chainFeed, token: token.address });
    } else if (appFeed && registered) {
      const stateRaw = await call(guard, SELECTOR.state + pad(token.address));
      const desc = decodeString(await call(chainFeed, SELECTOR.description));
      agreed.push({ symbol, state: STATE_NAME[Number(BigInt(stateRaw))] ?? "?", desc });
    }
  }

  if (agreed.length) {
    console.log(`  AGREED (${agreed.length}) — desk and guard both price these`);
    for (const a of agreed) {
      console.log(`    ${a.symbol.padEnd(6)} ${a.state.padEnd(14)} ${a.desc}`);
    }
    console.log("");
  }

  if (mismatched.length) {
    console.log(`  MISMATCHED (${mismatched.length}) — DIFFERENT FEED ADDRESSES. Fix immediately.`);
    for (const m of mismatched) {
      console.log(`    ${m.symbol.padEnd(6)} app ${m.appFeed}  chain ${m.chainFeed}`);
    }
    console.log("");
  }

  if (onlyApp.length) {
    console.log(`  DESK ONLY (${onlyApp.length}) — the desk shows a price, state() says NO_FEED`);
    for (const o of onlyApp.slice(0, 15)) {
      console.log(`    ${o.symbol.padEnd(6)} token ${o.token}  feed ${o.appFeed}`);
    }
    if (onlyApp.length > 15) console.log(`    … and ${onlyApp.length - 15} more`);
    console.log("\n    Register them, or accept the gap knowingly:");
    console.log(
      `      cast send <GUARD> "setFeed(address,address,uint64)" <TOKEN> <FEED> 93600 --rpc-url ${rpc} --private-key $env:PRIVATE_KEY\n`,
    );
  }

  if (onlyChain.length) {
    console.log(`  CHAIN ONLY (${onlyChain.length}) — registered on the guard, missing from the desk`);
    for (const o of onlyChain) console.log(`    ${o.symbol.padEnd(6)} ${o.chainFeed}`);
    console.log("");
  }

  const drift = mismatched.length + onlyApp.length + onlyChain.length;
  console.log(
    drift === 0
      ? "  No drift. The desk and the guard agree about every priced token.\n"
      : `  ${drift} symbols where the desk and the guard disagree.\n`,
  );

  // Mismatched addresses are always fatal: the same symbol pointing at two
  // different feeds means one of them is pricing the wrong asset.
  if (mismatched.length > 0 || (strict && drift > 0)) process.exit(1);
}

main().catch((err) => {
  console.error(`\n  check-feed-parity failed: ${err.message}\n`);
  process.exit(1);
});
