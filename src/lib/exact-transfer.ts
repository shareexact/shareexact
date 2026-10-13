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
  decodeErc20Transfer,
  decodeExactShareTransfer,
  decodeUint,
  encodeAllowance,
  encodeApprove,
  encodeBalanceOf,
  encodeTransfer,
  encodeTransferShares,
  SELECTORS,
  type EventLog,
  type ExactShareTransferEvent,
} from "./abi.ts";
import { parseDecimalToBigInt } from "./conversion.ts";
import { RH_CHAIN_ID, readChainId, type EthereumProvider } from "./wallet.ts";

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
  params: {
    token: string;
    holder: string;
    amount: string;
    decimals?: number;
    /** The deployed `ExactTransfer`. Defaults to the build's `VITE_EXACT_TRANSFER`;
     *  passed explicitly only by tests, which have no Vite environment and would
     *  otherwise be unable to exercise the route that matters most. */
    exactTransfer?: string;
  },
): Promise<Preflight> {
  const { token, holder } = params;
  const decimals = params.decimals ?? 18;
  const helper = params.exactTransfer ?? EXACT_TRANSFER_ADDRESS;

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
    route: helper ? "guarded" : "preflight",
    blockers,
    warnings,
  };
}

/*//////////////////////////////////////////////////////////////
                             RECEIPTS
//////////////////////////////////////////////////////////////*/

/**
 * Why the send path waits.
 *
 * Until now it did neither of the two things a receipt is for. The approval was
 * fired and the `transferShares` calldata was built in the next statement, so
 * the transfer could be signed — and submitted — before the allowance existed;
 * the wallet would then show a revert the user had no way to explain. And the
 * result returned the *preflight's* numbers, so the desk printed a prediction
 * underneath the words "shares that leave".
 *
 * Both were ordinary mistakes, and both are the one mistake this product exists
 * to argue against: reporting a number you computed as a number that happened.
 *
 * So the approval is confirmed before the transfer is built, the transfer is
 * confirmed before anything is reported, and the numbers that come back are
 * decoded from `ExactShareTransfer` — written by the contract after it re-read
 * the multiplier inside the transaction. The preflight survives alongside them,
 * labelled as the estimate it always was.
 */

/** A receipt, reduced to the fields this app reasons about. */
export interface TxReceipt {
  /** 1 success, 0 reverted, null when the node omitted the field. */
  status: number | null;
  blockNumber: number | null;
  gasUsed: bigint | null;
  logs: EventLog[];
}

export const RECEIPT_POLL_MS = 1_500;
export const RECEIPT_TIMEOUT_MS = 120_000;

export interface WaitOptions {
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Raised when the wallet is not on the chain these numbers were read from.
 *
 * The chain was read once, when the wallet connected, and never again. A user
 * who switches network in the wallet — or whose wallet switches itself, which
 * several do when another tab asks — would then sign calldata built from one
 * chain's multiplier and balance against a different chain's state. The token
 * address usually holds nothing there, so the likely outcome is a confusing
 * revert; the unlikely one is an address that holds something else entirely.
 */
export class WrongChainError extends PreflightError {
  readonly expected: number;
  readonly actual: number;

