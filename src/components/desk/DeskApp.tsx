import { useEffect, useMemo, useState } from "react";
import { COPY, LANGS, detectLang, type Lang } from "@/lib/copy";
import { getMarketSession } from "@/lib/session";
import { scanWalletBook, fetchRegistry } from "@/lib/scan";
import { explorerTxUrl } from "@/lib/exact-transfer";
import { fetchOracleState } from "@/lib/oracle";
import { getStock, mergeLiveAssets, mergeOracleMarks, STOCKS, isDustBook } from "@/lib/stocks";
import { buildRiskSnapshot } from "@/lib/risk";
import { buildLocalBrief } from "@/lib/desk-engine";
import { useDesk, type ViewId } from "@/lib/store";
import { formatPct } from "@/lib/utils";
import {
  discoverWallets,
  ensureRobinhoodChain,
  readAccounts,
  requestAccounts,
  type WalletOption,
} from "@/lib/wallet";
import { Button } from "@/components/ui/button";
import { AssetPanel } from "./AssetPanel";
import { BriefView } from "./BriefView";
import { HoldingsView } from "./HoldingsView";
import { NightView } from "./NightView";
import { ThesisView } from "./ThesisView";
import { TransferView } from "./TransferView";
import { RiskView } from "./RiskView";
import { OracleStatus } from "./OracleStatus";
import { DeskBar } from "./DeskBar";

const NAV: { id: ViewId; key: keyof (typeof COPY)["en"] }[] = [
  { id: "transfer", key: "navTransfer" },
  { id: "brief", key: "navBrief" },
  { id: "holdings", key: "navHoldings" },
  { id: "thesis", key: "navThesis" },
  { id: "night", key: "navNight" },
  { id: "risk", key: "navRisk" },
];

