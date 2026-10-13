import assert from "node:assert/strict";
import test from "node:test";
import { SELECTORS, TOPICS } from "./abi.ts";
import {
  ApprovalPendingError,
  PreflightError,
  ShortfallError,
  TransactionRevertedError,
  WrongChainError,
  preflightTransfer,
  sendExactTransfer,
  waitForReceipt,
} from "./exact-transfer.ts";

/**
 * Two things are pinned here.
 *
 * The older half: the preflight route used to accept a `maxShortfall` argument
 * and ignore it, so a product called "send exact shares" would silently send
 * fewer than asked and print a warning next to the button. Both routes now
 * refuse to sign a transaction that loses more shares than the caller named.
 *
 * The newer half: the send path used to return the *preflight's* numbers as the
 * result, and it built the transfer in the statement after firing the approval.
 * So it reported a prediction as an outcome, and it could submit a transfer that
 * reverted because the allowance had not landed. These tests pin the order of
 * operations and the provenance of every number that comes back.
 *
 * The provider is a stub rather than a real wallet. That is the point — the
 * assertions are about what calldata is produced, what is waited for, and which
 * numbers are reported, which is exactly the part a wallet cannot tell you.
 */

const WAD = 10n ** 18n;
const TOKEN = "0x1111111111111111111111111111111111111111";
const HOLDER = "0x2222222222222222222222222222222222222222";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const HELPER = "0x4444444444444444444444444444444444444444";
const CHAIN = 4663;

const SELECTOR = {
  uiMultiplier: "0xa60bf13d",
  newUIMultiplier: "0xdc767007",
  effectiveAt: "0x97a4064f",
  oraclePaused: "0x7706ba52",
  balanceOf: "0x70a08231",
  allowance: "0xdd62ed3e",
} as const;

