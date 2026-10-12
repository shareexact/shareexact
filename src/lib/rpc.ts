/**
 * Batched read-only JSON-RPC against Robinhood Chain.
 *
 * Called from server functions, but NOT server-only code. TanStack Start strips
 * the body of a server function while keeping its imports, so this module is
 * evaluated in the browser too. That is why every environment read goes through
 * `env.ts` instead of touching `process.env` directly: an unguarded read here
 * throws `process is not defined` during module initialisation, before React
 * mounts, and the app renders as a blank page with no component stack.
 *
 * The public endpoint is a demo fallback. Robinhood's docs tell integrators to
 * use a dedicated provider, so the URL is read from the environment first.
 */

import { readEnv } from "./env";

export const RH_CHAIN_ID = 4663;
export const RH_TESTNET_CHAIN_ID = 46630;

export const RH_RPC = readEnv("ROBINHOOD_RPC_URL") ?? "https://rpc.mainnet.chain.robinhood.com";

export interface Call {
  to: string;
  data: string;
}

const HEADERS = {
  "content-type": "application/json",
  "user-agent": "ShareExact/2.0 (+https://github.com/shareexact)",
};

/** Number of eth_calls per JSON-RPC batch. Public endpoints reject large batches. */
const BATCH_SIZE = 40;

async function singleCall(call: Call, blockTag = "latest"): Promise<string | null> {
  try {
    const res = await fetch(RH_RPC, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: call.to, data: call.data }, blockTag],
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: string; error?: { message?: string } };
    if (json.error || !json.result || json.result === "0x") return null;
    return json.result;
  } catch {
    return null;
  }
}

/**
 * Execute many `eth_call`s. A failed batch degrades to sequential calls, and a
 * failed individual call degrades to `null` — never to a thrown error, because
 * one unreachable feed must not blank out the whole portfolio.
 */
export async function ethCallBatch(calls: Call[], blockTag = "latest"): Promise<(string | null)[]> {
  if (calls.length === 0) return [];
  const out: (string | null)[] = new Array(calls.length).fill(null);

  for (let offset = 0; offset < calls.length; offset += BATCH_SIZE) {
    const slice = calls.slice(offset, offset + BATCH_SIZE);
    let handled = false;

    try {
      const res = await fetch(RH_RPC, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify(
          slice.map((call, i) => ({
            jsonrpc: "2.0",
            id: i,
            method: "eth_call",
            params: [{ to: call.to, data: call.data }, blockTag],
          })),
        ),
      });
      if (res.ok) {
        const json = (await res.json()) as { id: number; result?: string }[] | unknown;
        if (Array.isArray(json)) {
          const byId = new Map(
            json.map((row) => [row.id, row.result && row.result !== "0x" ? row.result : null]),
          );
          for (let i = 0; i < slice.length; i++) out[offset + i] = byId.get(i) ?? null;
          handled = true;
        }
      }
    } catch {
      handled = false;
    }

    if (!handled) {
      for (let i = 0; i < slice.length; i++) {
        out[offset + i] = await singleCall(slice[i], blockTag);
      }
    }
  }

  return out;
}

/** Current chain head timestamp, used to age price feeds against chain time. */
export async function getBlockTimestamp(): Promise<number | null> {
  try {
    const res = await fetch(RH_RPC, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBlockByNumber",
        params: ["latest", false],
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: { timestamp?: string } };
    const ts = json.result?.timestamp;
    if (!ts) return null;
    return Number(BigInt(ts));
  } catch {
    return null;
  }
}
