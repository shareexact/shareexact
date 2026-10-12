import assert from "node:assert/strict";
import test from "node:test";
import {
  PreflightError,
  ShortfallError,
  preflightTransfer,
  sendExactTransfer,
} from "./exact-transfer.ts";

/**
 * The preflight route used to accept a `maxShortfall` argument and ignore it, so a
 * product called "send exact shares" would silently send fewer than asked and
 * print a warning next to the button. These tests pin the fix: both routes now
 * refuse to sign a transaction that loses more shares than the caller named.
 *
 * The provider is a stub rather than a real wallet. That is the point — the
 * assertions are about what calldata is produced and when signing is refused,
 * which is exactly the part a wallet cannot tell you.
 */

const WAD = 10n ** 18n;
const TOKEN = "0x1111111111111111111111111111111111111111";
const HOLDER = "0x2222222222222222222222222222222222222222";
const RECIPIENT = "0x3333333333333333333333333333333333333333";

const SELECTOR = {
  uiMultiplier: "0xa60bf13d",
  newUIMultiplier: "0xdc767007",
  effectiveAt: "0x97a4064f",
  oraclePaused: "0x7706ba52",
  balanceOf: "0x70a08231",
} as const;

function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

interface StubOptions {
  multiplier: bigint | null;
  balance?: bigint;
  pending?: bigint;
  effectiveAt?: bigint;
  paused?: boolean;
  throwOnCall?: boolean;
}

function stubProvider(options: StubOptions) {
  const sent: { method: string; params: unknown }[] = [];
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
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
        return "0x";
      }
      if (method === "eth_sendTransaction") {
        sent.push({ method, params });
        return "0xabc123";
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  return { provider, sent };
}

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
  });
  assert.equal(result.route, "preflight");
  assert.equal(result.raw, WAD / 4n);
  assert.equal(result.shortfall, 0n);
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
  });
  assert.equal(sent.length, 1);
  assert.equal(result.shortfall, pre.shortfall);
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
