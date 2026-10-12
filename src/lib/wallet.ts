/** EIP-6963 wallet discovery + Robinhood Chain (4663) add/switch. */

export const RH_CHAIN_ID = 4663;
export const RH_CHAIN_HEX = "0x1237";
export const RH_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const RH_EXPLORER = "https://robinhoodchain.blockscout.com";

export interface EthereumProvider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
}

export interface WalletOption {
  name: string;
  rdns: string;
  icon: string;
  provider: EthereumProvider;
}

function fallbackName(p: EthereumProvider & Record<string, unknown>) {
  if (p.isRabby) return "Rabby";
  if (p.isMetaMask) return "MetaMask";
  if (p.isCoinbaseWallet) return "Coinbase Wallet";
  if (p.isOkxWallet || p.isOKExWallet) return "OKX Wallet";
  if (p.isBraveWallet) return "Brave Wallet";
  if (p.isPhantom) return "Phantom";
  if (p.isTrust) return "Trust Wallet";
  return "Browser wallet";
}

export function discoverWallets(): WalletOption[] {
  const byKey = new Map<string, WalletOption>();

  function remember(info: { name?: string; rdns?: string; uuid?: string; icon?: string }, provider: EthereumProvider) {
    if (!provider) return;
    const key = info.rdns || info.uuid || info.name || "injected";
    if (byKey.has(key)) return;
    byKey.set(key, {
      name: info.name || fallbackName(provider as EthereumProvider & Record<string, unknown>),
      rdns: key,
      icon: info.icon || "",
      provider,
    });
  }

  if (typeof window === "undefined") return [];

  window.addEventListener("eip6963:announceProvider", ((e: Event) => {
    const detail = (e as CustomEvent).detail as { info?: { name?: string; rdns?: string; uuid?: string; icon?: string }; provider?: EthereumProvider };
    if (detail?.provider) remember(detail.info ?? {}, detail.provider);
  }) as EventListener);
  try {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  } catch {
    /* old browsers */
  }

  const eth = (window as Window & { ethereum?: EthereumProvider & { providers?: EthereumProvider[] } }).ethereum;
  if (eth) {
    const list = Array.isArray(eth.providers) && eth.providers.length ? eth.providers : [eth];
    for (const p of list) remember({ name: fallbackName(p as EthereumProvider & Record<string, unknown>) }, p);
  }

  return [...byKey.values()];
}

export async function requestAccounts(provider: EthereumProvider): Promise<string[]> {
  const acc = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!acc?.[0]) throw new Error("No account");
  return acc;
}

/** Already-authorized accounts, no popup. Empty if the user has not connected this origin. */
export async function readAccounts(provider: EthereumProvider): Promise<string[]> {
  try {
    const acc = (await provider.request({ method: "eth_accounts" })) as string[];
    return Array.isArray(acc) ? acc.filter(Boolean) : [];
  } catch {
    return [];
  }
}

export async function readChainId(provider: EthereumProvider): Promise<number> {
  const hex = (await provider.request({ method: "eth_chainId" })) as string;
  return Number(hex);
}

export async function ensureRobinhoodChain(provider: EthereumProvider): Promise<number> {
  const current = await readChainId(provider);
  if (current === RH_CHAIN_ID) return current;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: RH_CHAIN_HEX }],
    });
  } catch (err) {
    const e = err as { code?: number; message?: string };
    const needsAdd =
      e.code === 4902 ||
      e.code === -32603 ||
      String(e.message || "").toLowerCase().includes("unrecognized");
    if (!needsAdd) throw err;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: RH_CHAIN_HEX,
          chainName: "Robinhood Chain",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [RH_RPC],
          blockExplorerUrls: [RH_EXPLORER],
        },
      ],
    });
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: RH_CHAIN_HEX }],
    });
  }
  return readChainId(provider);
}
