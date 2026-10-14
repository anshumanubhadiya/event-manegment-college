/**
 * indicators.ts — technical indicators (Python side se same formulas,
 * taaki backtest aur live me same signal aaye).
 */

import type { Bar } from "./candles.ts";

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]!) / period;
    out[i] = prev;
  }
  return out;
}

export function rsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const ag = rma(gains, period);
  const al = rma(losses, period);
  for (let i = 0; i < gains.length; i++) {
    const g = ag[i];
    const l = al[i];
    if (g === null || l === null) continue;
    out[i + 1] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

export function trueRange(highs: number[], lows: number[], closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) {
      out.push(highs[i]! - lows[i]!);
      continue;
    }
    const prevClose = closes[i - 1]!;
    out.push(Math.max(highs[i]! - lows[i]!, Math.abs(highs[i]! - prevClose), Math.abs(lows[i]! - prevClose)));
  }
  return out;
}

export function atr(highs: number[], lows: number[], closes: number[], period = 14): (number | null)[] {
  return rma(trueRange(highs, lows, closes), period);
}

/** ADX + DI. Returns { adx, pdi, mdi }. */
export function adx(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): { adx: (number | null)[]; pdi: (number | null)[]; mdi: (number | null)[] } {
  const n = closes.length;
  const pdm: number[] = [0];
  const mdm: number[] = [0];
  for (let i = 1; i < n; i++) {
    const up = highs[i]! - highs[i - 1]!;
    const dn = lows[i - 1]! - lows[i]!;
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
  }
  const tr = rma(trueRange(highs, lows, closes), period);
  const sp = rma(pdm, period);
  const sm = rma(mdm, period);
  const pdi: (number | null)[] = new Array(n).fill(null);
  const mdi: (number | null)[] = new Array(n).fill(null);
  const dx: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const t = tr[i];
    if (t === null || t === 0) continue;
    const p = sp[i];
    const m = sm[i];
    if (p === null || m === null) continue;
    pdi[i] = (p / t) * 100;
    mdi[i] = (m / t) * 100;
    const sum = (pdi[i] as number) + (mdi[i] as number);
    dx[i] = sum === 0 ? 0 : (Math.abs((pdi[i] as number) - (mdi[i] as number)) / sum) * 100;
  }
  const dxClean = dx.map((v) => v ?? 0);
  const adxArr = rma(dxClean, period).map((v, i) => (dx[i] === null || v === null ? null : v));
  return { adx: adxArr, pdi, mdi };
}

/** Session VWAP (typical price, volume weighted). */
export function vwap(bars: Bar[]): number | null {
  let pv = 0;
  let v = 0;
  for (const b of bars) {
    const tp = (b.high + b.low + b.close) / 3;
    const vol = Math.max(b.volume, 1);
    pv += tp * vol;
    v += vol;
  }
  return v === 0 ? null : pv / v;
}

/** Rolling population stdev. */
export function stdev(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const win = values.slice(i - period + 1, i + 1);
    const mean = win.reduce((a, b) => a + b, 0) / period;
    const varr = win.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    out[i] = Math.sqrt(varr);
  }
  return out;
}

/** VWAP bands — VWAP ke around volume-weighted dispersion (Python jaisa). */
export function vwapBands(
  bars: Bar[],
  vwapValue?: number | null,
): { vwap: number | null; sigma: number; upper: number; lower: number } {
  if (!bars.length) return { vwap: null, sigma: 0, upper: 0, lower: 0 };
  const vw = vwapValue ?? vwap(bars);
  if (vw === null) return { vwap: null, sigma: 0, upper: 0, lower: 0 };
  let pv = 0;
  let v = 0;
  for (const b of bars) {
    const tp = (b.high + b.low + b.close) / 3;
    const vol = Math.max(b.volume, 1);
    pv += vol * (tp - vw) ** 2;
    v += vol;
  }
  const sigma = Math.sqrt(pv / v);
  return { vwap: vw, sigma, upper: vw + sigma, lower: vw - sigma };
}

/** Supertrend (ATR-based). Returns { up: boolean[], line: number[] }. */
export function supertrend(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 10,
  mult = 3,
): { up: boolean[]; line: (number | null)[] } {
  const n = closes.length;
  const a = atr(highs, lows, closes, period);
  const up: boolean[] = new Array(n).fill(false);
  const line: (number | null)[] = new Array(n).fill(null);
  let prevUpper = 0;
  let prevLower = 0;
  let prevDir = 1;
  for (let i = 0; i < n; i++) {
    const av = a[i];
    if (av === null) continue;
    const hl2 = (highs[i]! + lows[i]!) / 2;
    let upper = hl2 + mult * av;
    let lower = hl2 - mult * av;
    if (i > 0) {
      upper = closes[i - 1]! > prevUpper ? Math.max(upper, prevUpper) : upper;
      lower = closes[i - 1]! < prevLower ? Math.min(lower, prevLower) : lower;
    }
    let dir: number;
    if (i === 0) dir = closes[i]! >= hl2 ? 1 : -1;
    else if (prevDir === 1) dir = closes[i]! < lower ? -1 : 1;
    else dir = closes[i]! > upper ? 1 : -1;
    up[i] = dir === 1;
    line[i] = dir === 1 ? lower : upper;
    prevUpper = upper;
    prevLower = lower;
    prevDir = dir;
  }
  return { up, line };
}

/** Rolling high/low (last N bars, current excluded by default). */
export function rollingExtremes(
  values: number[],
  period: number,
  mode: "high" | "low",
): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const win = values.slice(i - period + 1, i + 1);
    out[i] = mode === "high" ? Math.max(...win) : Math.min(...win);
  }
  return out;
}

export function closes(bars: Bar[]): number[] {
  return bars.map((b) => b.close);
}
export function highs(bars: Bar[]): number[] {
  return bars.map((b) => b.high);
}
export function lows(bars: Bar[]): number[] {
  return bars.map((b) => b.low);
}

export function last<T>(arr: (T | null | undefined)[]): T | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}
