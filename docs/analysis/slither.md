# Slither report

```
slither src \
  --solc-remaps "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/" \
  --exclude-informational --exclude-low
```

Run against `contracts/src` with solc 0.8.24. Also wired into CI
(`.github/workflows/ci.yml`, job `analysis`) so it re-runs on every push rather
than being a screenshot in a document.

## Result

**13 contracts, 64 detectors, 17 results. No high-severity finding in ShareExact
code.**

| Detector | Where | Verdict |
| --- | --- | --- |
| `unchecked-transfer` | `ExampleCollateralPool` (2) | **Real. Fixed.** See below |
| `incorrect-exp` | `OpenZeppelin Math.mulDiv` | False positive in a dependency |
| `divide-before-multiply` | `OpenZeppelin Math.mulDiv`, `Math.invMod` | False positive in a dependency |
| `unused-return` | `ExactTransfer` (5), `ExampleCollateralPool` (2) | Intentional tuple destructuring |

## The one real finding

Slither flagged `deposit()` and `liquidate()` in the example pool for ignoring
the boolean returned by `transferFrom` / `transfer`. It was right: a token that
signals failure by returning `false` rather than reverting would have let a
deposit book collateral that never arrived.

Fixed with a low-level call and an explicit return-data check, matching the
`_safeTransferFrom` already used in `ExactTransfer`. An example contract whose
static analysis is dirty teaches the wrong lesson, so it was fixed rather than
annotated away.

## The false positives, briefly

`Math.mulDiv` is OpenZeppelin's 512-bit multiply-divide. Slither reads
`(3 * denominator) ^ 2` as a mistaken exponentiation and the Newton-Raphson
inversion steps as divide-before-multiply. Both are deliberate in a
well-reviewed library and neither is ShareExact code. They are listed here
rather than suppressed, so the numbers in this document match what anyone
re-running the command will see.

## `unused-return`

Every instance is a tuple destructuring that deliberately takes one field:

```solidity
(uint256 multiplier,,) = guard.multiplierOf(token);
```

Slither reports the discarded components as an ignored return value. Assigning
names to unused variables to silence it would make the code worse.

## What this is not

Slither is a linter for contract idioms. It does not know that a stale price
must not be liquidated on, that a multiplier read failure must fail closed, or
that a feed timestamp in the future is hostile. Those are in
`docs/SECURITY.md`, enforced by the 87 Foundry tests, and no static analyser
would have found them.
