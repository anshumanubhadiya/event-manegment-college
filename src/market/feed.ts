/**
 * feed.ts — price source. Do implementation:
 *
 *  SyntheticFeed — demo/test ke liye. Virtual clock pe calibrated random walk
 *                  (NIFTY vol ~14% annual, U-shape intraday vol, gap opens, bursts).
 *                  Option premium Black-Scholes se derive hota hai.
 *  BrokerFeed    — paper/live ke liye. Broker REST se quote poll karta hai
 *                  (index + jitne option legs subscribed hain).
 *
 * NOTE: WebSocket tick-by-tick feed TODO hai (broker WS APIs). REST polling
 * 1-second pe intraday options ke liye kaafi hai kyunki hum candle-close pe
 * decisions lete hain.
 */

import { config } from "../config.ts";
import { fetchJson, gauss, istParts, mulberry32, parseHhmm, sleep } from "../util.ts";
import type { Broker } from "../broker/types.ts";
import { SESSION } from "./calendar.ts";
import { estimatePremium, skewedIv } from "./options.ts";
import { indexMeta } from "./instruments.ts";
import type { Clock } from "./clock.ts";

export interface Quote {
  symbol: string;
  ts: number;
  ltp: number;
  bid: number;
  ask: number;
  volume?: number;
}

export interface OptionRef {
  symbol: string; // generic trading symbol
  index: string;
  strike: number;
  optType: "CE" | "PE";
  expiryCode: string;
  /** human readable expiry date */
  expiryDate: string;
  /** weekly ya monthly expiry (symbol format ke liye) */
  expiryWeekly: boolean;
  dteDays: number;
}

export interface Feed {
  readonly source: "synthetic" | "broker";
  start(): Promise<void>;
  stop(): Promise<void>;
  indexQuote(index: string): Quote | undefined;
  optionQuote(ref: OptionRef): Quote | undefined;
  onTick(cb: (q: Quote) => void): void;
  /** Engine naye legs subscribe karta hai jab trade lage. */
  watchOption(ref?: OptionRef): void;
}

// ============================================================ synthetic feed

interface SynthState {
  price: number;
  dayKey: string;
  tradingDay: boolean;
  bias: number;
  burstLeft: number;
  burstDir: number;
  momentum: number;
}

export class SyntheticFeed implements Feed {
  readonly source = "synthetic" as const;
  private rnd: () => number;
  private state: SynthState;
  private timer?: NodeJS.Timeout;
  private listeners: Array<(q: Quote) => void> = [];
  private index: string;
  private opts = new Map<string, OptionRef>();
  private lastTs = 0;
  private running = false;
  private tickCounter = 0;

  constructor(
    private clock: Clock,
    index = config.market.symbol,
    private basePrice = 0,
  ) {
    this.index = index;
    this.rnd = mulberry32(config.demo.seed);
    const start = this.startTs();
    this.basePrice = basePrice || 25_000;
    const p = istParts(start);
    this.state = {
      price: this.basePrice,
      dayKey: p.dateKey,
      tradingDay: true,
      bias: gauss(this.rnd) * 0.3,
      burstLeft: 0,
      burstDir: 1,
      momentum: 0,
    };
    this.lastTs = start;
  }

