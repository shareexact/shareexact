import type { DataState } from "./market-state";
import { fallbackRawToUi, formatFixedToDecimalString, parseMultiplier } from "./conversion.ts";

export type SessionKind = "open" | "pre" | "after" | "weekend";

/**
 * Where a price on screen came from.
 *
 *   oracle     — read from a Chainlink feed on chain 4663 this session.
 *   indicative — a demo mark shipped with the build. Never presented as live.
 *   none       — no feed and no mark. The UI shows a dash, not a number.
 *
 * This field exists because the previous build had no way to tell the two
 * apart, and a risk engine that cannot distinguish a live price from a
 * placeholder is a risk engine that lies with a straight face.
 */
export type PriceSource = "oracle" | "indicative" | "none";

export interface Stock {
  symbol: string;
  name: string;
  sector: string;
  contract: string;
  multiplier: string;
  /**
   * Cash mark per share. An oracle reading is the price of one raw token, so
   * `mergeOracleMarks` divides it by `uiMultiplier` before storing it here.
   * Dollars are `raw × rawTokenPrice`, which equals `shares × price`.
   */
  price: number;
  /** Chainlink price of one raw token, before the share conversion. */
  rawTokenPrice?: number | null;
  change1d: number;
  afterHours: number;
  about: string;
  aboutFa: string;
  color: string;
  priceSource?: PriceSource;
  priceUpdatedAt?: number | null;
  priceAgeSeconds?: number | null;
  dataState?: DataState;
  pendingMultiplier?: string | null;
  effectiveAt?: number | null;
  /**
   * False when the token's `uiMultiplier()` could not be read this session. The
   * registry value stays on screen for reference, but nothing may be quoted or
   * sent in shares against it.
   */
  unitAvailable?: boolean;
}

