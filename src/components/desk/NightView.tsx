import { COPY, isRtl } from "@/lib/copy";
import { getMarketSession } from "@/lib/session";
import { STOCKS } from "@/lib/stocks";
import { useDesk } from "@/lib/store";
import { formatPct, formatUsd } from "@/lib/utils";
import { Spark } from "./Spark";
import { Badge } from "@/components/ui/badge";

export function NightView() {
  const lang = useDesk((s) => s.lang);
  const t = COPY[lang];
  const setOpen = useDesk((s) => s.setOpenSymbol);
  const session = getMarketSession();
  const ranked = [...STOCKS].sort(
    (a, b) => Math.abs(b.afterHours) - Math.abs(a.afterHours),
  );

  return (
    <div className="space-y-6">
      <div className="rounded-xl bg-card p-5">
        <Badge tone={session.isNightDesk ? "night" : "open"}>{session.kind}</Badge>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight">
          {session.nyTime} <span className="text-lg font-normal text-muted-foreground">ET</span>
        </h2>
        <p className="text-sm text-muted-foreground">{session.nyDate}</p>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed">
          {isRtl(lang) ? session.detailFa : session.detail}
        </p>
      </div>

      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{t.nightIntro}</p>

      <section className="rounded-xl border border-border p-4">
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Why the night desk exists
        </h3>
        <ul className="space-y-2 text-sm leading-relaxed text-muted-foreground">
          <li>Stock Tokens trade 24/7 on Uniswap / Arcus. The cash print does not.</li>
          <li>Chainlink equity feeds are 24/5. A Sunday NAV that liquidates you is a bug, not a price.</li>
          <li>CRWD still carries a 4× UI multiplier overnight. Exact send does not sleep either.</li>
        </ul>
      </section>

      <section>
        <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          After-hours movers
        </h3>
        <ul className="space-y-2">
          {ranked.map((s) => (
            <li key={s.symbol}>
              <button
                type="button"
                onClick={() => setOpen(s.symbol)}
                className="flex w-full items-center gap-3 rounded-xl bg-card px-4 py-3 text-start hover:bg-muted/40"
              >
                <span className="w-16 font-mono font-medium">{s.symbol}</span>
                <span className="hidden flex-1 text-xs text-muted-foreground sm:block">{s.name}</span>
                <Spark change={s.change1d} afterHours={s.afterHours} />
                <span className="w-20 text-end">
                  <span className="tabular block text-sm">{formatUsd(s.price)}</span>
                  <span className={`tabular text-xs ${s.afterHours >= 0 ? "text-up" : "text-down"}`}>
                    AH {formatPct(s.afterHours)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
