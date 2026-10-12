import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { COPY } from "@/lib/copy";
import { fetchBrief } from "@/lib/ai-client";
import { displayedShares, getStock, holdingValue, portfolioTotals } from "@/lib/stocks";
import { useDesk, type BriefResult, type Stance } from "@/lib/store";
import { formatPct, formatUsd } from "@/lib/utils";

const TONE: Record<Stance, "up" | "down" | "night" | "neutral"> = {
  hold: "neutral",
  add: "up",
  trim: "down",
  replace: "night",
};

function BriefCard({
  brief,
  onOpen,
  labels,
}: {
  brief: BriefResult;
  onOpen: (s: string) => void;
  labels: { replacements: string; calendar: string; risks: string; watchTonight: string };
}) {
  return (
    <article className="space-y-5" dir="auto">
      <header>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge tone={brief.bias === "constructive" ? "up" : brief.bias === "cautious" ? "down" : "night"}>
            {brief.bias}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {brief.kind} · {new Date(brief.generatedAt).toLocaleString()}
          </span>
        </div>
        <h2 className="max-w-3xl text-2xl font-semibold tracking-tight md:text-3xl">{brief.headline}</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{brief.oneLiner}</p>
        {brief.sessionNote && <p className="mt-2 max-w-2xl text-sm">{brief.sessionNote}</p>}
      </header>

      <ul className="grid gap-2">
        {brief.holdings.map((h) => (
          <li key={h.symbol}>
            <button
              type="button"
              onClick={() => onOpen(h.symbol)}
              className="flex w-full items-start gap-3 rounded-xl bg-card px-4 py-3 text-start transition-colors hover:bg-muted/40"
            >
              <span className="w-14 font-mono text-sm font-medium">{h.symbol}</span>
              <Badge tone={TONE[h.stance]}>{h.stance}</Badge>
              <span className="flex-1 text-sm text-muted-foreground">{h.note}</span>
              {h.replaceWith && (
                <span className="hidden text-xs text-primary sm:inline">→ {h.replaceWith}</span>
              )}
            </button>
          </li>
        ))}
      </ul>

      {brief.replacements && brief.replacements.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{labels.replacements}</h3>
          <ul className="space-y-2">
            {brief.replacements.map((r) => (
              <li key={`${r.from}-${r.to}`} className="rounded-xl border border-border p-3 text-sm">
                <span className="font-mono font-medium">
                  {r.from} → {r.to}
                </span>
                <p className="mt-1 text-muted-foreground">{r.why}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {brief.calendar && brief.calendar.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{labels.calendar}</h3>
          <ul className="space-y-1 text-sm">
            {brief.calendar.map((c) => (
              <li key={c.event} className="flex gap-3">
                <span className="w-28 font-mono text-muted-foreground">{c.when}</span>
                <span>
                  {c.event} <span className="text-muted-foreground">{c.symbols}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl bg-card p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{labels.risks}</p>
          <ul className="mt-2 list-disc space-y-1 ps-4 text-sm">
            {brief.risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl bg-card p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{labels.watchTonight}</p>
          <p className="mt-2 text-sm leading-relaxed">{brief.watchTonight}</p>
        </div>
      </div>
    </article>
  );
}

export function BriefView() {
  const lang = useDesk((s) => s.lang);
  const t = COPY[lang];
  const holdings = useDesk((s) => s.holdings);
  const thesis = useDesk((s) => s.thesisDraft);
  const brief = useDesk((s) => s.brief);
  const weekly = useDesk((s) => s.weekly);
  const setBrief = useDesk((s) => s.setBrief);
  const setWeekly = useDesk((s) => s.setWeekly);
  const setOpen = useDesk((s) => s.setOpenSymbol);
  const [busy, setBusy] = useState<"daily" | "weekly" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const totals = portfolioTotals(holdings);

  const labels = {
    replacements: t.replacements,
    calendar: t.calendar,
    risks: t.risks,
    watchTonight: t.watchTonight,
  };

  async function run(kind: "daily" | "weekly") {
    setBusy(kind);
    setErr(null);
    const res = await fetchBrief({ kind, lang, thesis, holdings });
    setBusy(null);
    if ("error" in res) {
      setErr(res.error);
      return;
    }
    if (kind === "daily") setBrief(res);
    else setWeekly(res);
  }

  return (
    <div className="space-y-8">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={t.value} value={formatUsd(totals.value)} />
        <Stat
          label={t.day}
          value={formatUsd(totals.day)}
          tone={totals.day >= 0 ? "up" : "down"}
          sub={formatPct(totals.value ? (totals.day / totals.value) * 100 : 0)}
        />
        <Stat
          label={t.nightPnl}
          value={formatUsd(totals.ah)}
          tone={totals.ah >= 0 ? "up" : "down"}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => run("daily")} disabled={busy !== null}>
          {busy === "daily" ? t.running : t.runBrief}
        </Button>
        <Button variant="secondary" onClick={() => run("weekly")} disabled={busy !== null}>
          {busy === "weekly" ? t.running : t.runWeekly}
        </Button>
      </div>
      {err && <p className="text-sm text-down">{err}</p>}

      {busy && (
        <div className="h-24 rounded-xl shimmer" aria-hidden="true" />
      )}

      {brief ? (
        <BriefCard brief={brief} onOpen={setOpen} labels={labels} />
      ) : (
        !busy && <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">{t.briefEmpty}</p>
      )}

      {weekly && (
        <section className="border-t border-border pt-8">
          <h3 className="mb-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.runWeekly}</h3>
          <BriefCard brief={weekly} onOpen={setOpen} labels={labels} />
        </section>
      )}

      <section>
        <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.navHoldings}</h3>
        <ul className="grid gap-2 sm:grid-cols-2">
          {holdings.map((h) => {
            const s = getStock(h.symbol);
            if (!s) return null;
            const hv = holdingValue(h);
            return (
              <li key={h.symbol}>
                <button
                  type="button"
                  onClick={() => setOpen(h.symbol)}
                  className="flex w-full items-center justify-between rounded-xl bg-card px-4 py-3 text-start hover:bg-muted/40"
                >
                  <span>
                    <span className="font-mono text-sm font-medium">{h.symbol}</span>
                    <span className="ms-2 text-xs text-muted-foreground">{formatSharesLine(displayedShares(h))}</span>
                  </span>
                  <span className="text-end">
                    <span className="tabular block text-sm">{formatUsd(hv.value)}</span>
                    <span className={`tabular text-xs ${hv.pnl >= 0 ? "text-up" : "text-down"}`}>
                      {formatPct(hv.pnlPct)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function formatSharesLine(n: number) {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })} sh`;
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "up" | "down";
}) {
  return (
    <div className="rounded-xl bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`tabular mt-1 text-xl font-medium ${tone === "up" ? "text-up" : tone === "down" ? "text-down" : ""}`}>
        {value}
      </p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