function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function topicAddress(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

/** Read argument `index` out of calldata, skipping the 4-byte selector. */
function argAt(data: string, index: number): bigint {
  const body = data.slice(10);
  return BigInt(`0x${body.slice(index * 64, index * 64 + 64)}`);
}

interface LogStub {
  address: string;
  topics: string[];
  data: string;
}

interface ReceiptStub {
  status?: bigint;
  logs?: LogStub[];
}

interface StubOptions {
  multiplier: bigint | null;
  /** Chain ids returned by successive `eth_chainId` calls. The last one repeats,
   *  so `[4663, 1]` models a wallet that switches network mid-flow. */
  chainIds?: number[];
  /** Make `eth_chainId` throw. */
  chainIdThrows?: boolean;
  balance?: bigint;
  pending?: bigint;
  effectiveAt?: bigint;
  paused?: boolean;
  throwOnCall?: boolean;
  /** Allowance before any approval is signed. */
  allowance?: bigint;
  /** What a confirmed approval actually grants. Defaults to the amount asked
   *  for; set it lower to model a wallet where the user edited the number. */
  approvalGrants?: bigint;
  /** Per transaction, in the order they were sent. `"never"` models one that is
   *  still pending when the clock runs out. */
  receipts?: (ReceiptStub | "never")[];
  /** Raw units the log reports, when the chain is to disagree with the preview. */
  settledRaw?: bigint;
  /** Fail this many receipt polls with a transport error before answering. */
  flakyPolls?: number;
}

function stubProvider(options: StubOptions) {
  const sent: { method: string; params: unknown }[] = [];
  const txs: { to: string; data: string }[] = [];
  const multiplier = options.multiplier ?? WAD;
  let allowance = options.allowance ?? 0n;
  let flaky = options.flakyPolls ?? 0;
  const chainIds = options.chainIds ?? [CHAIN];
  let chainReads = 0;

  const hashFor = (index: number) => `0x${(index + 1).toString(16).padStart(64, "0")}`;

  /** What the chain would have logged for this transaction. */
  function logsFor(tx: { to: string; data: string }): LogStub[] {
    if (tx.data.startsWith(SELECTORS.transferShares)) {
      const uiShares = argAt(tx.data, 2);
      const maxShortfall = argAt(tx.data, 3);
      const raw = options.settledRaw ?? (uiShares * WAD) / multiplier;
      const delivered = (raw * multiplier) / WAD;
      return [
        {
          address: HELPER,
          topics: [
            TOPICS.exactShareTransfer,
            topicAddress(TOKEN),
            topicAddress(HOLDER),
            topicAddress(RECIPIENT),
          ],
          data: `0x${[uiShares, delivered, raw, multiplier, maxShortfall]
            .map((v) => v.toString(16).padStart(64, "0"))
            .join("")}`,
        },
      ];
    }
    if (tx.data.startsWith(SELECTORS.transfer)) {
      const value = options.settledRaw ?? argAt(tx.data, 1);
      return [
        {
          address: TOKEN,
          topics: [TOPICS.transfer, topicAddress(HOLDER), topicAddress(RECIPIENT)],
          data: word(value),
        },
      ];
    }
    return [];
  }

  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      if (method === "eth_chainId") {
        if (options.chainIdThrows) throw new Error("wallet refused eth_chainId");
        const id = chainIds[Math.min(chainReads, chainIds.length - 1)];
        chainReads += 1;
        return `0x${id.toString(16)}`;
      }
      if (method === "eth_call") {
        if (options.throwOnCall) throw new Error("rpc exploded");
        const call = (params?.[0] ?? {}) as { data?: string };
        const data = call.data ?? "";
        if (data.startsWith(SELECTOR.uiMultiplier)) {
          return options.multiplier === null ? "0x" : word(options.multiplier);
        }
        if (data.startsWith(SELECTOR.newUIMultiplier)) {
          return word(options.pending ?? options.multiplier ?? 0n);
        }
        if (data.startsWith(SELECTOR.effectiveAt)) return word(options.effectiveAt ?? 0n);
        if (data.startsWith(SELECTOR.oraclePaused)) return word(options.paused ? 1n : 0n);
        if (data.startsWith(SELECTOR.balanceOf)) return word(options.balance ?? 1000n * WAD);
        if (data.startsWith(SELECTOR.allowance)) return word(allowance);
        return "0x";
      }
      if (method === "eth_sendTransaction") {
        const call = (params?.[0] ?? {}) as { to?: string; data?: string };
        sent.push({ method, params });
        txs.push({ to: call.to ?? "", data: call.data ?? "" });
        return hashFor(txs.length - 1);
      }
      if (method === "eth_getTransactionReceipt") {
        if (flaky > 0) {
          flaky -= 1;
          throw new Error("receipt request dropped");
        }
        const hash = (params?.[0] as string) ?? "";
        const index = txs.findIndex((_, i) => hashFor(i) === hash);
        if (index < 0) return null;
        const stub = options.receipts?.[index];
        if (stub === "never") return null;
        const tx = txs[index];
        const status = stub?.status ?? 1n;
        // An approval only grants once it has confirmed, which is the whole
        // reason the send path waits for this receipt.
        if (status === 1n && tx.data.startsWith(SELECTORS.approve)) {
          allowance = options.approvalGrants ?? argAt(tx.data, 1);
        }
        return {
          status: word(status),
          blockNumber: word(BigInt(1000 + index)),
          gasUsed: word(45255n),
          logs: status === 1n ? (stub?.logs ?? logsFor(tx)) : [],
        };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  return { provider, sent, txs, hashFor, chainReadCount: () => chainReads };
}

/** Receipts are served immediately in these tests; the clock is only here so a
 *  "never" receipt fails fast instead of holding the suite for two minutes. */
const FAST = { pollMs: 0, timeoutMs: 50 };

test("the preflight route is never labelled exact", async () => {
  // The route name is part of the product's honesty: only the guarded route
  // reads the multiplier inside the transaction, so only it can promise an
  // exact share count. Without VITE_EXACT_TRANSFER the route must report
  // itself as preflight.
  const { provider } = stubProvider({ multiplier: 4n * WAD });
  const pre = await preflightTransfer(provider, { token: TOKEN, holder: HOLDER, amount: "1" });
  assert.equal(pre.route, "preflight");
});

test("an exactly representable amount signs and moves the right raw units", async () => {
  // 4x multiplier: one share is a quarter of a raw token.
  const { provider, sent } = stubProvider({ multiplier: 4n * WAD });
  const result = await sendExactTransfer(provider, {
    token: TOKEN,
    from: HOLDER,
    to: RECIPIENT,
    amount: "1",
    wait: FAST,
  });
  assert.equal(result.route, "preflight");
  assert.equal(result.estimate.raw, WAD / 4n);
  assert.equal(result.estimate.shortfall, 0n);
  assert.equal(result.status, "confirmed");
  assert.equal(result.settled?.raw, WAD / 4n);
  assert.equal(sent.length, 1);
});

test("preflight route refuses a shortfall the caller did not accept", async () => {
  // At 3x, 1.000000000000000001 shares is not exactly representable.
  const { provider, sent } = stubProvider({ multiplier: 3n * WAD });
  await assert.rejects(
    () =>
      sendExactTransfer(provider, {
        token: TOKEN,
        from: HOLDER,
        to: RECIPIENT,
        amount: "1.000000000000000001",
        wait: FAST,
      }),
    ShortfallError,
  );
  assert.equal(sent.length, 0, "nothing may be signed when the shortfall is unaccepted");
});

test("preflight route signs once the shortfall is accepted explicitly", async () => {
  const { provider, sent } = stubProvider({ multiplier: 3n * WAD });
  const pre = await preflightTransfer(provider, {
    token: TOKEN,
    holder: HOLDER,
    amount: "1.000000000000000001",
  });
  assert.ok(pre.shortfall > 0n);
  const result = await sendExactTransfer(provider, {
    token: TOKEN,
    from: HOLDER,
    to: RECIPIENT,
    amount: "1.000000000000000001",
    maxShortfall: pre.shortfall,
    wait: FAST,
  });
  assert.equal(sent.length, 1);
  assert.equal(result.estimate.shortfall, pre.shortfall);
});

test("an unreadable multiplier fails closed instead of assuming 1:1", async () => {
  const { provider, sent } = stubProvider({ multiplier: null });
  await assert.rejects(
    () =>
      sendExactTransfer(provider, { token: TOKEN, from: HOLDER, to: RECIPIENT, amount: "1" }),
    PreflightError,
  );
  assert.equal(sent.length, 0);
});

test("a provider that throws surfaces as a preflight error, not a silent 1:1", async () => {
  const { provider, sent } = stubProvider({ multiplier: 4n * WAD, throwOnCall: true });
  await assert.rejects(
    () =>
      sendExactTransfer(provider, { token: TOKEN, from: HOLDER, to: RECIPIENT, amount: "1" }),
    PreflightError,
  );
  assert.equal(sent.length, 0);
});

test("a request larger than the balance is refused before signing", async () => {
  const { provider, sent } = stubProvider({ multiplier: WAD, balance: WAD });
  await assert.rejects(
    () => sendExactTransfer(provider, { token: TOKEN, from: HOLDER, to: RECIPIENT, amount: "5" }),
    PreflightError,
  );
  assert.equal(sent.length, 0);
});

test("an imminent corporate action blocks signing", async () => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const { provider, sent } = stubProvider({
    multiplier: 4n * WAD,
    pending: 8n * WAD,
    effectiveAt: now + 600n,
  });
  await assert.rejects(
    () => sendExactTransfer(provider, { token: TOKEN, from: HOLDER, to: RECIPIENT, amount: "1" }),
    PreflightError,
  );
  assert.equal(sent.length, 0);
});

test("preflight exposes what a naive integration would have sent", async () => {
  const { provider } = stubProvider({ multiplier: 4n * WAD });
  const pre = await preflightTransfer(provider, { token: TOKEN, holder: HOLDER, amount: "1" });
  assert.equal(pre.raw, WAD / 4n);
  assert.equal(pre.naiveRaw, WAD);
  assert.equal(pre.naiveShares, 4n * WAD);
});

/*//////////////////////////////////////////////////////////////
                   RECEIPTS: ORDER AND PROVENANCE
//////////////////////////////////////////////////////////////*/

test("the guarded route waits for the approval before signing the transfer", async () => {
  // The bug this pins: the approval and the transfer were sent back to back, so
  // `transferFrom` could run before any allowance existed. The transfer must be
  // the second transaction, and the allowance must already be on chain when it
  // is built — which this stub only grants once the approval's receipt is served.
  const { provider, sent, txs } = stubProvider({ multiplier: 4n * WAD });
  const result = await sendExactTransfer(provider, {
    token: TOKEN,
    from: HOLDER,
    to: RECIPIENT,
    amount: "1",
    exactTransfer: HELPER,
    wait: FAST,
  });
  assert.equal(sent.length, 2);
  assert.ok(txs[0].data.startsWith(SELECTORS.approve), "first transaction is the approval");
  assert.ok(txs[1].data.startsWith(SELECTORS.transferShares), "second is the transfer");
  assert.equal(result.route, "guarded");
  assert.equal(result.status, "confirmed");
  assert.ok(result.approvalHash);
});

test("an approval that never lands stops the send instead of racing it", async () => {
  const { provider, sent } = stubProvider({ multiplier: 4n * WAD, receipts: ["never"] });
  await assert.rejects(
    () =>
      sendExactTransfer(provider, {
        token: TOKEN,
        from: HOLDER,
        to: RECIPIENT,
        amount: "1",
        exactTransfer: HELPER,
        wait: FAST,
      }),
    ApprovalPendingError,
  );
  assert.equal(sent.length, 1, "the transfer must not be signed on an unconfirmed allowance");
});

test("a reverted approval is reported as a revert, and nothing is sent", async () => {
  const { provider, sent } = stubProvider({
    multiplier: 4n * WAD,
    receipts: [{ status: 0n }],
  });
  await assert.rejects(
    () =>
      sendExactTransfer(provider, {
        token: TOKEN,
        from: HOLDER,
        to: RECIPIENT,
        amount: "1",
        exactTransfer: HELPER,
        wait: FAST,
      }),
    TransactionRevertedError,
  );
  assert.equal(sent.length, 1);
});

test("an approval edited down in the wallet is caught before the transfer", async () => {
  // Several wallets let the user change the amount in the approval popup. A
  // confirmed approval is not necessarily a sufficient one, so the allowance is
  // read back off the chain instead of assumed from what we asked for.
  const { provider, sent } = stubProvider({ multiplier: 4n * WAD, approvalGrants: 1n });
  await assert.rejects(
    () =>
      sendExactTransfer(provider, {
        token: TOKEN,
        from: HOLDER,
        to: RECIPIENT,
        amount: "1",
        exactTransfer: HELPER,
        wait: FAST,
      }),
    PreflightError,
  );
  assert.equal(sent.length, 1);
});

test("the reported numbers come from the event, not from the preflight", async () => {
  // The chain is told to log a raw amount the preview did not compute. A result
  // that still reports the preview's number would be the old bug intact.
  const chainRaw = WAD / 4n - 7n;
  const { provider } = stubProvider({ multiplier: 4n * WAD, settledRaw: chainRaw });
  const result = await sendExactTransfer(provider, {
    token: TOKEN,
    from: HOLDER,
    to: RECIPIENT,
    amount: "1",
    exactTransfer: HELPER,
    wait: FAST,
  });
  assert.equal(result.settled?.source, "event");
  assert.equal(result.settled?.raw, chainRaw);
  assert.equal(result.estimate.raw, WAD / 4n);
  assert.equal(result.settled?.multiplier, 4n * WAD);
  assert.ok(result.mismatch.length > 0, "a disagreement with the preview must be said out loud");
  assert.equal(result.settled?.blockNumber, 1001);
});

test("the preflight route can prove raw units and nothing more", async () => {
  // A plain ERC-20 transfer never named a share count, so no share count can be
  // read back out of its receipt. That gap is the argument for the guarded route.
  const { provider } = stubProvider({ multiplier: 4n * WAD });
  const result = await sendExactTransfer(provider, {
    token: TOKEN,
    from: HOLDER,
    to: RECIPIENT,
    amount: "1",
    wait: FAST,
  });
  assert.equal(result.settled?.source, "erc20");
  assert.equal(result.settled?.raw, WAD / 4n);
  assert.equal(result.settled?.delivered, null);
  assert.equal(result.settled?.multiplier, null);
});

test("a reverted transfer throws rather than being reported as settled", async () => {
  const { provider } = stubProvider({ multiplier: 4n * WAD, receipts: [{ status: 0n }] });
  await assert.rejects(
    () =>
      sendExactTransfer(provider, {
        token: TOKEN,
        from: HOLDER,
        to: RECIPIENT,
        amount: "1",
        wait: FAST,
      }),
    TransactionRevertedError,
  );
});

test("a transfer with no receipt yet is pending, not successful", async () => {
  const { provider } = stubProvider({ multiplier: 4n * WAD, receipts: ["never"] });
  const result = await sendExactTransfer(provider, {
    token: TOKEN,
    from: HOLDER,
    to: RECIPIENT,
    amount: "1",
    wait: FAST,
  });
  assert.equal(result.status, "pending");
  assert.equal(result.settled, null);
  assert.equal(result.pendingReason, "no-receipt");
  assert.ok(result.hash, "the hash is still returned: the user signed something");
});

test("a receipt with no log of ours is pending for a different reason", async () => {
  // "Not landed yet" and "landed but unreadable" need different sentences on
  // screen: the first resolves itself, the second is worth going to look at.
  const { provider } = stubProvider({ multiplier: 4n * WAD, receipts: [{ logs: [] }] });
  const result = await sendExactTransfer(provider, {
    token: TOKEN,
    from: HOLDER,
    to: RECIPIENT,
    amount: "1",
    wait: FAST,
  });
  assert.equal(result.status, "pending");
  assert.equal(result.pendingReason, "no-event");
});

test("progress is reported so a UI can show the hash while it waits", async () => {
  const phases: string[] = [];
  const { provider } = stubProvider({ multiplier: 4n * WAD });
  await sendExactTransfer(provider, {
    token: TOKEN,
    from: HOLDER,
    to: RECIPIENT,
    amount: "1",
    exactTransfer: HELPER,
    wait: FAST,
    onPhase: (phase) => phases.push(phase.kind),
  });
  assert.deepEqual(phases, [
    "approving",
    "approval-submitted",
    "approval-confirmed",
    "signing",
    "submitted",
    "confirmed",
  ]);
});

test("waitForReceipt treats a dropped request as 'not yet', not as a failure", async () => {
  // A transport error on one poll says nothing about the transaction. Returning
  // null there would turn a flaky node into a reported failure.
  const { provider } = stubProvider({ multiplier: WAD, flakyPolls: 3 });
  const hash = (await provider.request({
    method: "eth_sendTransaction",
    params: [{ to: TOKEN, data: `${SELECTORS.transfer}${"0".repeat(128)}` }],
  })) as string;
  const receipt = await waitForReceipt(provider, hash, { pollMs: 0, timeoutMs: 1000 });
  assert.ok(receipt, "the receipt arrives once the node answers");
  assert.equal(receipt.status, 1);
});

test("waitForReceipt returns null for a transaction that has not landed", async () => {
  const { provider } = stubProvider({ multiplier: WAD });
  const receipt = await waitForReceipt(provider, `0x${"ab".repeat(32)}`, FAST);
  assert.equal(receipt, null);
});

/*//////////////////////////////////////////////////////////////
                    THE CHAIN UNDER THE NUMBERS
//////////////////////////////////////////////////////////////*/

test("a wallet that switches chain mid-flow is caught before the signature", async () => {
  // First read is Robinhood Chain, so the quote is built. By the time the
  // transfer is about to be signed the wallet has moved, and the calldata would
  // be executed against a chain where that token address means something else,
  // or nothing. Chain id used to be read once, at connect, and never again.
  const { provider, sent } = stubProvider({ multiplier: 4n * WAD, chainIds: [CHAIN, 1] });
  await assert.rejects(
    () =>
      sendExactTransfer(provider, {
        token: TOKEN,
        from: HOLDER,
        to: RECIPIENT,
        amount: "1",
        wait: FAST,
      }),
    WrongChainError,
  );
  assert.equal(sent.length, 0, "nothing may be signed on the wrong chain");
});

test("the chain is re-read before every signature, not once per send", async () => {
  // Guarded route: once before the reads, once before the approval, once before
  // the transfer. The last is the one that matters, because the approval wait
  // sits between it and everything the user looked at.
  const { provider, chainReadCount } = stubProvider({ multiplier: 4n * WAD });
  await sendExactTransfer(provider, {
    token: TOKEN,
    from: HOLDER,
    to: RECIPIENT,
    amount: "1",
    exactTransfer: HELPER,
    wait: FAST,
  });
  assert.equal(chainReadCount(), 3);
});

test("the chain moving during the approval wait stops the transfer", async () => {
  const { provider, sent, txs } = stubProvider({
    multiplier: 4n * WAD,
    chainIds: [CHAIN, CHAIN, 1],
  });
  await assert.rejects(
    () =>
      sendExactTransfer(provider, {
        token: TOKEN,
        from: HOLDER,
        to: RECIPIENT,
        amount: "1",
        exactTransfer: HELPER,
        wait: FAST,
      }),
    WrongChainError,
  );
  assert.equal(sent.length, 1, "the approval was signed; the transfer must not be");
  assert.ok(txs[0].data.startsWith(SELECTORS.approve));
});

test("an unreadable chain id refuses rather than assumes", async () => {
  const { provider, sent } = stubProvider({ multiplier: 4n * WAD, chainIdThrows: true });
  await assert.rejects(
    () =>
      sendExactTransfer(provider, {
        token: TOKEN,
        from: HOLDER,
        to: RECIPIENT,
        amount: "1",
        wait: FAST,
      }),
    WrongChainError,
  );
  assert.equal(sent.length, 0);
});
