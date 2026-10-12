import { useState } from "react";
import { Button } from "@/components/ui/button";
import { COPY } from "@/lib/copy";
import { fetchThesis } from "@/lib/ai-client";
import { STOCKS, getStock, portfolioTotals } from "@/lib/stocks";
import { useDesk } from "@/lib/store";
import { formatUsd } from "@/lib/utils";

export function ThesisView() {
  const lang = useDesk((s) => s.lang);
  const t = COPY[lang];
  const draft = useDesk((s) => s.thesisDraft);
  const setDraft = useDesk((s) => s.setThesisDraft);
  const basket = useDesk((s) => s.lastBasket);
  const setBasket = useDesk((s) => s.setBasket);
  const applyBasket = useDesk((s) => s.applyBasket);
  const holdings = useDesk((s) => s.holdings);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const budget = Math.max(10_000, Math.round(portfolioTotals(holdings).value) || 25_000);

  async function compose() {
    setBusy(true);
    setErr(null);
    const res = await fetchThesis({
      lang,
      thesis: draft,
      available: STOCKS.map((s) => s.symbol),
    });
    setBusy(false);
    if ("error" in res) {
      setErr(res.error);
      return;
    }
    setBasket(res);
  }

  return (
    <div className="space-y-6">
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{t.thesisHint}</p>
      <label className="block">
        <span className="mb-2 block text-xs uppercase tracking-wide text-muted-foreground">Thesis</span>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          placeholder={t.thesisPlaceholder}
          className="w-full rounded-xl border border-border bg-card px-4 py-3 text-sm leading-relaxed outline-none ring-ring focus:ring-2"
        />
      </label>
      <Button onClick={compose} disabled={busy || draft.trim().length < 8}>
        {busy ? t.running : t.compose}
      </Button>
      {err && <p className="text-sm text-down">{err}</p>}
      {busy && <div className="h-32 rounded-xl shimmer" />}

      {basket && (
        <article className="space-y-4">
          <p className="max-w-2xl text-lg font-medium tracking-tight">{basket.restated}</p>
          <ul className="space-y-2">
            {basket.basket.map((line) => {
              const s = getStock(line.symbol);
              return (
                <li key={line.symbol} className="rounded-xl bg-card px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-mono font-medium">
                      {line.symbol} <span className="text-xs font-sans text-muted-foreground">{s?.name}</span>
                    </span>
                    <span className="tabular text-sm">{line.weight.toFixed(0)}%</span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-primary" style={{ width: `${Math.min(100, line.weight)}%` }} />
                  </div>
                  <p className="mt-2 text-xs uppercase tracking-wide text-muted-foreground">{line.role}</p>
                  <p className="text-sm text-muted-foreground">{line.reason}</p>
                </li>
              );
            })}
          </ul>
          <div className="rounded-xl border border-border p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">After hours</p>
            <p className="mt-1 text-sm leading-relaxed">{basket.afterHoursNote}</p>
          </div>
          <ul className="list-disc space-y-1 ps-5 text-sm text-muted-foreground">
            {basket.risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <Button variant="secondary" onClick={() => applyBasket(basket, budget)}>
            {t.applyBasket} · {formatUsd(budget, 0)}
          </Button>
        </article>
      )}
    </div>
  );
}