  constructor(message: string, expected: number, actual: number) {
    super(message);
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Re-read the chain and refuse if it moved.
 *
 * Called immediately before each signature rather than once per send, because
 * the gap that matters is the one between the user seeing a number and
 * approving it — and on the guarded route that gap now includes waiting for an
 * approval receipt, which is the longest this product has ever paused with a
 * wallet open.
 */
async function requireChain(provider: EthereumProvider, expected: number): Promise<void> {
  let actual: number;
  try {
    actual = await readChainId(provider);
  } catch {
    throw new WrongChainError(
      "Could not read which chain the wallet is on. Nothing was sent.",
      expected,
      Number.NaN,
    );
  }
  // NaN fails this comparison, which is the direction to fail in: a chain id we
  // could not parse is not evidence of the right chain.
  if (actual !== expected) {
    throw new WrongChainError(
      `The wallet is on chain ${Number.isFinite(actual) ? actual : "unknown"}, but these numbers were read from chain ${expected}. Switch the wallet back and try again. Nothing was sent.`,
      expected,
      actual,
    );
  }
}

/**
 * Raised when the approval was signed and submitted but has not landed, so the
 * transfer cannot be built yet. Carries the hash: the user signed something, and
 * an error message that hides it leaves them unable to look it up.
 */
export class ApprovalPendingError extends PreflightError {
  readonly hash: string;

  constructor(message: string, hash: string) {
    super(message);
    this.hash = hash;
  }
}

/** Raised when the chain executed the transaction and it failed. */
export class TransactionRevertedError extends Error {
  readonly hash: string;
  readonly phase: "approval" | "transfer";

  constructor(message: string, hash: string, phase: "approval" | "transfer") {
    super(message);
    this.hash = hash;
    this.phase = phase;
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    try {
      return Number(BigInt(value));
    } catch {
      return null;
    }
  }
  return null;
}

function toBigint(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && value.length > 0) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  return null;
}

function normaliseReceipt(raw: unknown): TxReceipt | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  // A receipt without a block number is not a receipt yet. Some nodes answer a
  // pending transaction with an object rather than with null.
  const blockNumber = toNumber(r.blockNumber);
  if (blockNumber === null) return null;
  return {
    status: toNumber(r.status),
    blockNumber,
    gasUsed: toBigint(r.gasUsed),
    logs: Array.isArray(r.logs) ? (r.logs as EventLog[]) : [],
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until the transaction has a receipt. Returns null if it has not landed
 * within the timeout.
 *
 * Null means "not yet", never "it failed". A transport error on one poll is also
 * not a verdict — the node may simply have dropped a request — so the loop keeps
 * asking until the clock runs out rather than reporting a failure it cannot see.
 */
export async function waitForReceipt(
  provider: EthereumProvider,
  hash: string,
  options: WaitOptions = {},
): Promise<TxReceipt | null> {
  const timeoutMs = options.timeoutMs ?? RECEIPT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? RECEIPT_POLL_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let raw: unknown = null;
    try {
      raw = await provider.request({ method: "eth_getTransactionReceipt", params: [hash] });
    } catch {
      raw = null;
    }
    const receipt = normaliseReceipt(raw);
    if (receipt) return receipt;
    if (Date.now() >= deadline) return null;
    await sleep(pollMs);
  }
}

/*//////////////////////////////////////////////////////////////
                              RESULT
//////////////////////////////////////////////////////////////*/

/** What the chain says happened, as opposed to what we predicted it would. */
export interface Settled {
  /**
   * `event` — decoded from `ExactShareTransfer`, so the share count is proven.
   * `erc20` — decoded from the token's own `Transfer`, which proves the raw
   *   units and cannot prove a share count, because none was ever named in the
   *   transaction. Only the guarded route produces the first kind.
   */
  source: "event" | "erc20";
  raw: bigint;
  uiShares: bigint | null;
  delivered: bigint | null;
  shortfall: bigint | null;
  multiplier: bigint | null;
  maxShortfall: bigint | null;
  blockNumber: number | null;
  gasUsed: bigint | null;
}

export interface SendResult {
  hash: string;
  route: TransferRoute;
  /**
   * `confirmed` — a receipt is in hand and `settled` carries the chain's numbers.
   * `pending`   — submitted, no receipt yet. Nothing has been proven either way,
   *               and the UI must not read this as success or as failure.
   */
  status: "confirmed" | "pending";
  /** The preflight's prediction, kept so it can be compared, never reported as
   *  the outcome. */
  estimate: { multiplier: bigint; raw: bigint; delivered: bigint; shortfall: bigint };
  settled: Settled | null;
  /**
   * Why nothing was proven, when `status` is `pending`.
   *
   * `no-receipt` — it has not landed yet, which is ordinary and usually resolves
   *   within a block or two.
   * `no-event` — a successful receipt came back carrying no `ExactShareTransfer`
   *   from this helper, so no amount can be read out of it. Rare and strange, and
   *   it deserves its own sentence on screen: one of these means "wait", the
   *   other means "go and look".
   */
  pendingReason?: "no-receipt" | "no-event";
  /** Populated when the chain and the preview disagree. Normally empty; when it
   *  is not, this is the race condition the whole project is about, caught. */
  mismatch: string[];
  approvalHash?: string;
}

/** Progress, so a UI can show a hash and a waiting state instead of freezing
 *  for however long two blocks take. */
export type SendPhase =
  | { kind: "approving" }
  | { kind: "approval-submitted"; hash: string }
  | { kind: "approval-confirmed"; hash: string }
  | { kind: "signing" }
  | { kind: "submitted"; hash: string }
  | { kind: "confirmed"; hash: string }
  | { kind: "timed-out"; hash: string };

/** Token decimals. Robinhood Stock Tokens are 18; kept in one place so the
 *  preflight and the signed calldata can never disagree about the scale. */
export const TOKEN_DECIMALS = 18;

/** Find this transfer's own `ExactShareTransfer`, ignoring any other log in the
 *  same transaction. */
function findExactShareTransfer(
  receipt: TxReceipt,
  params: { helper: string; token: string; from: string; to: string },
): ExactShareTransferEvent | null {
  const helper = params.helper.toLowerCase();
  const token = params.token.toLowerCase();
  const from = params.from.toLowerCase();
  const to = params.to.toLowerCase();

  for (const log of receipt.logs) {
    if (typeof log.address === "string" && log.address.toLowerCase() !== helper) continue;
    const event = decodeExactShareTransfer(log);
    if (!event) continue;
    if (event.token !== token || event.from !== from || event.to !== to) continue;
    return event;
  }
  return null;
}

/** Find the token's own `Transfer` for this movement. */
function findErc20Transfer(
  receipt: TxReceipt,
  params: { token: string; from: string; to: string },
): bigint | null {
  const token = params.token.toLowerCase();
  const from = params.from.toLowerCase();
  const to = params.to.toLowerCase();

  for (const log of receipt.logs) {
    if (typeof log.address === "string" && log.address.toLowerCase() !== token) continue;
    const event = decodeErc20Transfer(log);
    if (!event) continue;
    if (event.from !== from || event.to !== to) continue;
    return event.value;
  }
  return null;
}

/** Everywhere the chain contradicted the preview, in words a user can act on. */
function compare(estimate: SendResult["estimate"], settled: Settled): string[] {
  const notes: string[] = [];
  if (settled.raw !== estimate.raw) {
    notes.push(
      `The chain moved ${settled.raw} raw units; the preview computed ${estimate.raw}.`,
    );
  }
  if (settled.multiplier !== null && settled.multiplier !== estimate.multiplier) {
    notes.push(
      `The multiplier changed between the preview and the block: ${estimate.multiplier} became ${settled.multiplier}.`,
    );
  }
  if (settled.delivered !== null && settled.delivered !== estimate.delivered) {
    notes.push(
      `Shares delivered: ${settled.delivered} against a predicted ${estimate.delivered}.`,
    );
  }
  return notes;
}

/**
 * Sends the transfer and reports what the chain did with it.
 *
 * Re-runs preflight immediately before signing so the amount in the wallet popup
 * is derived from state read seconds ago rather than from whatever the screen
 * was showing, then waits for each receipt in turn.
 */
export async function sendExactTransfer(
  provider: EthereumProvider,
  params: {
    token: string;
    from: string;
    to: string;
    amount: string;
    maxShortfall?: bigint;
    onPhase?: (phase: SendPhase) => void;
    wait?: WaitOptions;
    /** See `preflightTransfer`. */
    exactTransfer?: string;
    /** Chain these numbers belong to. Defaults to Robinhood Chain. */
    expectedChainId?: number;
  },
): Promise<SendResult> {
  const helper = params.exactTransfer ?? EXACT_TRANSFER_ADDRESS;
  const expectedChainId = params.expectedChainId ?? RH_CHAIN_ID;
  const notify = (phase: SendPhase) => {
    try {
      params.onPhase?.(phase);
    } catch {
      // A listener that throws is the caller's problem, not a reason to abandon
      // a transaction that may already be in flight.
    }
  };

  // Before the reads, so the multiplier and the balance behind the quote come
  // from the chain the transaction will execute on.
  await requireChain(provider, expectedChainId);

  const pre = await preflightTransfer(provider, {
    token: params.token,
    holder: params.from,
    amount: params.amount,
    decimals: TOKEN_DECIMALS,
    exactTransfer: helper,
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

  const estimate = {
    multiplier: pre.multiplier,
    raw: pre.raw,
    delivered: pre.delivered,
    shortfall: pre.shortfall,
  };
  const movement = { token: params.token, from: params.from, to: params.to };

  /** Submitted, nothing proven. Deliberately carries no numbers from `settled`,
   *  so a caller cannot mistake the estimate for an outcome. */
  const pending = (
    hash: string,
    pendingReason: "no-receipt" | "no-event",
    approvalHash?: string,
  ): SendResult => ({
    hash,
    route: pre.route,
    status: "pending",
    estimate,
    settled: null,
    pendingReason,
    mismatch: [],
    approvalHash,
  });

  if (pre.route === "guarded") {
    const allowanceHex = await ethCall(
      provider,
      params.token,
      encodeAllowance(params.from, helper),
    );
    const allowance = decodeUint(allowanceHex) ?? 0n;
    let approvalHash: string | undefined;

    if (allowance < pre.raw) {
      await requireChain(provider, expectedChainId);
      notify({ kind: "approving" });
      approvalHash = (await provider.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: params.from,
            to: params.token,
            data: encodeApprove(helper, pre.raw),
          },
        ],
      })) as string;
      notify({ kind: "approval-submitted", hash: approvalHash });

      // Wait for it. `transferShares` pulls the tokens with `transferFrom`, so a
      // transfer signed before the approval lands reverts — and the user sees a
      // failure with no explanation attached to it.
      const approvalReceipt = await waitForReceipt(provider, approvalHash, params.wait);
      if (!approvalReceipt) {
        throw new ApprovalPendingError(
          "The approval was submitted but has not landed yet. Nothing has been sent. Wait for it to confirm, then send again.",
          approvalHash,
        );
      }
      if (approvalReceipt.status === 0) {
        throw new TransactionRevertedError(
          "The approval transaction reverted, so no allowance exists and nothing was sent.",
          approvalHash,
          "approval",
        );
      }
      notify({ kind: "approval-confirmed", hash: approvalHash });

      // Confirmed is not the same as sufficient. Several wallets let the user
      // edit the amount in the approval popup, and a confirmed approval for less
      // than the transfer needs would revert inside `transferFrom`. Read the
      // allowance the chain actually holds rather than the one we asked for.
      const confirmedHex = await ethCall(
        provider,
        params.token,
        encodeAllowance(params.from, helper),
      );
      const confirmedAllowance = decodeUint(confirmedHex) ?? 0n;
      if (confirmedAllowance < pre.raw) {
        throw new PreflightError(
          `The approval confirmed for ${confirmedAllowance} raw units, but this transfer needs ${pre.raw}. Nothing was sent. Approve the full amount and try again.`,
        );
      }
    }