/** Indicative cash-session marks for the desk demo. Multipliers match live RHJ reads where known. */
export const STOCKS: Stock[] = [
  {
    symbol: "NVDA",
    name: "NVIDIA",
    sector: "Semiconductors",
    contract: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    multiplier: "1.000775159164630595",
    price: 178.4,
    change1d: 1.42,
    afterHours: 0.38,
    about: "AI accelerators. Highest-beta name in a typical infrastructure thesis.",
    aboutFa: "شتاب‌دهنده هوش مصنوعی. پرریسک‌ترین نام در تز زیرساخت.",
    color: "#76b900",
  },
  {
    symbol: "AAPL",
    name: "Apple",
    sector: "Consumer",
    contract: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
    multiplier: "1.000566080061092436",
    price: 228.15,
    change1d: -0.31,
    afterHours: -0.08,
    about: "Services mix and buybacks. The ballast in most US-equity baskets.",
    aboutFa: "خدمات و بازخرید سهام. وزنه تعادل اکثر سبدهای سهام آمریکا.",
    color: "#a2aaad",
  },
  {
    symbol: "MSFT",
    name: "Microsoft",
    sector: "Software",
    contract: "0xe93237C50D904957Cf27E7B1133b510C669c2e74",
    multiplier: "1.000410000000000000",
    price: 432.6,
    change1d: 0.54,
    afterHours: 0.12,
    about: "Azure + OpenAI distribution. The compounding core of an AI basket.",
    aboutFa: "Azure و توزیع OpenAI. هسته مرکب سبد هوش مصنوعی.",
    color: "#00a4ef",
  },
  {
    symbol: "GOOGL",
    name: "Alphabet",
    sector: "Internet",
    contract: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3",
    multiplier: "1.000290000000000000",
    price: 191.2,
    change1d: 0.88,
    afterHours: 0.21,
    about: "Search cash engine funding Gemini and YouTube. Cheaper AI call than NVDA.",
    aboutFa: "موتور نقدی جستجو برای Gemini و یوتیوب. کال ارزان‌تر هوش مصنوعی نسبت به NVDA.",
    color: "#fbbc04",
  },
  {
    symbol: "TSLA",
    name: "Tesla",
    sector: "Auto / Energy",
    contract: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
    multiplier: "1.000180000000000000",
    price: 241.75,
    change1d: -1.86,
    afterHours: -0.54,
    about: "Robotaxi narrative, weekend-gap risk. After-hours volume is the story.",
    aboutFa: "روایت روباتاکسی و ریسک گپ آخر هفته. حجم after-hours خود داستان است.",
    color: "#cc0000",
  },
  {
    symbol: "AMZN",
    name: "Amazon",
    sector: "Internet",
    contract: "0x12f190a9F9d7D37a250758b26824B97CE941bF54",
    multiplier: "1.000220000000000000",
    price: 228.9,
    change1d: 0.41,
    afterHours: 0.09,
    about: "AWS + retail operating leverage. Quiet compounder in most theses.",
    aboutFa: "AWS و اهرم عملیاتی خرده‌فروشی. مرکب‌کننده آرام در اکثر تزها.",
    color: "#ff9900",
  },
  {
    symbol: "META",
    name: "Meta",
    sector: "Internet",
    contract: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35",
    multiplier: "1.000150000000000000",
    price: 582.3,
    change1d: 1.05,
    afterHours: 0.27,
    about: "Ads recovery plus Llama. High free-cash-flow AI proxy.",
    aboutFa: "بازیابی تبلیغات به‌علاوه Llama. نماینده هوش مصنوعی با جریان نقدی بالا.",
    color: "#0668e1",
  },
  {
    symbol: "AVGO",
    name: "Broadcom",
    sector: "Semiconductors",
    contract: "0x156E175DD063a8cE274C50654eF40e0032b3fbcF",
    multiplier: "1.000090000000000000",
    price: 334.1,
    change1d: 2.14,
    afterHours: 0.61,
    about: "Custom AI ASICs for hyperscalers. The quieter NVDA complement.",
    aboutFa: "ASIC سفارشی هوش مصنوعی برای هایپراسکیلرها. مکمل آرام‌تر NVDA.",
    color: "#e31937",
  },
  {
    symbol: "CRWD",
    name: "CrowdStrike",
    sector: "Cyber",
    contract: "0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931",
    multiplier: "4.000000000000000000",
    price: 412.8,
    change1d: -0.62,
    afterHours: -0.14,
    about: "4× UI multiplier. Sending a displayed “1” as raw units moves 4 shares.",
    aboutFa: "ضریب نمایشی ۴×. ارسال «۱» به‌صورت raw یعنی ۴ سهم.",
    color: "#e01e24",
  },
  {
    symbol: "SPY",
    name: "SPDR S&P 500",
    sector: "Index",
    contract: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
    multiplier: "1.000000000000000000",
    price: 661.4,
    change1d: 0.22,
    afterHours: 0.05,
    about: "Beta of the US tape. Use as the after-hours baseline, not a thesis.",
    aboutFa: "بتای نوار آمریکا. مبنای after-hours است، نه یک تز.",
    color: "#2a5ada",
  },
  {
    symbol: "QQQ",
    name: "Invesco QQQ",
    sector: "Index",
    contract: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68",
    multiplier: "1.000000000000000000",
    price: 598.2,
    change1d: 0.67,
    afterHours: 0.18,
    about: "Nasdaq-100. The after-hours tape is usually this, just louder.",
    aboutFa: "نزدک ۱۰۰. نوار after-hours معمولاً همین است، فقط بلندتر.",
    color: "#6b2d8b",
  },
  {
    symbol: "PLTR",
    name: "Palantir",
    sector: "Software",
    contract: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A",
    multiplier: "1.000050000000000000",
    price: 168.9,
    change1d: 2.88,
    afterHours: 0.92,
    about: "Gov + AIP. Weekend narrative stock — gaps on headlines, not prints.",
    aboutFa: "دولت و AIP. سهام روایی آخر هفته — گپ از تیتر، نه از صورت‌های مالی.",
    color: "#000000",
  },
];

export const STOCK_BY_SYMBOL = Object.fromEntries(STOCKS.map((s) => [s.symbol, s]));

const live = new Map<string, Stock>();

