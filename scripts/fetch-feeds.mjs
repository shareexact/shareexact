#!/usr/bin/env node
/**
 * Sync Chainlink feed addresses for Robinhood Chain Stock Tokens.
 *
 * Why this is a script and not a constants file: Robinhood's documentation
 * points integrators at Chainlink's published feed list as the source of truth
 * for addresses, decimals and heartbeats. Pinning them in source means shipping
 * a stale address the first time a feed is migrated, and a stale feed address
 * is indistinguishable from a dead market.
 *
 * Usage:
 *   npm run feeds:sync                      # uses FEED_DIRECTORY_URL
 *   FEED_DIRECTORY_URL=https://... npm run feeds:sync
 *   npm run feeds:sync -- --from ./feeds.json
 *
 * Accepted input shapes:
 *   A) Chainlink reference-data-directory: an array of entries with
 *      { proxyAddress|contractAddress, pair|name, decimals, heartbeat }
 *   B) A flat object: { "NVDA": "0xfeed..." }
 *   C) A full object: { "NVDA": { feed, maxStaleness, decimals } }
 *
 * The output is written to src/lib/feeds.generated.json and is the only file
 * the app reads. Nothing here talks to the chain, so it is safe to run in CI.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const OUTPUT = resolve("src/lib/feeds.generated.json");
const DEFAULT_STALENESS = 26 * 60 * 60; // sized for a 24/5 equity feed
const DEFAULT_DECIMALS = 8;
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
}

/**
 * Extract the ticker a feed prices.
 *
 * The first version read `entry.pair[0]` and fell back with `??`. On the
 * Robinhood directory `pair` is `["", ""]` — present, and empty. `??` only
 * catches null and undefined, so every row produced an empty ticker and the
 * whole sync reported zero usable feeds while the file was perfectly fine.
 *
 * The fix is not a longer fallback chain but a change of source. Robinhood's
 * rows carry the ticker in three places that are actually populated:
 *
 *   docs.baseAssetEntityId  "crypto-RHSGOV"          <- most structured
 *   name                    "Robinhood SGOV-USD"
 *   path                    "rhsgov-usd-shared-svr"
 *
 * Each is read in that order, the "RH" issuer prefix is stripped, and a row
 * that yields nothing is skipped loudly rather than silently. Guessing a
 * ticker wrong would bind a token to another asset's price, which is the worst
 * failure this repository exists to prevent — so the caller is told to verify
 * each address against `description()` on-chain before registering it.
 */
function symbolFromEntry(entry) {
  const candidates = [
    entry?.docs?.baseAssetEntityId, // "crypto-RHSGOV"
    entry?.name, // "Robinhood SGOV-USD"
    entry?.path, // "rhsgov-usd-shared-svr"
    Array.isArray(entry?.pair) ? entry.pair[0] : entry?.pair,
    entry?.assetName,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.trim() === "") continue;
    let text = candidate.trim().toUpperCase();

    text = text.replace(/^(CRYPTO|FOREX|EQUITY)-/, ""); // entity-id prefix
    text = text.replace(/^ROBINHOOD\s+/, ""); // "Robinhood SGOV-USD"
    text = text.split(/[/\-_\s]/)[0]; // take the base leg
    text = text.replace(/^RH/, ""); // issuer prefix: RHSGOV -> SGOV

    if (/^[A-Z]{1,6}$/.test(text)) return text;
  }
  return "";
}

function fromDirectory(list) {
  const feeds = {};
  let skipped = 0;

  for (const entry of list) {
    // `proxyAddress` is the stable address integrators call; `contractAddress`
    // is the underlying aggregator and can be replaced without notice.
    // `secondaryProxyAddress` is the SVR variant and is deliberately ignored.
    const address = entry?.proxyAddress ?? entry?.contractAddress ?? entry?.address;
    if (!address || !ADDRESS.test(address)) {
      skipped += 1;
      continue;
    }
    const symbol = symbolFromEntry(entry);
    if (!symbol) {
      skipped += 1;
      continue;
    }

    const heartbeat = Number(entry?.heartbeat ?? 0);
    feeds[symbol] = {
      feed: address,
      // The heartbeat is recorded but does not set the bound. Robinhood equity
      // feeds publish 24/5 with an 86,400s heartbeat, so trusting it directly
      // would give a 48h window and let a genuinely dead feed pass for two
      // days. 26h is tight enough to catch that and loose enough to survive a
      // normal overnight gap; the weekend is meant to read STALE.
      maxStaleness: DEFAULT_STALENESS,
      decimals: Number.isInteger(entry?.decimals) ? entry.decimals : DEFAULT_DECIMALS,
      heartbeat: heartbeat > 0 ? heartbeat : null,
      marketHours: entry?.docs?.marketHours ?? null,
      sourceName: entry?.name ?? null,
    };
  }

  if (skipped > 0) console.log(`  skipped ${skipped} rows with no usable address or ticker`);
  return feeds;
}

function fromObject(object) {
  const feeds = {};
  for (const [symbol, value] of Object.entries(object)) {
    const entry = typeof value === "string" ? { feed: value } : value ?? {};
    if (!entry.feed || !ADDRESS.test(entry.feed)) continue;
    feeds[symbol.toUpperCase()] = {
      feed: entry.feed,
      maxStaleness: Number(entry.maxStaleness) > 0 ? Number(entry.maxStaleness) : DEFAULT_STALENESS,
      decimals: Number.isInteger(entry.decimals) ? entry.decimals : DEFAULT_DECIMALS,
    };
  }
  return feeds;
}

async function load() {
  const file = arg("--from");
  if (file) {
    const text = await readFile(resolve(file), "utf8");
    return { source: `file:${file}`, payload: JSON.parse(text) };
  }
  const url = arg("--url") ?? process.env.FEED_DIRECTORY_URL;
  if (!url) {
    throw new Error(
      "No source. Pass --from <file>, --url <url>, or set FEED_DIRECTORY_URL to the Chainlink feed directory for chain 4663.",
    );
  }
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return { source: url, payload: await res.json() };
}

async function main() {
  const { source, payload } = await load();
  const feeds = Array.isArray(payload)
    ? fromDirectory(payload)
    : Array.isArray(payload?.feeds)
      ? fromDirectory(payload.feeds)
      : fromObject(payload?.feeds ?? payload);

  const count = Object.keys(feeds).length;
  if (count === 0) {
    throw new Error(
      "Parsed zero usable feeds. Check the source shape — expected an array of directory entries or a { SYMBOL: address } object.",
    );
  }

  const output = {
    source,
    generatedAt: new Date().toISOString(),
    note: "Generated by scripts/fetch-feeds.mjs. Do not edit by hand; re-run npm run feeds:sync.",
    feeds,
  };

  await writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`wrote ${count} feeds to ${OUTPUT}`);
  for (const [symbol, cfg] of Object.entries(feeds).slice(0, 10)) {
    console.log(`  ${symbol.padEnd(6)} ${cfg.feed}  staleness ${cfg.maxStaleness}s  (${cfg.sourceName ?? "?"})`);
  }
  if (count > 10) console.log(`  … and ${count - 10} more`);
  console.log(
    "\n  Tickers are derived from the directory's own fields, not guessed from prose,\n" +
      "  but VERIFY before registering: cast call <feed> \"description()(string)\"\n" +
      "  must name the asset you are about to bind. A wrong feed prices a token\n" +
      "  against another company's stock.",
  );
}

main().catch((err) => {
  console.error(`feeds:sync failed — ${err.message}`);
  process.exitCode = 1;
});