    const uiShares = parseDecimalToBigInt(params.amount, TOKEN_DECIMALS);
    // The approval wait is the longest pause in this flow, so this is the check
    // that earns its keep.
    await requireChain(provider, expectedChainId);
    notify({ kind: "signing" });
    const hash = (await provider.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: params.from,
          to: helper,
          data: encodeTransferShares(
            params.token,
            params.to,
            uiShares,
            acceptedShortfall,
          ),
        },
      ],
    })) as string;
    notify({ kind: "submitted", hash });

    const receipt = await waitForReceipt(provider, hash, params.wait);
    if (!receipt) {
      notify({ kind: "timed-out", hash });
      return pending(hash, "no-receipt", approvalHash);
    }
    if (receipt.status === 0) {
      throw new TransactionRevertedError(
        "The transfer reverted on chain. No shares moved. ExactTransfer reverts rather than settling an inexact amount, so check the multiplier and the rounding allowance.",
        hash,
        "transfer",
      );
    }

    const event = findExactShareTransfer(receipt, { helper, ...movement });
    // A successful `transferShares` always emits. No event means the receipt
    // belongs to something else, and saying "settled" over it would be the same
    // kind of guess this whole change removes.
    if (!event) {
      notify({ kind: "timed-out", hash });
      return pending(hash, "no-event", approvalHash);
    }

    const settled: Settled = {
      source: "event",
      raw: event.raw,
      uiShares: event.uiShares,
      delivered: event.deliveredShares,
      shortfall:
        event.uiShares > event.deliveredShares ? event.uiShares - event.deliveredShares : 0n,
      multiplier: event.multiplier,
      maxShortfall: event.maxShortfall,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
    };
    notify({ kind: "confirmed", hash });

    return {
      hash,
      route: "guarded",
      status: "confirmed",
      estimate,
      settled,
      mismatch: compare(estimate, settled),
      approvalHash,
    };
  }

  await requireChain(provider, expectedChainId);
  notify({ kind: "signing" });
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
  notify({ kind: "submitted", hash });

  const receipt = await waitForReceipt(provider, hash, params.wait);
  if (!receipt) {
    notify({ kind: "timed-out", hash });
    return pending(hash, "no-receipt");
  }
  if (receipt.status === 0) {
    throw new TransactionRevertedError(
      "The transfer reverted on chain. No tokens moved.",
      hash,
      "transfer",
    );
  }

  const moved = findErc20Transfer(receipt, movement);
  if (moved === null) {
    notify({ kind: "timed-out", hash });
    return pending(hash, "no-event");
  }

  // The receipt proves the raw units and stops there. Nothing in this
  // transaction named a share count, so there is no on-chain share count to
  // report — which is the honest difference between the two routes, and the
  // reason the guarded one exists.
  const settled: Settled = {
    source: "erc20",
    raw: moved,
    uiShares: null,
    delivered: null,
    shortfall: null,
    multiplier: null,
    maxShortfall: null,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
  };
  notify({ kind: "confirmed", hash });

  return {
    hash,
    route: "preflight",
    status: "confirmed",
    estimate,
    settled,
    mismatch: compare(estimate, settled),
  };
}

export function explorerTxUrl(hash: string): string {
  return `https://robinhoodchain.blockscout.com/tx/${hash}`;
}
