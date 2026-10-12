#!/usr/bin/env node
/**
 * Fail loudly and early on an unsupported Node.
 *
 * The test suite runs TypeScript directly through `--experimental-strip-types`,
 * which needs Node 22.12 or newer. On Node 20 the failure is a stack trace
 * about unsupported syntax, which reads like a broken repository rather than a
 * wrong runtime — and the first person to hit it is whoever clones this to
 * judge it.
 */
const REQUIRED = [22, 12];
const [major, minor] = process.versions.node.split(".").map(Number);

if (major < REQUIRED[0] || (major === REQUIRED[0] && minor < REQUIRED[1])) {
  console.error(
    [
      "",
      `  ShareExact needs Node >= ${REQUIRED.join(".")}; this is ${process.versions.node}.`,
      "",
      "  The unit tests execute TypeScript directly via --experimental-strip-types.",
      "  Install Node 22.12+ (nvm install 22) and run again.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
