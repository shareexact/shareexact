import { displayedShares, getStock, type Holding } from "./stocks";
import type { AssetAnalysis, BriefResult, Stance, ThesisBasket } from "./store";
import type { Lang } from "./copy";

interface SessionBits {
  kind: string;
  label: string;
  nyTime: string;
  nyDate: string;
  detail: string;
}

function linesOf(holdings: Holding[]) {
  return holdings
    .map((h) => {
      const s = getStock(h.symbol);
      if (!s || s.price <= 0) return null;
      const shares = displayedShares(h);
      const value = shares * s.price;
      const pnlPct = h.cost > 0 ? ((s.price - h.cost) / h.cost) * 100 : 0;
      return { h, s, value, pnlPct, ah: s.afterHours, w: 0 };
    })
    .filter((x): x is NonNullable<typeof x> => x != null);
}

function withWeights(rows: ReturnType<typeof linesOf>) {
  const total = rows.reduce((a, r) => a + r.value, 0);
  return rows
    .map((r) => ({ ...r, w: total > 0 ? (r.value / total) * 100 : 0 }))
    .sort((a, b) => b.w - a.w);
}

function stanceFor(row: ReturnType<typeof withWeights>[number], thesis: string): Stance {
  const t = thesis.toLowerCase();
  if (Number(row.s.multiplier) >= 2) return "hold";
  if (row.w >= 40) return "trim";
  if (row.s.symbol === "NVDA" && t.includes("not") && t.includes("nvda")) return "trim";
  if (row.ah <= -0.8 && row.w >= 15) return "trim";
  if ((row.s.symbol === "AVGO" || row.s.symbol === "MSFT") && /ai|infra/i.test(thesis)) return "add";
  if (row.s.symbol === "TSLA" && row.ah < -0.4) return "hold";
  return "hold";
}

export function buildLocalBrief(opts: {
  kind: "daily" | "weekly";
  lang: Lang;
  thesis: string;
  session: SessionBits;
  holdings: Holding[];
}): BriefResult {
  void opts.lang;
  const rows = withWeights(linesOf(opts.holdings));
  const top = rows[0];
  const night = opts.session.kind === "weekend" || opts.session.kind === "after";
  const crwd = rows.find((r) => r.s.symbol === "CRWD");
  const concentrated = Boolean(top && top.w >= 35);
  const bias = concentrated || (night && rows.some((r) => Math.abs(r.ah) > 0.6)) ? "cautious" : "mixed";
  const loud = rows.slice().sort((a, b) => Math.abs(b.ah) - Math.abs(a.ah))[0];

  const holdings = rows.map((r) => {
    const stance = stanceFor(r, opts.thesis);
    const replaceWith =
      stance === "trim" && r.s.symbol === "NVDA" ? "AVGO" : stance === "replace" ? "SPY" : undefined;
    const note =
      r.s.symbol === "CRWD"
        ? `Live UI multiplier ${Number(r.s.multiplier).toFixed(0)}×. Sending the screen number as raw moves ${Number(r.s.multiplier).toFixed(0)}× units.`
        : `${r.w.toFixed(1)}% of the book. Session ${r.s.change1d >= 0 ? "+" : ""}${r.s.change1d.toFixed(2)}%, after-hours ${r.s.afterHours >= 0 ? "+" : ""}${r.s.afterHours.toFixed(2)}%.`;
    return { symbol: r.s.symbol, stance, note, replaceWith };
  });

  return {
    kind: opts.kind,
    generatedAt: new Date().toISOString(),
    headline: night
      ? "Night desk: the book is awake, the oracle is not."
      : concentrated && top
        ? `One name is ${top.w.toFixed(0)}% of the book.`
        : "Today’s brief — every line has a job.",
    sessionNote: `${opts.session.label} · ${opts.session.nyTime} ET`,
    oneLiner: opts.thesis
      ? `Thesis is on the desk. ${rows.length} names on chain 4663.`
      : "No thesis on file — the desk is reading structure and session only.",
    bias,
    holdings,
    risks: [
      night
        ? "Cash session is dark. Chainlink prints go stale until Sunday night / Monday open."
        : "After-hours gaps can move the mark without moving the UI multiplier.",
      ...(crwd ? ["CRWD multiplier trap: a naive wallet sends the displayed count as raw."] : []),
      ...(concentrated && top ? [`Concentration: ${top.s.symbol} is ${top.w.toFixed(0)}% of the book.`] : []),
    ],
    watchTonight: loud
      ? `${loud.s.symbol} is the loudest after-hours print in this book.`
      : "Watch the after-hours tape for weekend-gap risk.",
    replacements:
      concentrated && top
        ? [
            {
              from: top.s.symbol,
              to: top.s.symbol === "NVDA" ? "AVGO" : "SPY",
              why: `${top.s.symbol} is ${top.w.toFixed(0)}% of the book. Spread the weight onto a 4663 complement.`,
            },
          ]
        : undefined,
    calendar:
      opts.kind === "weekly"
        ? [
            {
              when: opts.session.nyDate,
              event: "Multiplier / corporate-action window",
              symbols: rows.map((r) => r.s.symbol).join(" "),
            },
          ]
        : undefined,
  };
}

