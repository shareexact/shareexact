/**
 * The money path, executed against the user's wallet.
 *
 * Everything here reads through the wallet's own provider rather than the app
 * server, for one reason: the numbers a user signs must come from the same node
 * that will execute the transaction. A quote assembled server-side and shipped
 * to the browser is a quote that can already be wrong by the time it is signed.
 *
 * Two routes are supported:
 *
 *   guarded   — `ExactTransfer.transferShares(...)` re-reads the multiplier
 *               inside the transaction itself and reverts if a corporate action
 *               is about to land. Requires an approval and the deployed address
 *               in `VITE_EXACT_TRANSFER`. This is exact-share settlement.
 *   preflight — a plain `transfer(address,uint256)` of a raw amount computed
 *               from a multiplier read moments earlier. No approval, no extra
 *               contract, works today against any Stock Token. This is NOT
 *               exact-share settlement, and neither the API nor the UI calls it
 *               that: the multiplier can move between the read and the block.
 *
 * The preflight route narrows the race window to seconds. The guarded route
 * closes it. The UI names which one it used, in those words.
 */

import {
  decodeBool,
  decodeUint,
  encodeAllowance,
  encodeApprove,
  encodeBalanceOf,
  encodeTransfer,
  encodeTransferShares,
  SELECTORS,
} from "./abi.ts";
import { parseDecimalToBigInt } from "./conversion.ts";
import type { EthereumProvider } from "./wallet.ts";

const WAD = 10n ** 18n;

export const EXACT_TRANSFER_ADDRESS: string =
  (import.meta.env?.VITE_EXACT_TRANSFER as string | undefined)?.trim() ?? "";

/**
 * How a transfer settles, named for what it actually guarantees.
 *
 * `guarded` — `ExactTransfer.transferShares`. The multiplier is read inside the
 *   transaction that moves the tokens, so the share count is exact by
 *   construction. This is the only mode that earns the word "exact".
 *
 * `preflight` — a plain ERC-20 `transfer` of a raw amount computed from a
 *   multiplier read moments earlier. Between the `eth_call` and the block that
 *   includes the transaction, the multiplier can change, and then the raw amount
 *   no longer represents the share count the user asked for. The window is
 *   seconds and a real corporate action is scheduled hours ahead, so it is small
 *   — but small is not zero, and a product that calls itself exact should not
 *   quietly round that down.
 *
 * An external reviewer put it plainly: the docs admitted the race while the API
 * and the UI kept saying "exact" in both modes. The name is the fix.
 */
export type TransferRoute = "guarded" | "preflight";

export const ROUTE_LABEL: Record<TransferRoute, { title: string; detail: string }> = {
  guarded: {
    title: "Exact settlement",
    detail:
      "ExactTransfer reads the multiplier inside the transaction and reverts if a corporate action is imminent. The share count is exact by construction.",
  },
  preflight: {
    title: "Preflight settlement",
    detail:
      "A direct ERC-20 transfer of a raw amount computed seconds ago. If the multiplier changes before the block lands, the amount will not represent the shares requested. Deploy ExactTransfer and set VITE_EXACT_TRANSFER for exact settlement.",
  },
};

export interface Preflight {
  /** Live multiplier read from the token, 18-decimal fixed point. */
  multiplier: bigint;
  pendingMultiplier: bigint | null;
  effectiveAt: number | null;
  oraclePaused: boolean;
  /** Raw ERC-20 units that will move. */
  raw: bigint;
  /** Shares those raw units actually represent after floor rounding. */
  delivered: bigint;
  /** Shares lost to rounding. */
  shortfall: bigint;
  /** What a naive integration would have moved: the typed number as raw units. */
  naiveRaw: bigint;
  /** Shares a naive integration would really have sent. */
  naiveShares: bigint;
  rawBalance: bigint;
  fits: boolean;
  /** True when a scheduled multiplier change lands inside the warning window. */
  corpActionImminent: boolean;
  route: TransferRoute;
  blockers: string[];
  warnings: string[];
}

export class PreflightError extends Error {}

