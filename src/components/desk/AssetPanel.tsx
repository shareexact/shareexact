import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spark } from "./Spark";
import { COPY, isRtl } from "@/lib/copy";
import { fetchAsset } from "@/lib/ai-client";
import { displayedShares, getStock, holdingValue } from "@/lib/stocks";
import { useDesk, type Stance } from "@/lib/store";
import { formatPct, formatShares, formatUsd, shortAddr } from "@/lib/utils";

const STANCE_TONE: Record<Stance, "up" | "down" | "night" | "neutral"> = {
  hold: "neutral",
  add: "up",
  trim: "down",
  replace: "night",
};

export function AssetPanel() {
  const lang = useDesk((s) => s.lang);
  const t = COPY[lang];
  const symbol = useDesk((s) => s.openSymbol);
  const holdings = useDesk((s) => s.holdings);
  const thesis = useDesk((s) => s.thesisDraft);
  const analysis = useDesk((s) => (symbol ? s.analyses[symbol] : undefined));
  const setOpen = useDesk((s) => s.setOpenSymbol);
  const setAnalysis = useDesk((s) => s.setAnalysis);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!symbol) return null;
  const openSymbol = symbol;
  const stock = getStock(openSymbol);
  if (!stock) return null;
  const holding = holdings.find((h) => h.symbol === openSymbol);
  const hv = holding ? holdingValue(holding) : null;

  async function analyze() {
    setBusy(true);
    setErr(null);
    const res = await fetchAsset({ lang, thesis, symbol: openSymbol, holdings });
    setBusy(false);
    if ("error" in res) {
      setErr(res.error);
      return;
    }
    setAnalysis(res);
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-bg/70" onClick={() => setOpen(null)}>
      <aside
        className="flex h-full w-full max-w-md flex-col overflow-y-auto border-s border-border bg-surface p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        dir={isRtl(lang) ? "rtl" : "ltr"}
      >
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <p className="font-mono text-xs tracking-widest text-muted-foreground">{stock.sector}</p>
            <h2 className="text-2xl font-semibold tracking-tight">
              {stock.symbol}{" "}
              <span className="text-base font-normal text-muted-foreground">{stock.name}</span>
            </h2>
          </div>
          <Button variant="ghost" size="icon" onClick={() => setOpen(null)} aria-label="Close">
            <X />
          </Button>
        </div>

        <div className="mb-4 flex items-end justify-between gap-3">
          <div>
            <p className="tabular text-3xl font-medium tracking-tight">{formatUsd(stock.price)}</p>
            <p className={`tabular text-sm ${stock.change1d >= 0 ? "text-up" : "text-down"}`}>
              {formatPct(stock.change1d)} session · {formatPct(stock.afterHours)} AH
            </p>
          </div>
          <Spark change={stock.change1d} afterHours={stock.afterHours} />
        </div>

        <dl className="mb-5 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-xl bg-card p-3">
            <dt className="text-xs text-muted-foreground">{t.shares}</dt>
            <dd className="tabular font-medium">{holding ? formatShares(displayedShares(holding)) : "—"}</dd>
          </div>
          <div className="rounded-xl bg-card p-3">
            <dt className="text-xs text-muted-foreground">{t.value}</dt>
            <dd className="tabular font-medium">{hv ? formatUsd(hv.value) : "—"}</dd>
          </div>
          <div className="rounded-xl bg-card p-3">
            <dt className="text-xs text-muted-foreground">{t.multiplier}</dt>
            <dd className="tabular font-mono text-sm">{Number(stock.multiplier).toFixed(6)}×</dd>
          </div>
          <div className="rounded-xl bg-card p-3">
            <dt className="text-xs text-muted-foreground">Contract</dt>
            <dd className="font-mono text-xs">{shortAddr(stock.contract)}</dd>
          </div>
        </dl>

        <p className="mb-5 text-sm leading-relaxed text-muted-foreground">
          {isRtl(lang) ? stock.aboutFa : stock.about}
        </p>

        {Number(stock.multiplier) >= 2 && (
          <p className="mb-5 rounded-xl border border-down/30 bg-down/10 p-3 text-sm">
            Multiplier trap: sending the displayed share count as raw would move {Number(stock.multiplier).toFixed(0)}×
            as many units. Use Exact send.
          </p>
        )}

        {analysis ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Badge tone={STANCE_TONE[analysis.stance]}>{analysis.stance}</Badge>
              <span className="text-xs text-muted-foreground">
                {new Date(analysis.generatedAt).toLocaleString()}
              </span>
            </div>
            <p className="text-sm leading-relaxed">{analysis.summary}</p>
            {analysis.angles.map((a) => (
              <div key={a.title} className="rounded-xl bg-card p-3">
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{a.title}</p>
                <p className="text-sm leading-relaxed">{a.body}</p>
              </div>
            ))}
            {analysis.replaceWith && (
              <div className="rounded-xl border border-border p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">{t.replace}</p>
                <p className="font-medium">{analysis.replaceWith.symbol}</p>
                <p className="text-sm text-muted-foreground">{analysis.replaceWith.why}</p>
              </div>
            )}
            <p className="text-sm text-muted-foreground">{analysis.afterHours}</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t.clickHint}</p>
        )}

        {err && <p className="mt-3 text-sm text-down">{err}</p>}

        <Button className="mt-6 w-full" onClick={analyze} disabled={busy}>
          {busy ? t.running : t.analyze}
        </Button>
      </aside>
    </div>
  );
}
