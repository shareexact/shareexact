import { create } from "zustand";
import { DEMO_HOLDINGS, getStock, type Holding } from "./stocks";
import type { Lang } from "./copy";
import type { OracleSnapshot } from "./oracle";

export type ViewId = "brief" | "holdings" | "thesis" | "night" | "transfer" | "risk";

export type Stance = "hold" | "trim" | "add" | "replace";

export interface HoldingNote {
  symbol: string;
  stance: Stance;
  note: string;
  replaceWith?: string;
}

export interface BriefResult {
  kind: "daily" | "weekly";
  generatedAt: string;
  headline: string;
  sessionNote: string;
  oneLiner: string;
  bias: "constructive" | "cautious" | "mixed";
  holdings: HoldingNote[];
  risks: string[];
  watchTonight: string;
  replacements?: { from: string; to: string; why: string }[];
  calendar?: { when: string; event: string; symbols: string }[];
}

export interface AssetAnalysis {
  symbol: string;
  generatedAt: string;
  stance: Stance;
  summary: string;
  angles: { title: string; body: string }[];
  replaceWith: { symbol: string; why: string } | null;
  afterHours: string;
}

export interface ThesisBasket {
  thesis: string;
  restated: string;
  generatedAt: string;
  basket: { symbol: string; weight: number; role: string; reason: string }[];
  afterHoursNote: string;
  risks: string[];
}

export interface ActivityItem {
  id: string;
  at: string;
  symbol: string;
  uiShares: string;
  raw: string;
  multiplier: string;
  note: string;
  /**
   * Transaction hash, when the row came from a signed send.
   *
   * Kept as its own field rather than embedded in `note` so the row can render
   * a real link. A hash printed as plain text is the one thing in this product
   * a reviewer cannot check, which defeats the point of showing it at all.
   */
  hash?: string;
  /** How it settled. Absent for rows that predate the distinction. */
  route?: "guarded" | "preflight";
}

interface DeskState {
  lang: Lang;
  view: ViewId;
  holdings: Holding[];
  isSample: boolean;
  thesisDraft: string;
  brief: BriefResult | null;
  weekly: BriefResult | null;
  analyses: Record<string, AssetAnalysis>;
  lastBasket: ThesisBasket | null;
  activity: ActivityItem[];
  openSymbol: string | null;
  borrow: number;
  registryCount: number;
  /** Last full oracle read. Null until the first poll returns. */
  oracle: OracleSnapshot | null;
  oracleLoading: boolean;
  setLang: (lang: Lang) => void;
  setView: (view: ViewId) => void;
  loadSample: () => void;
  setHoldings: (holdings: Holding[]) => void;
  setThesisDraft: (v: string) => void;
  setBrief: (b: BriefResult) => void;
  setWeekly: (b: BriefResult) => void;
  setAnalysis: (a: AssetAnalysis) => void;
  setBasket: (b: ThesisBasket) => void;
  applyBasket: (b: ThesisBasket, budget: number) => void;
  addActivity: (item: Omit<ActivityItem, "id" | "at">) => void;
  setOpenSymbol: (symbol: string | null) => void;
  setBorrow: (n: number) => void;
  setRegistryCount: (n: number) => void;
  setOracle: (snapshot: OracleSnapshot | null) => void;
  setOracleLoading: (loading: boolean) => void;
}

export const useDesk = create<DeskState>((set, get) => ({
  lang: "en",
  /**
   * The desk opens on Transfer, not Brief.
   *
   * Transfer is the only tab that reads the chain, computes an exact unit and
   * signs a transaction; everything else explains or simulates. A reviewer
   * gives this a minute, and a minute spent on a briefing is a minute not spent
   * watching a real transfer settle. `docs/DEMO.md` depends on this default.
   */
  view: "transfer",
  holdings: DEMO_HOLDINGS,
  isSample: true,
  thesisDraft:
    "AI infrastructure compounds for two more years, but I don’t want a single-name NVDA bet.",
  brief: null,
  weekly: null,
  analyses: {},
  lastBasket: null,
  activity: [],
  openSymbol: null,
  borrow: 0,
  registryCount: 0,
  oracle: null,
  oracleLoading: false,
  setLang: (lang) => {
    try {
      localStorage.setItem("shareexact:lang", lang);
    } catch {
      /* private mode */
    }
    set({ lang });
  },
  setView: (view) => set({ view }),
  loadSample: () => set({ holdings: DEMO_HOLDINGS, isSample: true, borrow: 0 }),
  setHoldings: (holdings) => set({ holdings, isSample: false }),
  setThesisDraft: (thesisDraft) => set({ thesisDraft }),
  setBrief: (brief) => set({ brief }),
  setWeekly: (weekly) => set({ weekly }),
  setAnalysis: (a) => set({ analyses: { ...get().analyses, [a.symbol]: a } }),
  setBasket: (lastBasket) => set({ lastBasket }),
  applyBasket: (b, budget) => {
    const holdings: Holding[] = b.basket.map((line) => {
      const stock = getStock(line.symbol);
      const px = stock?.price ?? 100;
      const dollars = budget * (line.weight / 100);
      return { symbol: line.symbol, shares: Number((dollars / px).toFixed(4)), cost: px };
    });
    set({ holdings, isSample: false, view: "holdings" });
  },
  addActivity: (item) =>
    set({
      activity: [
        {
          ...item,
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          at: new Date().toISOString(),
        },
        ...get().activity,
      ].slice(0, 40),
    }),
  setOpenSymbol: (openSymbol) => set({ openSymbol }),
  setBorrow: (borrow) => set({ borrow: Math.max(0, borrow) }),
  setRegistryCount: (registryCount) => set({ registryCount }),
  setOracle: (oracle) => set({ oracle }),
  setOracleLoading: (oracleLoading) => set({ oracleLoading }),
}));
