import { displayedShares, getStock, type Holding } from "./stocks";

export type RiskBand = "low" | "moderate" | "high" | "critical";
export type RiskAction = "none" | "monitor" | "reduce" | "protect";

export interface BookMark {
  price?: number;
  shareMul?: number;
  multiplier?: number;
  /** If set, trap-risk uses this instead of the display multiplier (split overlay). */
  riskMultiplier?: number;
}

export type BookMarks = Record<string, BookMark>;

export interface RiskPosition {
  symbol: string;
  value: number;
  weight: number;
  volatility: number;
  multiplier: number;
  trapMultiplier: number;
  ltvLimit: number;
  collateralValue: number;
}

export interface RiskSnapshot {
  portfolioValue: number;
  healthScore: number;
  band: RiskBand;
  concentrationRisk: number;
  multiplierRisk: number;
  volatilityRisk: number;
  leverageRisk: number;
  utilization: number;
  collateralCapacity: number;
  maxBorrow: number;
  currentBorrow: number;
  liquidationLtv: number;
  positions: RiskPosition[];
}

export interface StressResult extends RiskSnapshot {
  scenario: string;
  shockedValue: number;
  shockedHealth: number;
  drawdown: number;
  action: RiskAction;
  suggestedRepay: number;
  suggestedCollateral: number;
}

export const VOL: Record<string, number> = {
  NVDA: 0.48,
  AAPL: 0.24,
  MSFT: 0.27,
  GOOGL: 0.3,
  TSLA: 0.58,
  AMZN: 0.34,
  META: 0.39,
  AVGO: 0.46,
  CRWD: 0.55,
  SPY: 0.18,
  QQQ: 0.24,
  PLTR: 0.62,
};

export const LTV: Record<string, number> = {
  SPY: 0.55,
  QQQ: 0.5,
  AAPL: 0.45,
  MSFT: 0.45,
  GOOGL: 0.42,
  AMZN: 0.4,
  META: 0.38,
  NVDA: 0.35,
  AVGO: 0.35,
  CRWD: 0.25,
  TSLA: 0.25,
  PLTR: 0.2,
};

export const SCENARIOS = [
  {
    id: "ai",
    label: "AI selloff",
    labelFa: "فروش هوش مصنوعی",
    shocks: { NVDA: -0.22, AVGO: -0.2, MSFT: -0.12, CRWD: -0.28, PLTR: -0.3, GOOGL: -0.12, AAPL: -0.1, TSLA: -0.18, SPY: -0.08, QQQ: -0.12 },
  },
  {
    id: "riskoff",
    label: "Broad risk-off",
    labelFa: "ریسک‌آف گسترده",
    shocks: { SPY: -0.1, QQQ: -0.13, NVDA: -0.2, AAPL: -0.08, MSFT: -0.1, TSLA: -0.2, CRWD: -0.18 },
  },
  {
    id: "weekend",
    label: "Weekend gap",
    labelFa: "گپ آخر هفته",
    shocks: { TSLA: -0.24, PLTR: -0.3, CRWD: -0.16, NVDA: -0.11 },
  },
] as const;

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

export function band(score: number): RiskBand {
  if (score >= 80) return "low";
  if (score >= 65) return "moderate";
  if (score >= 45) return "high";
  return "critical";
}

function markFor(symbol: string, marks?: BookMarks) {
  return marks?.[symbol];
}

function positionValue(h: Holding, shocks: Record<string, number>, marks?: BookMarks) {
  const stock = getStock(h.symbol);
  if (!stock) return 0;
  const m = markFor(h.symbol, marks);
  const shares = displayedShares(h) * (m?.shareMul ?? 1);
  const price = (m?.price ?? stock.price) * (1 + (shocks[h.symbol] ?? 0));
  return shares * price;
}

export function aaplSplitMarks(): BookMarks {
  const aapl = getStock("AAPL");
  if (!aapl) return {};
  const live = Number(aapl.multiplier);
  return {
    AAPL: {
      shareMul: 4,
      price: aapl.price / 4,
      multiplier: live * 4,
      riskMultiplier: live,
    },
  };
}