  private startTs(): number {
    const [h, m] = parseHhmm(config.demo.startTime);
    const now = this.clock.now();
    const p = istParts(now);
    return Date.UTC(p.year, p.month - 1, p.day, h - 5, m - 30) - 0; // IST → UTC epoch (approx, util se)
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // 250ms pe tick — virtual clock ki speed se "virtual seconds" generate hote hain
    const intervalMs = 250;
    this.timer = setInterval(() => {
      try {
        this.generateBatch(intervalMs);
      } catch (e) {
        console.error(`[synth-feed] tick error: ${(e as Error).message}`);
      }
    }, intervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  onTick(cb: (q: Quote) => void): void {
    this.listeners.push(cb);
  }

  watchOption(ref?: OptionRef): void {
    if (ref) this.opts.set(ref.symbol, ref);
  }

  indexQuote(index: string): Quote | undefined {
    if (index.toUpperCase() !== this.index.toUpperCase()) return undefined;
    return this.quoteNow(this.index);
  }

  optionQuote(ref: OptionRef): Quote | undefined {
    this.opts.set(ref.symbol, ref);
    const spot = this.state.price;
    const premium = estimatePremium(ref.index, spot, ref.strike, ref.optType, Math.max(ref.dteDays, 0.02));
    const iv = skewedIv(ref.index, spot, ref.strike, Math.max(ref.dteDays, 0.02), ref.optType);
    const spreadPct = 0.4 + iv * 2; // options me spread % (sasta option = mota spread)
    const half = Math.max(premium * (spreadPct / 100), 0.05);
    return {
      symbol: ref.symbol,
      ts: this.clock.now(),
      ltp: premium,
      bid: Math.max(premium - half, 0.05),
      ask: premium + half,
      volume: 1000 + this.tickCounter,
    };
  }

  private quoteNow(symbol: string): Quote {
    const px = this.state.price;
    const spread = Math.max(px * 0.00002, 0.5);
    return {
      symbol,
      ts: this.clock.now(),
      ltp: px,
      bid: px - spread / 2,
      ask: px + spread / 2,
      volume: 1000 + this.tickCounter,
    };
  }

  /**
   * Virtual time ke hisaab se ticks banao.
   * Har tick ke saath clock advance karte hain — isse ek virtual minute me
   * kam se kam 4 ticks milte hain (1-min candles ban sakein, ORB jaisi
   * strategies ko 15 bars chahiye hoti hain).
   */
  private generateBatch(realIntervalMs: number): void {
    const virtualDeltaMs = realIntervalMs * this.clock.speed();
    const ticks = Math.min(Math.max(Math.ceil(virtualDeltaMs / 15_000), 1), 40);
    const stepMs = virtualDeltaMs / ticks;
    for (let i = 0; i < ticks; i++) {
      this.clock.advance?.(stepMs);
      this.step(stepMs / 60_000);
    }
  }

  /** Ek sub-step (per virtual minute ka fraction). */
  private step(minuteFraction: number): void {
    const now = this.clock.now();
    const p = istParts(now);
    if (p.dateKey !== this.state.dayKey) {
      // naya din (demo me sirf tab jab session cross ho)
      this.state.dayKey = p.dateKey;
      this.state.bias = gauss(this.rnd) * 0.3;
      this.state.price *= 1 + gauss(this.rnd) * 0.0035; // gap
    }
    // NIFTY vol calibration: annual 14% × intraday share 0.62 / sqrt(252×375)
    const perMinBase = (0.14 * 0.62) / Math.sqrt(252 * SESSION.sessionMinutes);
    const frac = Math.min(Math.max((p.minuteOfDay - SESSION.open) / SESSION.sessionMinutes, 0), 1);
    const uShape = 1.6 - 1.2 * Math.sin(Math.PI * frac) ** 1.4;
    const sigma = perMinBase * uShape * Math.sqrt(minuteFraction);

    this.state.momentum = 0.88 * this.state.momentum + 0.12 * gauss(this.rnd) * sigma;
    if (this.state.burstLeft <= 0 && this.rnd() < 0.010 * minuteFraction * 10) {
      this.state.burstLeft = 6 + Math.floor(this.rnd() * 12);
      this.state.burstDir = this.rnd() < 0.5 ? 1 : -1;
    }
    let burst = 0;
    if (this.state.burstLeft > 0) {
      this.state.burstLeft -= 1;
      burst = this.state.burstDir * sigma * (0.30 + this.rnd() * 0.45);
    }
    const drift = this.state.bias * sigma * 0.20;
    const ret = gauss(this.rnd) * sigma + drift + this.state.momentum * 0.12 + burst;
    this.state.price = Math.max(this.state.price * (1 + ret), 1000);

    this.tickCounter++;
    const q = this.quoteNow(this.index);
    this.lastTs = now;
    for (const cb of this.listeners) cb(q);
    void sleep;
  }
}

// ============================================================ broker feed

export class BrokerFeed implements Feed {
  readonly source = "broker" as const;
  private listeners: Array<(q: Quote) => void> = [];
  private quotes = new Map<string, Quote>();
  private index: string;
  private indexSymbol: string;
  private timer?: NodeJS.Timeout;
  private running = false;
  private optionSyms = new Set<string>();
  private optionIndex = new Map<string, OptionRef>();
  private lastErrorLogged = 0;

  constructor(
    private broker: Broker,
    index = config.market.symbol,
    private pollMs = 1000,
  ) {
    this.index = index;
    this.indexSymbol = broker.quoteSymbolFor(index);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  onTick(cb: (q: Quote) => void): void {
    this.listeners.push(cb);
  }

  watchOption(ref?: OptionRef): void {
    if (!ref) return;
    this.optionSyms.add(ref.symbol);
    this.optionIndex.set(ref.symbol, ref);
  }

  indexQuote(index: string): Quote | undefined {
    return index.toUpperCase() === this.index.toUpperCase() ? this.quotes.get(this.indexSymbol) : undefined;
  }

  optionQuote(ref: OptionRef): Quote | undefined {
    return this.quotes.get(ref.symbol);
  }

  private async poll(): Promise<void> {
    try {
      const symbols = [this.indexSymbol, ...this.optionSyms];
      const list = await this.broker.quotes(symbols);
      const now = Date.now();
      for (const q of list) {
        const mapped: Quote = {
          symbol: q.symbol,
          ts: q.ts ?? now,
          ltp: q.ltp,
          bid: q.bid ?? q.ltp,
          ask: q.ask ?? q.ltp,
          volume: q.volume,
        };
        this.quotes.set(q.symbol, mapped);
        for (const cb of this.listeners) cb(mapped);
      }
    } catch (e) {
      // rate-limit friendly: har 30s me ek hi error log
      if (Date.now() - this.lastErrorLogged > 30_000) {
        this.lastErrorLogged = Date.now();
        console.warn(`[broker-feed] quote poll fail: ${(e as Error).message}`);
      }
    }
  }
}

/** Health check — broker REST reachable hai? */
export async function pingBroker(baseUrl: string, timeoutMs = 3000): Promise<boolean> {
  try {
    await fetchJson(baseUrl, {}, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

void indexMeta;
