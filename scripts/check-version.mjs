#!/usr/bin/env node
/**
 * The version on screen and the version in the manifest must agree.
 *
 * They drifted once (3.0.5 displayed, 3.0.1 published) and nobody noticed until
 * a reviewer diffed them. A version mismatch is trivial on its own and corrosive
 * in an audit, because it invites the question of what else disagrees.
 */
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const source = readFileSync(new URL("../src/lib/version.ts", import.meta.url), "utf8");
const match = source.match(/APP_VERSION\s*=\s*"([^"]+)"/);

if (!match) {
  console.error("check:version — could not find APP_VERSION in src/lib/version.ts");
  process.exit(1);
}

if (match[1] !== pkg.version) {
  console.error(
    `check:version — APP_VERSION is ${match[1]} but package.json says ${pkg.version}. Make them equal.`,
  );
  process.exit(1);
}

console.log(`check:version — ${pkg.version} ok`);