export function DeskApp() {
  const lang = useDesk((s) => s.lang);
  const setLang = useDesk((s) => s.setLang);
  const view = useDesk((s) => s.view);
  const setView = useDesk((s) => s.setView);
  const loadSample = useDesk((s) => s.loadSample);
  const setHoldings = useDesk((s) => s.setHoldings);
  const isSample = useDesk((s) => s.isSample);
  const activity = useDesk((s) => s.activity);
  const holdings = useDesk((s) => s.holdings);
  const borrow = useDesk((s) => s.borrow);
  const registryCount = useDesk((s) => s.registryCount);
  const setRegistryCount = useDesk((s) => s.setRegistryCount);
  const setOracle = useDesk((s) => s.setOracle);
  const setOracleLoading = useDesk((s) => s.setOracleLoading);
  const t = COPY[lang];
  // A 15-second heartbeat that re-renders the desk so session labels and price
  // ages stay current. The value is never read; incrementing it is the effect.
  const [, setTick] = useState(0);
  const [help, setHelp] = useState(false);
  const [picker, setPicker] = useState(false);
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [active, setActive] = useState<WalletOption | null>(null);
  const [wallet, setWallet] = useState<{ address: string; name: string } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const session = getMarketSession();
  const tape = useMemo(() => STOCKS, []);
  const health = buildRiskSnapshot(holdings, borrow);

  useEffect(() => {
    setLang(detectLang());
    const id = window.setInterval(() => setTick((n) => n + 1), 15_000);
    return () => window.clearInterval(id);
  }, [setLang]);

  useEffect(() => {
    void fetchRegistry().then((res) => {
      if (!res.ok || !res.assets.length) return;
      mergeLiveAssets(res.assets);
      setRegistryCount(res.count);
    });
  }, [setRegistryCount]);

  useEffect(() => {
    const found = discoverWallets();
    setWallets(found);
    let cancelled = false;
    void (async () => {
      for (const option of found) {
        const acc = await readAccounts(option.provider);
        if (cancelled) return;
        if (acc[0]) {
          await attachWallet(option, acc);
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // First paint only: pick up an already-authorized injected wallet
    // (Grok preview panel, Rabby, MetaMask) so the desk does not ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const provider = active?.provider;
    if (!provider?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const list = Array.isArray(args[0]) ? (args[0] as string[]) : [];
      if (!list[0]) {
        setWallet(null);
        setStatus(null);
        return;
      }
      if (active) void attachWallet(active, list);
    };
    provider.on("accountsChanged", onAccounts);
    return () => provider.removeListener?.("accountsChanged", onAccounts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  /**
   * Poll the chain for the state every number on this screen depends on.
   *
   * Runs on the holdings actually displayed rather than all ~95 registry
   * assets: four token reads plus one feed read each, so the batch stays small
   * enough for a public endpoint. Sixty seconds is deliberate — a 24/5 equity
   * feed does not move faster than that, and a tighter loop would only make the
   * staleness we are trying to surface harder to see.
   */
  useEffect(() => {
    let cancelled = false;
    const symbols = [...new Set(holdings.map((h) => h.symbol))];
    if (symbols.length === 0) {
      setOracle(null);
      return;
    }

    async function poll() {
      setOracleLoading(true);
      try {
        const snapshot = await fetchOracleState({ data: { symbols } });
        if (cancelled) return;
        if (snapshot.ok && snapshot.assets.length > 0) mergeOracleMarks(snapshot.assets);
        setOracle(snapshot);
      } catch {
        if (!cancelled) setOracle(null);
      } finally {
        if (!cancelled) setOracleLoading(false);
      }
    }

    void poll();
    const id = window.setInterval(() => void poll(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [holdings, setOracle, setOracleLoading]);

  useEffect(() => {
    const meta = LANGS.find((l) => l.id === lang) ?? LANGS[0];
    document.documentElement.lang = lang;
    document.documentElement.dir = meta.dir;
    const state = useDesk.getState();
    const bits = {
      kind: session.kind,
      label: session.label,
      nyTime: session.nyTime,
      nyDate: session.nyDate,
      detail: session.detail,
    };
    if (state.brief) {
      state.setBrief(
        buildLocalBrief({
          kind: state.brief.kind,
          lang,
          thesis: state.thesisDraft,
          session: bits,
          holdings: state.holdings,
        }),
      );
    }
    if (state.weekly) {
      state.setWeekly(
        buildLocalBrief({
          kind: "weekly",
          lang,
          thesis: state.thesisDraft,
          session: bits,
          holdings: state.holdings,
        }),
      );
    }
    // `bits` is recomputed from `session` on every render and the brief is only
    // meant to be rebuilt when the language changes, so `session.*` is
    // deliberately excluded. Listing those fields would rebuild both briefs
    // every fifteen seconds when the heartbeat ticks, discarding the user's
    // generated brief for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  function openPicker() {
    if (wallet) return;
    const found = discoverWallets();
    setWallets(found);
    if (found.length === 1) {
      void attachWallet(found[0]);
      return;
    }
    setPicker(true);
  }

  function disconnect() {
    setWallet(null);
    setActive(null);
    setStatus(null);
  }

  async function attachWallet(option: WalletOption, knownAccounts?: string[]) {
    setActive(option);
    setPicker(false);
    setStatus(t.scanning);
    try {
      const acc = knownAccounts?.length ? knownAccounts : await requestAccounts(option.provider);
      const address = acc[0];
      const chain = await ensureRobinhoodChain(option.provider);
      if (chain !== 4663) {
        setStatus(t.wrongChain);
        return;
      }
      setWallet({ address, name: option.name });
      const result = await scanWalletBook({ data: { address } });
      if (!result.ok) {
        setStatus(result.error || t.emptyBook);
        setHoldings([]);
        return;
      }
      if (result.assets?.length) mergeLiveAssets(result.assets);
      const book = result.holdings.map((h) => {
        const s = getStock(h.symbol);
        return { symbol: h.symbol, shares: h.shares, raw: h.raw, cost: s?.price || 0 };
      });
      setHoldings(book);
      setStatus(
        book.length
          ? `${option.name} · ${book.length} ${t.foundInWallet}`
          : t.emptyBook,
      );
    } catch (err) {
      setStatus(err instanceof Error ? err.message : t.noWallet);
    }
  }

  const titleKey: Record<ViewId, keyof (typeof COPY)["en"]> = {
    brief: "titleBrief",
    holdings: "titleHoldings",
    thesis: "titleThesis",
    night: "titleNight",
    transfer: "titleTransfer",
    risk: "titleRisk",
  };

  return (
    <div className={`min-h-dvh bg-bg text-foreground ${session.isNightDesk ? "night-desk" : ""}`}>
      <div className="tape-wrap border-b border-border bg-surface py-2" aria-hidden="true" dir="ltr">
        <div className="tape text-xs text-tape">
          {[0, 1].map((copy) => (
            <div key={copy} className="tape-track">
              {tape.map((s) => (
                <span key={`${copy}-${s.symbol}`} className="inline-flex gap-2">
                  <span className="font-mono">{s.symbol}</span>
                  <span className={s.afterHours >= 0 ? "text-up" : "text-down"}>
                    {formatPct(s.afterHours)} AH
                  </span>
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      <DeskBar
        lang={lang}
        session={session}
        registryCount={registryCount}
        healthLabel={isDustBook(holdings) && !isSample ? t.dustBadge : `${t.health} ${health.healthScore.toFixed(0)}`}
        healthTone={health.band === "low" ? "open" : health.band === "moderate" ? "night" : "down"}
        wallet={wallet}
        status={status}
        onConnect={openPicker}
        onDisconnect={disconnect}
        onRefresh={() => {
          if (active) void attachWallet(active);
        }}
      />

      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-5 md:flex-row md:px-6">
        <aside className="md:sticky md:top-[4.5rem] md:h-[calc(100dvh-5rem)] md:w-52 md:shrink-0">
          <nav className="grid grid-cols-2 gap-1 md:grid-cols-1" aria-label="Desk">
            {NAV.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setView(item.id)}
                className={`h-11 rounded-md px-3 text-start text-sm ${
                  view === item.id ? "bg-card text-foreground" : "text-muted-foreground hover:bg-card/60 hover:text-foreground"
                }`}
              >
                {t[item.key]}
              </button>
            ))}
          </nav>
          <div className="mt-6 space-y-2">
            <label className="block text-xs text-muted-foreground">
              {t.language}
              <select
                value={lang}
                onChange={(e) => setLang(e.target.value as Lang)}
                className="mt-1 h-11 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground"
              >
                {LANGS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
            <Button variant="ghost" className="w-full justify-start" onClick={() => setHelp(true)}>
              {t.how}
            </Button>
            {/*
              The source-download button pointed at /ShareExact-source.zip, a
              file that was never in public/. A dead link on a live site is
              worse than no link, so it is gone rather than repaired: the code
              belongs in a repository, not a zip served from the app.
            */}
            <a
              href="https://x.com/ShareExact"
              target="_blank"
              rel="noreferrer"
              aria-label="ShareExact on X"
              title="ShareExact on X"
              className="inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </a>
          </div>
        </aside>

        <main className="min-w-0 flex-1 pb-16">
          <header className="mb-8 border-b border-border pb-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="max-w-xl text-3xl font-semibold tracking-tight md:text-4xl">
                  {t[titleKey[view]]}
                </h1>
                <p className="mt-2 max-w-xl text-sm text-muted-foreground">{t.tagline}</p>
              </div>
              <Button variant="secondary" size="sm" onClick={loadSample}>
                {t.loadDesk}
              </Button>
            </div>
          </header>

          {!isSample && holdings.length > 0 && isDustBook(holdings) && (
            <div className="mb-8 flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-2xl text-sm leading-relaxed">{t.dustBanner}</p>
              <Button onClick={loadSample}>{t.loadDesk}</Button>
            </div>
          )}

          <OracleStatus />

          {view === "brief" && <BriefView />}
          {view === "holdings" && <HoldingsView />}
          {view === "thesis" && <ThesisView />}
          {view === "night" && <NightView />}
          {view === "transfer" && (
            <TransferView provider={active?.provider ?? null} address={wallet?.address ?? null} />
          )}
          {view === "risk" && <RiskView />}

          {view === "transfer" && activity.length > 0 && (
            <section className="mt-8">
              <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.activity}</h3>
              <ul className="space-y-2 text-sm">
                {activity.map((a) => (
                  <li key={a.id} className="rounded-xl bg-card px-4 py-3 font-mono text-xs">
                    <span>
                      {a.symbol} · {a.uiShares} sh → raw {a.raw} · {a.multiplier}
                      {a.route ? ` · ${a.route}` : ""} · {a.note}
                    </span>
                    {a.hash && (
                      <>
                        {" · "}
                        <a
                          href={explorerTxUrl(a.hash)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary underline underline-offset-2"
                        >
                          {a.hash.slice(0, 10)}… ↗
                        </a>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <p className="mt-12 max-w-3xl text-xs leading-relaxed text-muted-foreground">{t.legal}</p>
        </main>
      </div>

      <AssetPanel />

      {picker && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-bg/70 p-4" onClick={() => setPicker(false)}>
          <article
            className="w-full max-w-md rounded-xl border border-border bg-surface p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-semibold tracking-tight">{t.pickWallet}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t.pickWalletBody}</p>
            <div className="mt-4 grid gap-2">
              {wallets.length === 0 && <p className="text-sm text-down">{t.noWallet}</p>}
              {wallets.map((w) => (
                <Button key={w.rdns} variant="secondary" className="h-12 justify-start" onClick={() => void attachWallet(w)}>
                  {w.name}
                </Button>
              ))}
            </div>
            <Button className="mt-4" variant="ghost" onClick={() => setPicker(false)}>
              {t.close}
            </Button>
          </article>
        </div>
      )}

      {help && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-bg/70 p-4" onClick={() => setHelp(false)}>
          <article
            className="max-h-[80dvh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-surface p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-semibold tracking-tight">{t.how}</h2>
            <div className="mt-4 space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p>{t.help1}</p>
              <p>{t.help2}</p>
              <p>{t.help3}</p>
            </div>
            <Button className="mt-6" onClick={() => setHelp(false)}>
              {t.close}
            </Button>
          </article>
        </div>
      )}
    </div>
  );
}