export function buildRiskSnapshot(
  holdings: Holding[],
  currentBorrow = 0,
  marks?: BookMarks,
  shocks: Record<string, number> = {},
): RiskSnapshot {
  const liquidationLtv = 0.65;
  const positions: RiskPosition[] = [];
  let portfolioValue = 0;
  for (const h of holdings) {
    const stock = getStock(h.symbol);
    if (!stock || stock.price <= 0) continue;
    const value = positionValue(h, shocks, marks);
    portfolioValue += value;
    const m = markFor(h.symbol, marks);
    const displayMult = m?.multiplier ?? Number(stock.multiplier);
    const trapMult = m?.riskMultiplier ?? displayMult;
    positions.push({
      symbol: h.symbol,
      value,
      weight: 0,
      volatility: VOL[h.symbol] ?? 0.4,
      multiplier: displayMult,
      trapMultiplier: trapMult,
      ltvLimit: LTV[h.symbol] ?? 0.3,
      collateralValue: 0,
    });
  }

  for (const p of positions) {
    p.weight = portfolioValue > 0 ? p.value / portfolioValue : 0;
    p.collateralValue = p.value * p.ltvLimit;
  }

  if (portfolioValue <= 0) {
    return {
      portfolioValue: 0,
      healthScore: 100,
      band: "low",
      concentrationRisk: 0,
      multiplierRisk: 0,
      volatilityRisk: 0,
      leverageRisk: 0,
      utilization: 0,
      collateralCapacity: 0,
      maxBorrow: 0,
      currentBorrow,
      liquidationLtv,
      positions: [],
    };
  }

  const concentration = positions.reduce((sum, p) => sum + Math.max(0, p.weight - 0.25) ** 2, 0);
  const concentrationRisk = clamp(Math.sqrt(concentration) * 220, 0, 100);
  const multiplierRisk = clamp(
    positions.reduce((sum, p) => sum + p.weight * Math.min(1, Math.abs(p.trapMultiplier - 1)), 0) * 500,
    0,
    100,
  );
  const volatilityRisk = clamp(
    positions.reduce((sum, p) => sum + p.weight * p.volatility, 0) * 120,
    0,
    100,
  );
  const maxBorrow = positions.reduce((sum, p) => sum + p.collateralValue, 0);
  const utilization = maxBorrow > 0 ? currentBorrow / maxBorrow : 0;
  const leverageRisk = clamp((utilization / liquidationLtv) * 80, 0, 100);
  const healthScore = clamp(
    100 - concentrationRisk * 0.2 - multiplierRisk * 0.12 - volatilityRisk * 0.28 - leverageRisk * 0.4,
    0,
    100,
  );

  return {
    portfolioValue,
    healthScore,
    band: band(healthScore),
    concentrationRisk,
    multiplierRisk,
    volatilityRisk,
    leverageRisk,
    utilization,
    collateralCapacity: maxBorrow,
    maxBorrow,
    currentBorrow,
    liquidationLtv,
    positions,
  };
}

export function stressRisk(
  holdings: Holding[],
  shocks: Record<string, number>,
  currentBorrow = 0,
  scenario = "Stress scenario",
  marks?: BookMarks,
): StressResult {
  const base = buildRiskSnapshot(holdings, currentBorrow, marks);
  const shocked = buildRiskSnapshot(holdings, currentBorrow, marks, shocks);
  const drawdown = base.portfolioValue > 0 ? 1 - shocked.portfolioValue / base.portfolioValue : 0;
  const healthDrop = base.healthScore - shocked.healthScore;
  const action: RiskAction =
    shocked.healthScore < 45 || shocked.utilization >= 0.65
      ? "protect"
      : shocked.healthScore < 65 || healthDrop > 12
        ? "reduce"
        : shocked.healthScore < 80
          ? "monitor"
          : "none";
  const targetBorrow = shocked.maxBorrow * 0.35;
  const suggestedRepay =
    action === "reduce" || action === "protect" ? Math.max(0, currentBorrow - targetBorrow) : 0;
  const suggestedCollateral =
    action === "protect" ? Math.max(0, currentBorrow / 0.45 - shocked.portfolioValue) : 0;
  return {
    ...shocked,
    scenario,
    shockedValue: shocked.portfolioValue,
    shockedHealth: shocked.healthScore,
    drawdown,
    action,
    suggestedRepay,
    suggestedCollateral,
  };
}
