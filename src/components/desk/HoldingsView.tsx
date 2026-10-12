import { COPY } from "@/lib/copy";
import { displayedShares, getStock, holdingValue, portfolioTotals } from "@/lib/stocks";
import { useDesk } from "@/lib/store";
import { formatPct, formatShares, formatUsd } from "@/lib/utils";
import { Spark } from "./Spark";

export function HoldingsView() {
  const lang = useDesk((s) => s.lang);
  const t = COPY[lang];
  const holdings = useDesk((s) => s.holdings);
  const setOpen = useDesk((s) => s.setOpenSymbol);
  const totals = portfolioTotals(holdings);

  return (
    <div className="space-y-6">
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{t.holdingsIntro}</p>
      <p className="text-sm text-muted-foreground">{t.clickHint}</p>

      {holdings.length === 0 && (
        <p className="rounded-xl bg-card px-4 py-5 text-sm leading-relaxed text-muted-foreground">
          {t.emptyBook} {t.sampleHint}
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[640px] text-start text-sm">
          <thead className="bg-card text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">{t.nameCol}</th>
              <th className="px-4 py-3 font-medium">{t.shares}</th>
              <th className="px-4 py-3 font-medium">{t.multiplier}</th>
              <th className="px-4 py-3 font-medium">{t.value}</th>
              <th className="px-4 py-3 font-medium">{t.weight}</th>
              <th className="px-4 py-3 font-medium">{t.tapeCol}</th>
            </tr>
          </thead>
          <tbody>
            {[...holdings]
              .sort((a, b) => holdingValue(b).value - holdingValue(a).value)
              .map((h) => {
              const s = getStock(h.symbol);
              if (!s) return null;
              const hv = holdingValue(h);
              const w = totals.value > 0 ? (hv.value / totals.value) * 100 : 0;
              return (
                <tr key={h.symbol} className="border-t border-border">
                  <td className="px-4 py-3">
                    <button type="button" className="text-start" onClick={() => setOpen(h.symbol)}>
                      <span className="block font-mono font-medium">{h.symbol}</span>
                      <span className="text-xs text-muted-foreground">{s.name}</span>
                    </button>
                  </td>
                  <td className="tabular px-4 py-3">{formatShares(displayedShares(h))}</td>
                  <td className="tabular px-4 py-3 font-mono text-xs">{Number(s.multiplier).toFixed(4)}×</td>
                  <td className="px-4 py-3">
                    <span className="tabular block">{s.price > 0 ? formatUsd(hv.value) : t.unpriced}</span>
                    {s.price > 0 && (
                      <span className={`tabular text-xs ${hv.pnl >= 0 ? "text-up" : "text-down"}`}>
                        {formatPct(hv.pnlPct)}
                      </span>
                    )}
                  </td>
                  <td className="tabular px-4 py-3">{s.price > 0 ? `${w.toFixed(1)}%` : "—"}</td>
                  <td className="px-4 py-3">
                    <Spark change={s.change1d} afterHours={s.afterHours} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
