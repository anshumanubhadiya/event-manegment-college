/**
 * types.ts — Strategy ka JSON contract. Ye SHAPE Python side (py/algo/types.py)
 * ke saath bilkul same hai, isliye ek hi strategy code backtest aur live me chalta hai.
 */

export type Action = "buy" | "sell" | "hold" | "exit";

export interface BarJson {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PositionJson {
  symbol: string;
  qty: number;
  side: "long" | "short" | "flat";
  entry: number;
  stop?: number | null;
  target?: number | null;
  openedTs?: number | null;
  tag?: string;
  optionSymbol?: string | null;
  optionEntry?: number | null;
  lots?: number;
}

export interface MarketState {
  symbol: string;
  ts: number;
  ltp: number;
  bars: Record<string, BarJson[]>;
  prevClose?: number | null;
  dayOpen?: number | null;
  dayHigh?: number | null;
  dayLow?: number | null;
  vwap?: number | null;
  atr?: number | null;
  adx?: number | null;
  position?: PositionJson | null;
  dayPnl: number;
  tradesToday: number;
  consecutiveLosses: number;
  minutesToClose: number;
  atmStrike?: number | null;
  iv?: number | null;
  pcr?: number | null;
  meta?: Record<string, unknown>;
}

export interface Signal {
  action: Action;
  reason: string;
  confidence: number;
  stop?: number | null;
  target?: number | null;
  lots?: number | null;
  tag?: string;
  meta?: Record<string, unknown>;
}

export interface Strategy {
  readonly name: string;
  readonly timeframes: string[];
  /** Kitne bars chahiye signal ke liye. */
  warmup(): number;
  /** Naya din — state reset. */
  resetDay(): void;
  /** Naya bar/tick — signal do (ya hold). */
  onState(s: MarketState): Signal;
}

// ---------------------------------------------------------------- helpers
export function hold(reason = "", meta?: Record<string, unknown>): Signal {
  return { action: "hold", reason, confidence: 0.5, meta };
}

export function makeSignal(
  action: Action,
  reason: string,
  confidence: number,
  stop?: number | null,
  target?: number | null,
  extra?: { lots?: number; tag?: string; meta?: Record<string, unknown> },
): Signal {
  return {
    action,
    reason,
    confidence,
    stop: stop ?? null,
    target: target ?? null,
    lots: extra?.lots ?? null,
    tag: extra?.tag ?? "",
    meta: extra?.meta ?? {},
  };
}

export function minutesOfDay(ts: number): number {
  const d = new Date(ts + 5.5 * 3600 * 1000); // IST wall clock (UTC getters)
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function closesOf(s: MarketState, tf: string): number[] {
  return (s.bars[tf] ?? []).map((b) => b.close);
}
export function highsOf(s: MarketState, tf: string): number[] {
  return (s.bars[tf] ?? []).map((b) => b.high);
}
export function lowsOf(s: MarketState, tf: string): number[] {
  return (s.bars[tf] ?? []).map((b) => b.low);
}