/** Raised when floor rounding would lose more shares than the caller accepted. */
export class ShortfallError extends PreflightError {
  readonly shortfall: bigint;
  readonly accepted: bigint;

  constructor(message: string, shortfall: bigint, accepted: bigint) {
    super(message);
    this.shortfall = shortfall;
    this.accepted = accepted;
  }
}

async function ethCall(provider: EthereumProvider, to: string, data: string): Promise<string | null> {
  try {
    const result = (await provider.request({
      method: "eth_call",
      params: [{ to, data }, "latest"],
    })) as string;
    return result && result !== "0x" ? result : null;
  } catch {
    return null;
  }
}

export const CORP_ACTION_WARNING_WINDOW = 2 * 60 * 60;

/**
 * Reads the token's live state through the wallet and computes exactly what
 * would move. Never sends anything.
 */
export async function preflightTransfer(
  provider: EthereumProvider,
  params: { token: string; holder: string; amount: string; decimals?: number },
): Promise<Preflight> {
  const { token, holder } = params;
  const decimals = params.decimals ?? 18;

  let uiShares: bigint;
  try {
    uiShares = parseDecimalToBigInt(params.amount, decimals);
  } catch (err) {
    throw new PreflightError(err instanceof Error ? err.message : "Invalid amount");
  }
  if (uiShares <= 0n) throw new PreflightError("Amount must be greater than zero.");

  const [multiplierHex, pendingHex, effectiveHex, pausedHex, balanceHex] = await Promise.all([
    ethCall(provider, token, SELECTORS.uiMultiplier),
    ethCall(provider, token, SELECTORS.newUIMultiplier),
    ethCall(provider, token, SELECTORS.effectiveAt),
    ethCall(provider, token, SELECTORS.oraclePaused),
    ethCall(provider, token, encodeBalanceOf(holder)),
  ]);

  // FAIL CLOSED. An unreadable multiplier is not evidence of a 1:1 token; it is
  // evidence that we do not know the ratio. Assuming 1.0 here would send four
  // shares for a one-share request on a 4x token whose read happened to fail.
  const multiplier = decodeUint(multiplierHex);
  if (multiplier === null || multiplier <= 0n) {
    throw new PreflightError(
      "Could not read this token's uiMultiplier. ShareExact will not assume a 1:1 ratio.",
    );
  }
  const pendingMultiplier = decodeUint(pendingHex);
  const effectiveRaw = decodeUint(effectiveHex);
  const effectiveAt = effectiveRaw && effectiveRaw > 0n ? Number(effectiveRaw) : null;
  const oraclePaused = decodeBool(pausedHex) ?? false;
  const rawBalance = decodeUint(balanceHex) ?? 0n;

  const raw = (uiShares * WAD) / multiplier;
  const delivered = (raw * multiplier) / WAD;
  const shortfall = uiShares > delivered ? uiShares - delivered : 0n;
  const naiveRaw = uiShares;
  const naiveShares = (naiveRaw * multiplier) / WAD;

  const now = Math.floor(Date.now() / 1000);
  // Match ShareExactGuard._corpActionImminent: an unreadable pending value with
  // a future effectiveAt is a block, even outside the warning window. The
  // window only applies once the two multipliers can be compared.
  const corpActionImminent =
    effectiveAt != null &&
    effectiveAt > now &&
    (pendingMultiplier === null ||
      (pendingMultiplier !== multiplier && effectiveAt - now <= CORP_ACTION_WARNING_WINDOW));

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (raw === 0n) {
    blockers.push("Rounds down to zero raw units at this multiplier. Send a larger amount.");
  }
  if (raw > rawBalance) {
    blockers.push("Computed raw amount exceeds the wallet's raw balance. ShareExact never clamps.");
  }
  if (corpActionImminent) {
    blockers.push(
      "A new uiMultiplier activates shortly. Wait for it to land rather than settling across the change.",
    );
  }
  if (shortfall > 0n) {
    warnings.push(
      `Floor rounding loses ${shortfall} wei of a share. The send is blocked until this loss is accepted explicitly.`,
    );
  }
  if (oraclePaused) {
    warnings.push("The issuer has paused this token's oracle. Units are still exact; the price is not.");
  }
  if (multiplier !== WAD) {
    warnings.push(
      "This token's multiplier is not 1.0, so raw units and shares are not interchangeable here.",
    );
  }

  return {
    multiplier,
    pendingMultiplier,
    effectiveAt,
    oraclePaused,
    raw,
    delivered,
    shortfall,
    naiveRaw,
    naiveShares,
    rawBalance,
    fits: raw <= rawBalance && raw > 0n,
    corpActionImminent,
    route: EXACT_TRANSFER_ADDRESS ? "guarded" : "preflight",
    blockers,
    warnings,
  };
}

