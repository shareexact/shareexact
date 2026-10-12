import { runAssetAnalysis, runDeskBrief, runThesisBasket } from "./ai";
import { isRtl, type Lang } from "./copy";
import { buildLocalAsset, buildLocalBrief, buildLocalThesis } from "./desk-engine";
import { getMarketSession } from "./session";
import { displayedShares, getStock, portfolioTotals, positionDollars, type Holding } from "./stocks";
import type { AssetAnalysis, BriefResult, Stance, ThesisBasket } from "./store";

function stanceOf(v: unknown): Stance {
  return v === "trim" || v === "add" || v === "replace" || v === "hold" ? v : "hold";
}

function str(v: unknown, fallback = "") {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback = 0) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function parsePayload(res: { ok: true; json: string } | { ok: false; error: string }): Record<string, unknown> {
  if (!res.ok) return { error: res.error };
  try {
    return JSON.parse(res.json) as Record<string, unknown>;
  } catch {
    return { error: "Could not parse model output" };
  }
}

export function bookPayload(holdings: Holding[]) {
  return holdings
    .map((h) => {
      const s = getStock(h.symbol);
      if (!s) return null;
      return {
        symbol: h.symbol,
        shares: displayedShares(h),
        cost: h.cost,
        price: s.price,
        change1d: s.change1d,
        afterHours: s.afterHours,
        multiplier: s.multiplier,
        sector: s.sector,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null);
}

export function sessionPayload() {
  const s = getMarketSession();
  return {
    kind: s.kind,
    label: s.label,
    nyTime: s.nyTime,
    nyDate: s.nyDate,
    detail: s.detail,
  };
}

export async function fetchBrief(opts: {
  kind: "daily" | "weekly";
  lang: Lang;
  thesis: string;
  holdings: Holding[];
}): Promise<BriefResult | { error: string }> {
  try {
    const raw = await runDeskBrief({
      data: {
        kind: opts.kind,
        lang: opts.lang,
        thesis: opts.thesis,
        session: sessionPayload(),
        holdings: bookPayload(opts.holdings),
      },
    });
    const parsed = parsePayload(raw);
    if (typeof parsed.error === "string" && parsed.headline == null) {
      return buildLocalBrief({ ...opts, session: sessionPayload() });
    }

    const holdings = Array.isArray(parsed.holdings)
      ? parsed.holdings.map((row) => {
          const r = row as Record<string, unknown>;
          return {
            symbol: str(r.symbol),
            stance: stanceOf(r.stance),
            note: str(r.note),
            replaceWith: r.replaceWith ? str(r.replaceWith) : undefined,
          };
        })
      : [];

    return {
      kind: opts.kind,
      generatedAt: new Date().toISOString(),
      headline: str(parsed.headline, "Desk note"),
      sessionNote: str(parsed.sessionNote),
      oneLiner: str(parsed.oneLiner),
      bias:
        parsed.bias === "constructive" || parsed.bias === "cautious" || parsed.bias === "mixed"
          ? parsed.bias
          : "mixed",
      holdings,
      risks: Array.isArray(parsed.risks) ? parsed.risks.map((x) => str(x)) : [],
      watchTonight: str(parsed.watchTonight),
      replacements: Array.isArray(parsed.replacements)
        ? parsed.replacements.map((row) => {
            const r = row as Record<string, unknown>;
            return { from: str(r.from), to: str(r.to), why: str(r.why) };
          })
        : undefined,
      calendar: Array.isArray(parsed.calendar)
        ? parsed.calendar.map((row) => {
            const r = row as Record<string, unknown>;
            return { when: str(r.when), event: str(r.event), symbols: str(r.symbols) };
          })
        : undefined,
    };
  } catch {
    return buildLocalBrief({ ...opts, session: sessionPayload() });
  }
}

export async function fetchAsset(opts: {
  lang: Lang;
  thesis: string;
  symbol: string;
  holdings: Holding[];
}): Promise<AssetAnalysis | { error: string }> {
  const s = getStock(opts.symbol);
  const h = opts.holdings.find((x) => x.symbol === opts.symbol);
  if (!s) return { error: "Unknown symbol" };
  const totals = portfolioTotals(opts.holdings);
  const shares = h ? displayedShares(h) : 0;
  const value = h ? positionDollars(h) : 0;
  try {
    const raw = await runAssetAnalysis({
      data: {
        lang: opts.lang,
        thesis: opts.thesis,
        session: sessionPayload(),
        symbol: s.symbol,
        name: s.name,
        sector: s.sector,
        about: isRtl(opts.lang) ? s.aboutFa : s.about,
        price: s.price,
        change1d: s.change1d,
        afterHours: s.afterHours,
        multiplier: s.multiplier,
        shares,
        cost: h?.cost ?? s.price,
        bookWeight: totals.value > 0 ? (value / totals.value) * 100 : 0,
      },
    });
    const parsed = parsePayload(raw);
    if (typeof parsed.error === "string" && parsed.summary == null) {
      return buildLocalAsset({ ...opts, session: sessionPayload() });
    }

    const angles = Array.isArray(parsed.angles)
      ? parsed.angles.map((row) => {
          const r = row as Record<string, unknown>;
          return { title: str(r.title), body: str(r.body) };
        })
      : [];

    const rw = parsed.replaceWith as Record<string, unknown> | null;
    return {
      symbol: opts.symbol,
      generatedAt: new Date().toISOString(),
      stance: stanceOf(parsed.stance),
      summary: str(parsed.summary),
      angles: angles.slice(0, 5),
      replaceWith: rw && typeof rw === "object" ? { symbol: str(rw.symbol), why: str(rw.why) } : null,
      afterHours: str(parsed.afterHours),
    };
  } catch {
    return buildLocalAsset({ ...opts, session: sessionPayload() });
  }
}

export async function fetchThesis(opts: {
  lang: Lang;
  thesis: string;
  available: string[];
}): Promise<ThesisBasket | { error: string }> {
  try {
    const raw = await runThesisBasket({
      data: {
        lang: opts.lang,
        thesis: opts.thesis,
        session: sessionPayload(),
        available: opts.available,
      },
    });
    const parsed = parsePayload(raw);
    if (typeof parsed.error === "string" && parsed.basket == null) {
      return buildLocalThesis(opts);
    }

    const basket = Array.isArray(parsed.basket)
      ? parsed.basket.map((row) => {
          const r = row as Record<string, unknown>;
          return {
            symbol: str(r.symbol),
            weight: num(r.weight),
            role: str(r.role),
            reason: str(r.reason),
          };
        })
      : [];

    return {
      thesis: opts.thesis,
      restated: str(parsed.restated, opts.thesis),
      generatedAt: new Date().toISOString(),
      basket,
      afterHoursNote: str(parsed.afterHoursNote),
      risks: Array.isArray(parsed.risks) ? parsed.risks.map((x) => str(x)) : [],
    };
  } catch {
    return buildLocalThesis(opts);
  }
}
