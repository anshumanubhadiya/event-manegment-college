/**
 * candles.ts — tick/quote se multiple timeframe candles banao.
 *
 * Python side jaisa behaviour: session 09:15 pe reset, sirf completed bars
 * strategy ko dikhte hain (chalu bar ko bhi include karte hain par "forming"
 * flag ke saath — strategies forming bar pe trade nahi leti).
 */

import { istParts } from "../util.ts";

export interface Bar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  forming?: boolean;
}

export const TIMEFRAMES: Record<string, number> = {
  "1m": 1,
  "3m": 3,
  "5m": 5,
  "15m": 15,
};

function tfMinutes(tf: string): number {
  const m = TIMEFRAMES[tf];
  if (!m) throw new Error(`timeframe "${tf}" support nahi hai (${Object.keys(TIMEFRAMES).join(", ")})`);
  return m;
}

/** Session ka start (09:15 IST) epoch ms me. */
function sessionStartMs(ts: number): number {
  const p = istParts(ts);
  const openedMinutes = p.minuteOfDay - 9 * 60 - 15;
  return ts - openedMinutes * 60_000 - p.second * 1000;
}

export class CandleStore {
  readonly timeframes: string[];
  private bars = new Map<string, Bar[]>();
  private current = new Map<string, Bar>();
  private session = "";
  dayOpen = 0;
  prevClose = 0;

  constructor(timeframes: string[] = ["1m", "5m", "15m"]) {
    this.timeframes = timeframes;
    for (const tf of timeframes) {
      this.bars.set(tf, []);
      this.current.delete(tf);
    }
  }

  get sessionKey(): string {
    return this.session;
  }

  /** Naya tick — candle update. */
  push(ts: number, price: number, volume = 0): void {
    if (!Number.isFinite(price) || price <= 0) return;
    const key = istParts(ts).dateKey;
    if (key !== this.session) {
      if (this.session) this.prevClose = this.lastClose();
      this.reset(key);
    }
    if (!this.dayOpen) this.dayOpen = price;
    for (const tf of this.timeframes) {
      const bucket = Math.floor(ts / (tfMinutes(tf) * 60_000)) * tfMinutes(tf) * 60_000;
      let cur = this.current.get(tf);
      const closed = this.bars.get(tf)!;
      if (!cur || cur.ts !== bucket) {
        if (cur) {
          const { forming: _drop, ...final } = cur; // eslint-disable-line @typescript-eslint/no-unused-vars
          closed.push(final);
        }
        cur = { ts: bucket, open: price, high: price, low: price, close: price, volume, forming: true };
        this.current.set(tf, cur);
      } else {
        cur.high = Math.max(cur.high, price);
        cur.low = Math.min(cur.low, price);
        cur.close = price;
        cur.volume += volume;
      }
    }
  }

  private reset(key: string): void {
    this.session = key;
    for (const tf of this.timeframes) {
      this.bars.set(tf, []);
      this.current.delete(tf);
    }
    this.dayOpen = 0;
  }

  /** Closed bars + current forming bar (agar ho). */
  series(tf: string): Bar[] {
    const closed = this.bars.get(tf) ?? [];
    const cur = this.current.get(tf);
    return cur ? [...closed, cur] : closed;
  }

  /** Sirf closed bars. */
  closedBars(tf: string): Bar[] {
    return this.bars.get(tf) ?? [];
  }

  lastClose(): number {
    for (const tf of this.timeframes) {
      const s = this.series(tf);
      if (s.length) return s[s.length - 1]!.close;
    }
    return 0;
  }

  get lastPrice(): number {
    return this.lastClose();
  }

  dayHigh(): number {
    let hi = 0;
    for (const tf of this.timeframes) {
      for (const b of this.series(tf)) hi = Math.max(hi, b.high);
    }
    return hi;
  }

  dayLow(): number {
    let lo = Number.POSITIVE_INFINITY;
    for (const tf of this.timeframes) {
      for (const b of this.series(tf)) lo = Math.min(lo, b.low);
    }
    return Number.isFinite(lo) ? lo : 0;
  }

  /** Session ka opening range (pehle N minute). */
  openingRange(minutes: number): { high: number; low: number; complete: boolean } | undefined {
    const bars = this.series("1m");
    if (!bars.length) return undefined;
    const startTs = sessionStartMs(bars[0]!.ts);
    const endTs = startTs + minutes * 60_000;
    const inRange = bars.filter((b) => b.ts < endTs);
    if (!inRange.length) return undefined;
    const last = bars[bars.length - 1]!;
    return {
      high: Math.max(...inRange.map((b) => b.high)),
      low: Math.min(...inRange.map((b) => b.low)),
      complete: last.ts >= endTs - 60_000,
    };
  }

  snapshot(): Record<string, Bar[]> {
    const out: Record<string, Bar[]> = {};
    for (const tf of this.timeframes) out[tf] = this.series(tf).slice(-400);
    return out;
  }
}