/** Indicative marks for names the live registry returns that are not in the demo tape. */
const FALLBACK_MARKS: Record<string, { price: number; change1d?: number; afterHours?: number }> = {
  SLV: { price: 31.4, change1d: 0.4, afterHours: 0.05 },
  INTC: { price: 24.85, change1d: -0.6, afterHours: -0.12 },
  AMD: { price: 158.2, change1d: 1.1, afterHours: 0.22 },
  NFLX: { price: 712.4, change1d: 0.5, afterHours: 0.08 },
  DIS: { price: 112.3, change1d: -0.2, afterHours: 0.04 },
  KO: { price: 68.9, change1d: 0.1, afterHours: 0.02 },
  JPM: { price: 248.1, change1d: 0.3, afterHours: 0.05 },
  BAC: { price: 41.2, change1d: 0.2, afterHours: 0.03 },
  XOM: { price: 118.6, change1d: -0.4, afterHours: -0.06 },
  WMT: { price: 102.4, change1d: 0.2, afterHours: 0.01 },
  COST: { price: 918.0, change1d: 0.3, afterHours: 0.04 },
  UNH: { price: 542.0, change1d: -0.5, afterHours: -0.08 },
  JNJ: { price: 164.2, change1d: 0.1, afterHours: 0.01 },
  V: { price: 312.5, change1d: 0.4, afterHours: 0.06 },
  MA: { price: 498.0, change1d: 0.3, afterHours: 0.05 },
  HD: { price: 392.0, change1d: -0.2, afterHours: -0.03 },
  PFE: { price: 26.4, change1d: 0.2, afterHours: 0.02 },
  BA: { price: 186.0, change1d: -0.8, afterHours: -0.14 },
  NKE: { price: 78.5, change1d: 0.3, afterHours: 0.04 },
  GOLD: { price: 18.9, change1d: 0.6, afterHours: 0.1 },
  IBIT: { price: 52.4, change1d: 1.2, afterHours: 0.3 },
  MSTR: { price: 328.0, change1d: 1.8, afterHours: 0.4 },
  COIN: { price: 248.0, change1d: 1.4, afterHours: 0.28 },
  HOOD: { price: 24.6, change1d: 0.9, afterHours: 0.15 },
};

export function isPriced(symbol: string) {
  const s = getStock(symbol);
  return Boolean(s && s.price > 0);
}

export function isDustBook(holdings: Holding[]) {
  return portfolioTotals(holdings).value < 80;
}

export function mergeLiveAssets(
  assets: { symbol: string; name: string; contract: string; multiplier: string }[],
) {
  for (const a of assets) {
    const prev = live.get(a.symbol) ?? STOCK_BY_SYMBOL[a.symbol];
    live.set(a.symbol, {
      symbol: a.symbol,
      name: a.name.replace(/\s*•.*$/, ""),
      sector: prev?.sector ?? "Stock Token",
      contract: a.contract,
      multiplier: a.multiplier || prev?.multiplier || "1.000000000000000000",
      price: prev?.price || FALLBACK_MARKS[a.symbol]?.price || 0,
      change1d: prev?.change1d ?? FALLBACK_MARKS[a.symbol]?.change1d ?? 0,
      afterHours: prev?.afterHours ?? FALLBACK_MARKS[a.symbol]?.afterHours ?? 0,
      about: prev?.about ?? `Robinhood Stock Token (${a.symbol}) on chain 4663.`,
      aboutFa: prev?.aboutFa ?? `توکن سهام رابین‌هود (${a.symbol}) روی زنجیره ۴۶۶۳.`,
      color: prev?.color ?? "#8b9088",
    });
  }
}

/**
 * Overlay live oracle readings on top of the registry.
 *
 * Only fields the chain actually answered are overwritten. A missing price
 * leaves the indicative mark in place and flags it as such rather than zeroing
 * the book, so the desk stays usable before feeds are configured while never
 * claiming an indicative number is live.
 */
export function mergeOracleMarks(
  readings: {
    symbol: string;
    price: number | null;
    updatedAt: number | null;
    ageSeconds: number | null;
    multiplier: string | null;
    pendingMultiplier: string | null;
    effectiveAt: number | null;
    dataState: DataState;
    unitAvailable: boolean;
    contract: string;
  }[],
) {
  for (const r of readings) {
    const prev = live.get(r.symbol) ?? STOCK_BY_SYMBOL[r.symbol];
    if (!prev) continue;
    const hasOraclePrice = typeof r.price === "number" && r.price > 0;
    const multiplier = r.multiplier ?? prev.multiplier;
    const rawTokenPrice = hasOraclePrice ? (r.price as number) : (prev.rawTokenPrice ?? null);
    // The feed prices one raw token. The desk's cash mark is the share price.
    const sharePrice =
      hasOraclePrice && r.unitAvailable
        ? sharePriceFromRawToken(r.price as number, multiplier)
        : null;
    live.set(r.symbol, {
      ...prev,
      contract: r.contract || prev.contract,
      multiplier,
      unitAvailable: r.unitAvailable,
      pendingMultiplier: r.pendingMultiplier,
      effectiveAt: r.effectiveAt,
      rawTokenPrice,
      price: sharePrice != null && sharePrice > 0 ? sharePrice : prev.price,
      priceSource: hasOraclePrice && sharePrice != null && sharePrice > 0 ? "oracle" : prev.price > 0 ? prev.priceSource ?? "indicative" : "none",
      priceUpdatedAt: r.updatedAt,
      priceAgeSeconds: r.ageSeconds,
      dataState: r.dataState,
    });
  }
}