export function buildLocalAsset(opts: {
  lang: Lang;
  thesis: string;
  session: SessionBits;
  symbol: string;
  holdings: Holding[];
}): AssetAnalysis {
  void opts.lang;
  void opts.thesis;
  const s = getStock(opts.symbol);
  const h = opts.holdings.find((x) => x.symbol === opts.symbol);
  const rows = withWeights(linesOf(opts.holdings));
  const row = rows.find((r) => r.s.symbol === opts.symbol);
  const w = row?.w ?? 0;
  const mult = Number(s?.multiplier ?? 1);
  const stance: Stance = mult >= 2 ? "hold" : w >= 40 ? "trim" : (s?.afterHours ?? 0) > 0.5 ? "add" : "hold";

  return {
    symbol: opts.symbol,
    generatedAt: new Date().toISOString(),
    stance,
    summary: `${opts.symbol} is ${w.toFixed(1)}% of the book. Session ${s?.change1d.toFixed(2)}%, after-hours ${s?.afterHours.toFixed(2)}%, UI multiplier ${mult.toFixed(6)}×.`,
    angles: [
      {
        title: "Cash vs night",
        body: `${opts.session.label}. The token still trades on 4663 when NYSE is dark.`,
      },
      {
        title: "Book weight",
        body: h ? `${displayedShares(h)} UI shares — ${w.toFixed(1)}% of value.` : "Not currently in this book.",
      },
      {
        title: "ERC-8056 multiplier",
        body:
          mult >= 2
            ? `Live trap: sending “1” as raw moves ${mult.toFixed(0)} shares. Use Exact send.`
            : `Multiplier is near 1× (${mult.toFixed(6)}). Still convert; never round.`,
      },
    ],
    replaceWith:
      stance === "trim" && opts.symbol === "NVDA"
        ? { symbol: "AVGO", why: "ASIC complement without a single-name NVDA bet." }
        : null,
    afterHours: `After-hours ${s?.afterHours.toFixed(2)}%. ${opts.session.detail}`,
  };
}

export function buildLocalThesis(opts: { lang: Lang; thesis: string; available: string[] }): ThesisBasket {
  void opts.lang;
  const t = opts.thesis.toLowerCase();
  const pick = (symbol: string, weight: number, role: string, reason: string) =>
    opts.available.includes(symbol) ? { symbol, weight, role, reason } : null;

  const ai = /ai|nvidia|infra|semi|chip/.test(t);
  const night = /after.?hours|24\/7|weekend|night/.test(t);
  const basket = (
    ai
      ? [
          pick("AVGO", 28, "core", "Custom ASICs; the NVDA complement."),
          pick("MSFT", 24, "distribution", "Azure + OpenAI channel."),
          pick("GOOGL", 18, "cash engine", "Search pays for the model."),
          pick("NVDA", 18, "beta", "Sized under a single-name bet."),
          pick("SPY", 12, "ballast", "US-tape beta."),
        ]
      : night
        ? [
            pick("TSLA", 22, "night tape", "After-hours volume is the story."),
            pick("QQQ", 22, "nasdaq", "Dark-session beta."),
            pick("NVDA", 20, "gap", "Weekend headline risk."),
            pick("CRWD", 16, "multiplier", "4× — Exact send only."),
            pick("SPY", 20, "base", "Baseline, not a thesis."),
          ]
        : [
            pick("MSFT", 26, "core", "Quiet compounder."),
            pick("AAPL", 22, "ballast", "Services and buybacks."),
            pick("AMZN", 18, "leverage", "AWS plus retail."),
            pick("SPY", 20, "index", "Market beta."),
            pick("GOOGL", 14, "cash", "Ads engine."),
          ]
  ).filter((x): x is NonNullable<typeof x> => x != null);

  const sum = basket.reduce((a, b) => a + b.weight, 0) || 1;
  const normalized = basket.map((b) => ({ ...b, weight: Math.round((b.weight / sum) * 100) }));
  const drift = 100 - normalized.reduce((a, b) => a + b.weight, 0);
  if (normalized[0]) normalized[0].weight += drift;

  return {
    thesis: opts.thesis,
    restated: "Mapped onto ACTIVE Stock Tokens on chain 4663.",
    generatedAt: new Date().toISOString(),
    basket: normalized,
    afterHoursNote: "When NYSE is dark this book still marks on 4663. Move size only through Exact send.",
    risks: ["Weekend oracle staleness.", "Multiplier trap on any name where uiMultiplier ≠ 1."],
  };
}
