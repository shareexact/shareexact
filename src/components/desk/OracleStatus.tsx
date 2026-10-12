import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { COPY } from "@/lib/copy";
import { STATE_LABEL, formatAge, type DataState } from "@/lib/market-state";
import { useDesk } from "@/lib/store";

/**
 * One line that answers the question every other number on screen depends on:
 * where did these prices come from, and how old are they.
 *
 * It is deliberately always visible rather than hidden behind a tooltip. The
 * whole argument of this product is that off-hours staleness is a normal,
 * frequent state that most integrations render as if it were live.
 */
export function OracleStatus() {
  const lang = useDesk((s) => s.lang);
  const t = COPY[lang];
  const oracle = useDesk((s) => s.oracle);
  const loading = useDesk((s) => s.oracleLoading);

  const summary = useMemo(() => {
    if (!oracle) return null;
    const counts = new Map<DataState, number>();
    let oldest: number | null = null;
    let unitsUnknown = 0;
    for (const asset of oracle.assets) {
      counts.set(asset.dataState, (counts.get(asset.dataState) ?? 0) + 1);
      if (asset.ageSeconds !== null) oldest = Math.max(oldest ?? 0, asset.ageSeconds);
      if (!asset.unitAvailable) unitsUnknown += 1;
    }
    return { counts, oldest, unitsUnknown, total: oracle.assets.length };
  }, [oracle]);

  if (!oracle && !loading) return null;

  const noFeeds = oracle ? oracle.feedsConfigured === 0 : false;
  const fresh = summary?.counts.get("FRESH") ?? 0;
  const stale = summary?.counts.get("STALE") ?? 0;
  const paused = summary?.counts.get("ORACLE_PAUSED") ?? 0;
  const corp = summary?.counts.get("CORP_ACTION") ?? 0;

  return (
    <div className="mb-6 rounded-xl border border-border bg-card px-4 py-3 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-medium uppercase tracking-wide text-muted-foreground">{t.prices}</span>

        {loading && <span className="text-muted-foreground">…</span>}

        {noFeeds ? (
          <Badge tone="down">{t.indicativeMarks}</Badge>
        ) : (
          <>
            <span className="text-muted-foreground">{t.chainlinkOn}</span>
            {fresh > 0 && (
              <Badge tone="open">
                {fresh} {STATE_LABEL.FRESH.short}
              </Badge>
            )}
            {stale > 0 && (
              <Badge tone="night">
                {stale} {STATE_LABEL.STALE.short}
              </Badge>
            )}
            {paused > 0 && (
              <Badge tone="down">
                {paused} {STATE_LABEL.ORACLE_PAUSED.short}
              </Badge>
            )}
            {corp > 0 && (
              <Badge tone="down">
                {corp} {STATE_LABEL.CORP_ACTION.short}
              </Badge>
            )}
          </>
        )}

        {oracle?.sequencerConfigured && (
          <span className={oracle.sequencerOk ? "text-muted-foreground" : "text-down"}>
            {t.sequencer}: {oracle.sequencerOk ? t.sequencerUp : t.sequencerDown}
          </span>
        )}

        {summary?.unitsUnknown ? (
          <Badge tone="down">
            {summary.unitsUnknown} {t.unitUnreadable}
          </Badge>
        ) : null}

        {summary?.oldest != null && (
          <span className="font-mono text-muted-foreground">
            {t.oldestPrint} {formatAge(summary.oldest)}
          </span>
        )}
      </div>

      {summary?.unitsUnknown ? (
        <p className="mt-2 max-w-3xl leading-relaxed text-down">
          {t.unitUnknownDetail}
        </p>
      ) : null}

      {stale > 0 && !noFeeds && (
        <p className="mt-2 max-w-3xl leading-relaxed text-muted-foreground">
          {STATE_LABEL.STALE.detail}
        </p>
      )}

      {noFeeds && (
        <p className="mt-2 max-w-3xl leading-relaxed text-muted-foreground">
          Multipliers, balances and contract addresses below are read live from chain 4663. Prices are
          not: no Chainlink feed is registered yet, so the desk is showing indicative marks and labels
          them as such. Run <code className="font-mono">npm run feeds:sync</code> or set{" "}
          <code className="font-mono">ROBINHOOD_FEEDS</code> to switch prices to the oracle.
        </p>
      )}
    </div>
  );
}