export function priceSourceOf(symbol: string): PriceSource {
  const s = getStock(symbol);
  if (!s) return "none";
  return s.priceSource ?? (s.price > 0 ? "indicative" : "none");
}

/** Symbols whose share/raw ratio could not be read this session. */
export function unitsUnavailable(symbols: string[]): string[] {
  return symbols.filter((symbol) => getStock(symbol)?.unitAvailable === false);
}

/** True when every priced position on screen is backed by a live feed reading. */
export function bookIsOracleBacked(holdings: { symbol: string }[]): boolean {
  const priced = holdings.filter((h) => (getStock(h.symbol)?.price ?? 0) > 0);
  if (priced.length === 0) return false;
  return priced.every((h) => priceSourceOf(h.symbol) === "oracle");
}

export interface Holding {
  symbol: string;
  /** Share equivalents. Scanned books also carry `raw`; screens should display `displayedShares`. */
  shares: number;
  cost: number;
  /** Raw ERC-20 balance as an integer string. Set by the wallet scan. */
  raw?: string;
}

export const DEMO_HOLDINGS: Holding[] = [
  { symbol: "NVDA", shares: 62, cost: 162.4 },
  { symbol: "AAPL", shares: 70, cost: 219.1 },
  { symbol: "MSFT", shares: 20, cost: 418.0 },
  { symbol: "TSLA", shares: 16, cost: 255.2 },
  { symbol: "CRWD", shares: 8, cost: 390.0 },
  { symbol: "AVGO", shares: 16, cost: 310.0 },
  { symbol: "SPY", shares: 16, cost: 640.0 },
];

export function getStock(symbol: string) {
  return live.get(symbol) ?? STOCK_BY_SYMBOL[symbol];
}

/** Drop an oracle overlay so tests, and a failed refresh, fall back to the shipped mark. */
export function clearOracleOverlay(symbol: string) {
  live.delete(symbol);
}

/** Share price = raw-token price × 1e18 / uiMultiplier. Both prices are dollars. */
export function sharePriceFromRawToken(rawTokenPrice: number, multiplier: string): number {
  if (!Number.isFinite(rawTokenPrice) || rawTokenPrice <= 0) return 0;
  const m = parseMultiplier(multiplier);
  if (m <= 0n) return 0;
  const scaled = BigInt(Math.round(rawTokenPrice * 1e9));
  return Number((scaled * 10n ** 18n) / m) / 1e9;
}

/** Shares implied by the raw balance and the multiplier on screen right now. */
export function displayedShares(h: Holding): number {
  if (!h.raw) return h.shares;
  const s = getStock(h.symbol);
  if (!s || s.unitAvailable === false) return h.shares;
  try {
    const ui = fallbackRawToUi(BigInt(h.raw), parseMultiplier(s.multiplier));
    const shares = Number(formatFixedToDecimalString(ui));
    return Number.isFinite(shares) ? shares : h.shares;
  } catch {
    return h.shares;
  }
}

/** Position value in dollars. Raw × token price when the scan recorded a balance. */
export function positionDollars(h: Holding): number {
  const s = getStock(h.symbol);
  if (!s) return 0;
  if (h.raw && s.rawTokenPrice != null && s.rawTokenPrice > 0) {
    const scaled = BigInt(Math.round(s.rawTokenPrice * 1e9));
    return Number((BigInt(h.raw) * scaled) / 10n ** 18n) / 1e9;
  }
  return displayedShares(h) * s.price;
}

export function holdingValue(h: Holding) {
  const s = getStock(h.symbol);
  if (!s) return { value: 0, pnl: 0, pnlPct: 0, ah: 0 };
  const shares = displayedShares(h);
  const value = positionDollars(h);
  const pnl = h.cost > 0 ? shares * (s.price - h.cost) : 0;
  const pnlPct = h.cost > 0 ? ((s.price - h.cost) / h.cost) * 100 : 0;
  const ah = shares * s.price * (s.afterHours / 100);
  return { value, pnl, pnlPct, ah };
}

export function portfolioTotals(holdings: Holding[]) {
  let value = 0;
  let cost = 0;
  let ah = 0;
  for (const h of holdings) {
    const s = getStock(h.symbol);
    if (!s) continue;
    const shares = displayedShares(h);
    value += positionDollars(h);
    cost += shares * h.cost;
    ah += shares * s.price * (s.afterHours / 100);
  }
  const pnl = value - cost;
  const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
  const day = holdings.reduce((acc, h) => {
    const s = getStock(h.symbol);
    return acc + (s ? displayedShares(h) * s.price * (s.change1d / 100) : 0);
  }, 0);
  return { value, cost, pnl, pnlPct, ah, day };
}