export interface SendResult {
  hash: string;
  route: TransferRoute;
  raw: bigint;
  /** Shares actually represented by `raw` after floor rounding. */
  delivered: bigint;
  shortfall: bigint;
  approvalHash?: string;
}

/** Token decimals. Robinhood Stock Tokens are 18; kept in one place so the
 *  preflight and the signed calldata can never disagree about the scale. */
export const TOKEN_DECIMALS = 18;

/**
 * Sends the transfer. Re-runs preflight immediately before signing so the
 * amount in the wallet popup is derived from state read seconds ago, not from
 * whatever the screen was showing.
 */
export async function sendExactTransfer(
  provider: EthereumProvider,
  params: { token: string; from: string; to: string; amount: string; maxShortfall?: bigint },
): Promise<SendResult> {
  const pre = await preflightTransfer(provider, {
    token: params.token,
    holder: params.from,
    amount: params.amount,
    decimals: TOKEN_DECIMALS,
  });
  if (pre.blockers.length > 0) throw new PreflightError(pre.blockers[0]);

  // Both routes enforce the same shortfall contract.
  //
  // Previously only the contract route did: the direct route took a
  // `maxShortfall` argument and ignored it, so a product called "send exact
  // shares" would happily send fewer than asked and merely print a warning next
  // to the button. A warning is not consent. Default is zero tolerance — the
  // caller has to say out loud how much rounding loss it accepts.
  const acceptedShortfall = params.maxShortfall ?? 0n;
  if (pre.shortfall > acceptedShortfall) {
    throw new ShortfallError(
      `This amount cannot be represented exactly: ${pre.shortfall} wei of a share would be lost. Accept the loss explicitly or adjust the amount.`,
      pre.shortfall,
      acceptedShortfall,
    );
  }
  if (!pre.fits) throw new PreflightError("Transfer does not fit the wallet's raw balance.");

  if (pre.route === "guarded") {
    const allowanceHex = await ethCall(
      provider,
      params.token,
      encodeAllowance(params.from, EXACT_TRANSFER_ADDRESS),
    );
    const allowance = decodeUint(allowanceHex) ?? 0n;
    let approvalHash: string | undefined;
    if (allowance < pre.raw) {
      approvalHash = (await provider.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: params.from,
            to: params.token,
            data: encodeApprove(EXACT_TRANSFER_ADDRESS, pre.raw),
          },
        ],
      })) as string;
    }

    const uiShares = parseDecimalToBigInt(params.amount, TOKEN_DECIMALS);
    const hash = (await provider.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: params.from,
          to: EXACT_TRANSFER_ADDRESS,
          data: encodeTransferShares(
            params.token,
            params.to,
            uiShares,
            acceptedShortfall,
          ),
        },
      ],
    })) as string;

    return {
      hash,
      route: "guarded",
      raw: pre.raw,
      delivered: pre.delivered,
      shortfall: pre.shortfall,
      approvalHash,
    };
  }

  const hash = (await provider.request({
    method: "eth_sendTransaction",
    params: [
      {
        from: params.from,
        to: params.token,
        data: encodeTransfer(params.to, pre.raw),
      },
    ],
  })) as string;

  return {
    hash,
    route: "preflight",
    raw: pre.raw,
    delivered: pre.delivered,
    shortfall: pre.shortfall,
  };
}

export function explorerTxUrl(hash: string): string {
  return `https://robinhoodchain.blockscout.com/tx/${hash}`;
}
