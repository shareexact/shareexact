import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { fallbackRawToUi, formatFixedToDecimalString, parseMultiplier } from "./conversion";

const RH_RPC = "https://rpc.mainnet.chain.robinhood.com";
const ASSETS_URL = "https://api.robinhood.com/rhj/assets";
const CHAIN_ID = 4663;

export interface RegistryAsset {
  symbol: string;
  name: string;
  contract: string;
  /**
   * Registry snapshot of `uiMultiplier`. Reference only.
   *
   * The registry is a cache maintained off-chain; the token is the truth. This
   * value is safe to display next to a label that says where it came from, and
   * is never used to compute an amount that gets signed — `oracle.ts` reads the
   * live value, and `exact-transfer.ts` reads it again through the user's own
   * wallet immediately before signing.
   */
  multiplier: string;
  /** "registry-snapshot" when the registry supplied it, "assumed" when it did not. */
  multiplierSource: "registry-snapshot" | "assumed";
  decimals: number;
}

let assetCache: { at: number; assets: RegistryAsset[] } | null = null;

function padAddr(addr: string) {
  return addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

async function rpcCall(to: string, data: string): Promise<string | null> {
  const res = await fetch(RH_RPC, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 ShareExact/1.0",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { result?: string; error?: { message?: string } };
  if (j.error || !j.result || j.result === "0x") return null;
  return j.result;
}

async function rpcBatch(calls: { to: string; data: string }[]): Promise<(string | null)[]> {
  if (calls.length === 0) return [];
  const body = calls.map((c, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "eth_call",
    params: [{ to: c.to, data: c.data }, "latest"],
  }));
  const res = await fetch(RH_RPC, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 ShareExact/1.0",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const out: (string | null)[] = [];
    for (const c of calls) out.push(await rpcCall(c.to, c.data));
    return out;
  }
  const json = (await res.json()) as { id: number; result?: string }[] | { result?: string };
  if (!Array.isArray(json)) {
    const out: (string | null)[] = [];
    for (const c of calls) out.push(await rpcCall(c.to, c.data));
    return out;
  }
  const byId = new Map(json.map((row) => [row.id, row.result && row.result !== "0x" ? row.result : null]));
  return calls.map((_, i) => byId.get(i) ?? null);
}

export async function loadRhjAssets(force = false): Promise<RegistryAsset[]> {
  if (!force && assetCache && Date.now() - assetCache.at < 10 * 60_000) return assetCache.assets;
  const res = await fetch(ASSETS_URL, {
    headers: { "user-agent": "Mozilla/5.0 ShareExact/1.0" },
  });
  if (!res.ok) throw new Error(`Registry HTTP ${res.status}`);
  const data = (await res.json()) as {
    assets?: {
      tokenSymbol?: string;
      tokenName?: string;
      tokenDecimals?: number;
      currentMultiplier?: string;
      status?: string;
      deployments?: { chainId?: number | string; contractAddress?: string }[];
    }[];
  };
  const assets: RegistryAsset[] = [];
  for (const a of data.assets ?? []) {
    if (a.status !== "ASSET_STATUS_ACTIVE") continue;
    const dep = (a.deployments ?? []).find((d) => Number(d.chainId) === CHAIN_ID);
    if (!dep?.contractAddress || !a.tokenSymbol) continue;
    assets.push({
      symbol: a.tokenSymbol,
      name: (a.tokenName ?? a.tokenSymbol).replace(/\s*•.*$/, ""),
      contract: dep.contractAddress,
      // Registry snapshot, NOT chain truth. Displayed for reference and
      // labelled as such; the authoritative multiplier is read live from the
      // token by `oracle.ts` and again by the wallet preflight before signing.
      // Nothing in the send path may use this value.
      multiplier: a.currentMultiplier || "1.000000000000000000",
      multiplierSource: a.currentMultiplier ? "registry-snapshot" : "assumed",
      decimals: a.tokenDecimals ?? 18,
    });
  }
  if (assets.length) assetCache = { at: Date.now(), assets };
  return assets;
}

export const fetchRegistry = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const assets = await loadRhjAssets();
    return { ok: true as const, assets, count: assets.length };
  } catch (err) {
    return { ok: false as const, assets: [] as RegistryAsset[], error: String(err) };
  }
});

export const scanWalletBook = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ address: z.string().min(8) }).parse(input))
  .handler(async ({ data }) => {
    const address = data.address;
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return { ok: false as const, holdings: [], scanned: 0, error: "Invalid address" };
    }
    let assets: RegistryAsset[] = [];
    try {
      assets = await loadRhjAssets();
    } catch (err) {
      return { ok: false as const, holdings: [], scanned: 0, error: String(err) };
    }

    const selector = `0x70a08231${padAddr(address)}`;
    const holdings: {
      symbol: string;
      name: string;
      contract: string;
      multiplier: string;
      shares: number;
      raw: string;
    }[] = [];

    const chunk = 40;
    for (let i = 0; i < assets.length; i += chunk) {
      const slice = assets.slice(i, i + chunk);
      const results = await rpcBatch(slice.map((a) => ({ to: a.contract, data: selector })));
      for (let j = 0; j < slice.length; j++) {
        const hex = results[j];
        if (!hex) continue;
        let raw = 0n;
        try {
          raw = BigInt(hex);
        } catch {
          continue;
        }
        if (raw === 0n) continue;
        const a = slice[j];
        const mult = parseMultiplier(a.multiplier);
        const ui = fallbackRawToUi(raw, mult);
        const shares = Number(formatFixedToDecimalString(ui));
        if (!Number.isFinite(shares) || shares <= 0) continue;
        holdings.push({
          symbol: a.symbol,
          name: a.name,
          contract: a.contract,
          multiplier: a.multiplier,
          shares,
          raw: raw.toString(),
        });
      }
    }

    holdings.sort((a, b) => b.shares - a.shares);
    return { ok: true as const, holdings, scanned: assets.length, assets };
  });
