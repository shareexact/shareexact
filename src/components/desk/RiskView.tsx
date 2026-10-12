import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { COPY, isRtl } from "@/lib/copy";
import { aaplSplitMarks, buildRiskSnapshot, SCENARIOS, stressRisk, type BookMarks } from "@/lib/risk";
import { displayedShares, getStock, isDustBook } from "@/lib/stocks";
import { useDesk } from "@/lib/store";
import { formatShares, formatUsd } from "@/lib/utils";

export function RiskView() {
  const lang = useDesk((s) => s.lang);
  const t = COPY[lang];
  const rtl = isRtl(lang);
  const holdings = useDesk((s) => s.holdings);
  const setView = useDesk((s) => s.setView);
  const loadSample = useDesk((s) => s.loadSample);
  const borrow = useDesk((s) => s.borrow);
  const setBorrow = useDesk((s) => s.setBorrow);
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const [split, setSplit] = useState(false);

  const marks: BookMarks | undefined = split ? aaplSplitMarks() : undefined;
  const idle = useMemo(() => buildRiskSnapshot(holdings, 0, marks), [holdings, marks]);
  const base = useMemo(() => buildRiskSnapshot(holdings, borrow, marks), [holdings, borrow, marks]);
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  const stress = useMemo(
    () =>
      scenario
        ? stressRisk(holdings, scenario.shocks, borrow, rtl ? scenario.labelFa : scenario.label, marks)
        : null,
    [holdings, borrow, scenario, marks, rtl],
  );
  const shown = stress ?? base;
  const bandTone = shown.band === "low" ? "open" : shown.band === "moderate" ? "night" : "down";
  const actionLabel =
    !stress || stress.action === "none"
      ? t.noAction
      : stress.action === "protect"
        ? t.protect
        : stress.action === "reduce"
          ? t.reduce
          : t.monitor;

  const crwd = holdings.find((h) => h.symbol === "CRWD");
  const crwdStock = getStock("CRWD");
  const aapl = holdings.find((h) => h.symbol === "AAPL");
  const aaplStock = getStock("AAPL");
  const aaplUi = (aapl ? displayedShares(aapl) : 0) * (marks?.AAPL?.shareMul ?? 1);
  const aaplPx = marks?.AAPL?.price ?? aaplStock?.price ?? 0;
  const aaplMult = marks?.AAPL?.multiplier ?? Number(aaplStock?.multiplier ?? 1);
  const aaplValue = aaplUi * aaplPx;

  function playJudge() {
    setSplit(false);
    setScenarioId(null);
    const cap = buildRiskSnapshot(holdings, 0).maxBorrow;
    const line = cap >= 12_000 ? 10_000 : Math.round(cap * 0.4 / 500) * 500;
    setBorrow(Math.max(500, line));
    window.setTimeout(() => setScenarioId("ai"), 450);
  }

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{t.riskIntro}</p>

      {isDustBook(holdings) && (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-2xl text-sm leading-relaxed">{t.dustBanner}</p>
          <Button onClick={loadSample}>{t.loadDesk}</Button>
        </div>
      )}

      {crwd && crwdStock && (
        <article className="rounded-xl border border-border bg-card p-5">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{t.exactness}</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">
            CRWD {formatShares(displayedShares(crwd))} {t.shares} · {Number(crwdStock.multiplier).toFixed(0)}×
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{t.crwdTrap}</p>
          <Button className="mt-4" variant="secondary" onClick={() => setView("transfer")}>
            {t.exactSendCta}
          </Button>
        </article>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label={t.value} value={formatUsd(shown.portfolioValue)} />
        <Metric
          label={t.health}
          value={`${shown.healthScore.toFixed(0)} / 100`}
          badge={shown.band.toUpperCase()}
          tone={bandTone}
        />
        <Metric label={t.collateral} value={formatUsd(shown.maxBorrow)} />
        <Metric
          label={t.utilization}
          value={`${(shown.utilization * 100).toFixed(0)}%`}
          badge={borrow > 0 ? t.borrow : undefined}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
        <article className="rounded-xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">{t.passport}</p>
              <h2 className="mt-1 text-xl font-semibold tracking-tight">{t.health}</h2>
            </div>
            <Badge tone={bandTone}>{shown.band}</Badge>
          </div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <RiskBar label={t.concentration} value={shown.concentrationRisk} />
            <RiskBar label={t.multiplier} value={shown.multiplierRisk} />
            <RiskBar label={t.volatility} value={shown.volatilityRisk} />
            <RiskBar label={t.leverage} value={shown.leverageRisk} />
          </div>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-2 text-start">{t.nameCol}</th>
                  <th className="py-2 text-end">{t.weight}</th>
                  <th className="py-2 text-end">{t.multiplier}</th>
                  <th className="py-2 text-end">LTV</th>
                  <th className="py-2 text-end">{t.collateral}</th>
                </tr>
              </thead>
              <tbody>
                {shown.positions.map((p) => (
                  <tr key={p.symbol} className="border-t border-border">
                    <td className="py-3 font-mono">{p.symbol}</td>
                    <td className="py-3 text-end tabular">{(p.weight * 100).toFixed(1)}%</td>
                    <td className="py-3 text-end tabular">{p.multiplier.toFixed(4)}×</td>
                    <td className="py-3 text-end tabular">{(p.ltvLimit * 100).toFixed(0)}%</td>
                    <td className="py-3 text-end tabular">{formatUsd(p.collateralValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>

        <article className="rounded-xl border border-border p-5">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{t.unlockLiquidity}</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">{t.borrow}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t.borrowHint}</p>
          <label className="mt-6 block">
            <span className="mb-2 block text-xs text-muted-foreground">{t.borrow}</span>
            <input
              type="range"
              min={0}
              max={Math.max(1000, Math.round(base.maxBorrow))}
              step={500}
              value={Math.min(borrow, Math.max(0, Math.round(base.maxBorrow)))}
              onChange={(e) => setBorrow(Number(e.target.value))}
              className="w-full accent-primary"
            />
            <span className="mt-2 block font-mono text-lg tabular">{formatUsd(borrow)}</span>
          </label>
          <dl className="mt-5 space-y-3 text-sm">
            <Row k={t.collateral} v={formatUsd(base.maxBorrow)} />
            <Row k={t.health} v={`${base.healthScore.toFixed(0)} / 100`} />
            <Row k={t.liq} v={`${(base.liquidationLtv * 100).toFixed(0)}%`} />
          </dl>
          <p className="mt-6 rounded-lg bg-muted p-4 text-sm leading-relaxed">{t.safetyRule}</p>
        </article>
      </div>

      <article className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t.judgePath}</p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight">{t.stressBook}</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={playJudge}>{t.playJudge}</Button>
            {SCENARIOS.map((s) => (
              <Button
                key={s.id}
                variant={scenarioId === s.id ? "default" : "secondary"}
                onClick={() => setScenarioId(s.id)}
              >
                {rtl ? s.labelFa : s.label}
              </Button>
            ))}
          </div>
        </div>
        {stress ? (
          <>
            <div className="mt-6 grid gap-3 sm:grid-cols-4">
              <Metric label={t.stressBook} value={rtl ? scenario?.labelFa ?? stress.scenario : stress.scenario} />
              <Metric label={t.value} value={formatUsd(stress.shockedValue)} />
              <Metric label={t.drawdown} value={`${(stress.drawdown * 100).toFixed(1)}%`} />
              <Metric label={t.stance} value={actionLabel} />
            </div>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <div className="rounded-lg border border-border p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">{t.health}</p>
                <p className="mt-2 text-3xl font-semibold tabular">
                  {idle.healthScore.toFixed(0)} → {base.healthScore.toFixed(0)} → {stress.shockedHealth.toFixed(0)}
                </p>
                <p className="mt-2 text-sm text-muted-foreground">{t.healthDropNote}</p>
              </div>
              <div className="rounded-lg border border-border p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">{t.protect}</p>
                <div className="mt-3 space-y-2 text-sm">
                  <Row k={t.repay} v={formatUsd(stress.suggestedRepay)} />
                  <Row k={t.addCollateral} v={formatUsd(stress.suggestedCollateral)} />
                </div>
              </div>
            </div>
          </>
        ) : (
          <p className="mt-5 text-sm text-muted-foreground">{t.stressEmpty}</p>
        )}
      </article>

      <article className="rounded-xl border border-border p-5">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{t.corpAction}</p>
        <h2 className="mt-1 text-xl font-semibold tracking-tight">{t.runSplit}</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{t.splitIntro}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant={split ? "secondary" : "default"} onClick={() => setSplit(true)} disabled={!aapl}>
            {t.runSplit}
          </Button>
          <Button variant="secondary" onClick={() => setSplit(false)} disabled={!split}>
            {t.undoSplit}
          </Button>
        </div>
        {aapl && aaplStock && (
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label={t.shares} value={`${formatShares(displayedShares(aapl))} → ${formatShares(aaplUi)}`} />
            <Metric label={t.multiplier} value={`${Number(aaplStock.multiplier).toFixed(4)}× → ${aaplMult.toFixed(4)}×`} />
            <Metric label={t.value} value={formatUsd(aaplValue)} />
            <Metric label={t.borrow} value={formatUsd(borrow)} />
          </div>
        )}
        {split && (
          <ul className="mt-5 grid gap-2 text-sm sm:grid-cols-2">
            <li className="rounded-lg bg-card px-4 py-3">{t.rawUnchanged}</li>
            <li className="rounded-lg bg-card px-4 py-3">{t.debtUnchanged}</li>
            <li className="rounded-lg bg-card px-4 py-3">{t.exposureUnchanged}</li>
            <li className="rounded-lg bg-card px-4 py-3">{t.healthUnchanged}</li>
          </ul>
        )}
      </article>

      <p className="text-xs leading-relaxed text-muted-foreground">{t.legal}</p>
    </div>
  );
}

function Metric({
  label,
  value,
  badge,
  tone,
}: {
  label: string;
  value: string;
  badge?: string;
  tone?: "open" | "night" | "down" | "neutral";
}) {
  return (
    <div className="rounded-xl bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-2 text-xl font-semibold tabular">{value}</p>
      {badge && (
        <Badge className="mt-2" tone={tone ?? "neutral"}>
          {badge}
        </Badge>
      )}
    </div>
  );
}

function RiskBar({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span>{label}</span>
        <span className="font-mono">{value.toFixed(0)}</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, value)}%` }} />
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-mono tabular">{v}</span>
    </div>
  );
}
