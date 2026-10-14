/**
 * local.ts — TS me implemented strategies (Python ka port).
 *
 * Kaam kya hai: jab Python strategy service na chale (ya demo mode ho), engine
 * inhi strategies pe chalta hai. Formulas Python side se IDENTICAL rakhe gaye
 * hain taaki backtest aur live me same signal aaye.
 *
 * Note: trade counting engine karta hai (s.tradesToday) — strategies khud count
 * nahi karti, warna reject hue signals bhi count ho jaate hain.
 */

import { config } from "../config.ts";
import { adx, atr, ema, highs, lows, closes, rsi, supertrend, vwap, vwapBands, last } from "../market/indicators.ts";
import type { Bar } from "../market/candles.ts";
import type { MarketState, Signal, Strategy } from "./types.ts";
import { closesOf, highsOf, hold, lowsOf, makeSignal, minutesOfDay } from "./types.ts";

function params<T extends Record<string, number | string | boolean>>(defaults: T): T {
  return { ...defaults, ...(config.strategy.params as Partial<T>) };
}

// ============================================================ ORB
/** Python ka ORB (py/algo/strategies/orb.py) ka TS port — same params, same logic. */
export class OrbStrategy implements Strategy {
  readonly name = "orb";
  readonly timeframes = ["1m", "5m"];
  private p = params({
    or_minutes: 15,
    buffer_points: 3.0,
    sl_mode: "atr",
    atr_mult: 1.0,
    min_sl_points: 15.0,
    max_sl_points: 60.0,
    target_rr: 1.6,
    max_trades: 2,
    entry_cutoff: "13:30",
    retest_required: false,
    one_side_only: false,
  });
  private day: { orHigh: number | null; orLow: number | null; done: boolean; broke: "up" | "down" | null; firstSide: "up" | "down" | null } = {
    orHigh: null,
    orLow: null,
    done: false,
    broke: null,
    firstSide: null,
  };

  warmup(): number {
    return 5;
  }
  resetDay(): void {
    this.day = { orHigh: null, orLow: null, done: false, broke: null, firstSide: null };
  }

  onState(s: MarketState): Signal {
    const p = this.p;
    const orMin = Number(p.or_minutes);
    const buf = Number(p.buffer_points);
    const orEnd = 9 * 60 + 15 + orMin;

    // 1. opening range — poora window bharne ka intezaar (warna adhoori range se signal)
    if (this.day.orHigh === null) {
      const mod = minutesOfDay(s.ts);
      if (mod < orEnd) return hold(`opening range ban rahi hai (${orEnd - mod}m baaki)`);
      const bars1 = s.bars["1m"] ?? [];
      const rng = bars1.filter((b) => {
        const m = minutesOfDay(b.ts);
        return m >= 9 * 60 + 15 && m < orEnd;
      });
      if (rng.length < Math.max(3, Math.floor(orMin / 2))) return hold("opening range ke bars nahi mile");
      this.day.orHigh = Math.max(...rng.map((b) => b.high));
      this.day.orLow = Math.min(...rng.map((b) => b.low));
      return hold(`OR set ${this.day.orLow.toFixed(0)}-${this.day.orHigh.toFixed(0)}`);
    }

    // 2. guards
    if (this.day.done) return hold("ORB done for today");
    if (s.tradesToday >= Number(p.max_trades)) return hold("max ORB trades reached");
    const mod = minutesOfDay(s.ts);
    const [ch, cm] = String(p.entry_cutoff).split(":").map(Number);
    if (mod > (ch ?? 13) * 60 + (cm ?? 30)) return hold("past entry cutoff");

    const orh = this.day.orHigh as number;
    const orl = this.day.orLow as number;
    const longTrig = orh + buf;
    const shortTrig = orl - buf;
    let up = s.ltp >= longTrig;
    let down = s.ltp <= shortTrig;

    // 3. optional retest
    if (p.retest_required) {
      if (this.day.broke === null) {
        if (up) this.day.broke = "up";
        else if (down) this.day.broke = "down";
        else return hold("breakout ka wait");
        return hold(`${this.day.broke} breakout hua, retest ka wait`);
      }
      if (this.day.broke === "up") {
        up = s.ltp <= orh + buf && s.ltp >= orh - buf;
        down = false;
      } else {
        down = s.ltp >= orl - buf && s.ltp <= orl + buf;
        up = false;
      }
    }
    if (!up && !down) return hold("");

    // 4. risk levels (index pe — engine premium me convert karega)
    const atr = s.atr ?? (orh - orl) * 0.35;
    const minSl = Number(p.min_sl_points);
    const maxSl = Number(p.max_sl_points);
    const oneSide = Boolean(p.one_side_only);
    const entry = s.ltp;

    if (up) {
      let stop = p.sl_mode === "range" ? orl : entry - Number(p.atr_mult) * atr;
      stop = Math.min(stop, entry - minSl);
      stop = Math.max(stop, entry - maxSl);
      const risk = entry - stop;
      const target = entry + Number(p.target_rr) * risk;
      this.day.firstSide = this.day.firstSide ?? "up";
      this.day.done = oneSide || s.tradesToday + 1 >= Number(p.max_trades);
      const conf = Math.min(0.6 + (s.ltp > orh + 2 * buf ? 0.15 : 0), 0.9);
      return makeSignal("buy", `ORB long: ${entry.toFixed(0)} > ORH ${orh.toFixed(0)} + ${buf.toFixed(0)}`, conf, stop, target, {
        tag: this.name,
        meta: { orHigh: orh, orLow: orl, riskPoints: Number(risk.toFixed(2)) },
      });
    }
    let stop = p.sl_mode === "range" ? orh : entry + Number(p.atr_mult) * atr;
    stop = Math.max(stop, entry + minSl);
    stop = Math.min(stop, entry + maxSl);
    const risk = stop - entry;
    const target = entry - Number(p.target_rr) * risk;
    this.day.firstSide = this.day.firstSide ?? "down";
    this.day.done = oneSide || s.tradesToday + 1 >= Number(p.max_trades);
    const conf = Math.min(0.6 + (s.ltp < orl - 2 * buf ? 0.15 : 0), 0.9);
    return makeSignal("sell", `ORB short: ${entry.toFixed(0)} < ORL ${orl.toFixed(0)} - ${buf.toFixed(0)}`, conf, stop, target, {
      tag: this.name,
      meta: { orHigh: orh, orLow: orl, riskPoints: Number(risk.toFixed(2)) },
    });
  }
}

// ============================================================ EMA cross
export class EmaCrossStrategy implements Strategy {
  readonly name = "ema_cross";
  readonly timeframes = ["5m", "15m"];
  private p = params({
    fast: 9,
    slow: 21,
    trend_ema: 50,
    adx_min: 18,
    atr_mult: 1.5,
    min_sl_points: 15,
    max_sl_points: 70,
    target_rr: 2.0,
    max_trades: 3,
    vwap_filter: true,
  });
  private prevFast: number | null = null;
  private prevSlow: number | null = null;

  warmup(): number {
    return 60;
  }
  resetDay(): void {
    this.prevFast = null;
    this.prevSlow = null;
  }

  onState(s: MarketState): Signal {
    const p = this.p;
    const tf = "5m";
    const c = closesOf(s, tf);
    const h = highsOf(s, tf);
    const l = lowsOf(s, tf);
    if (c.length < this.warmup()) return hold("EMA: warmup");

    const fastArr = ema(c, Number(p.fast));
    const slowArr = ema(c, Number(p.slow));
    const trendArr = ema(c, Number(p.trend_ema));
    const fast = last(fastArr);
    const slow = last(slowArr);
    const trend = last(trendArr);
    if (fast === null || slow === null) return hold("EMA: data");

    const a = last(atr(h, l, c, 14)) ?? 20;
    const adxV = last(adx(h, l, c, 14).adx) ?? 0;
    const crossedUp = this.prevFast !== null && this.prevSlow !== null && this.prevFast <= this.prevSlow && fast > slow;
    const crossedDn = this.prevFast !== null && this.prevSlow !== null && this.prevFast >= this.prevSlow && fast < slow;
    this.prevFast = fast;
    this.prevSlow = slow;

    if (s.tradesToday >= Number(p.max_trades)) return hold("EMA: max trades");
    if (adxV < Number(p.adx_min)) return hold(`EMA: ADX ${adxV.toFixed(0)} kam`);
    if (!crossedUp && !crossedDn) return hold("EMA: cross ka wait");

    const vwapVal = s.vwap ?? null;
    const vwapOk = !p.vwap_filter || vwapVal === null || (crossedUp ? s.ltp > vwapVal : s.ltp < vwapVal);
    if (!vwapOk) return hold("EMA: VWAP galat side");
    const trendOk = trend === null || (crossedUp ? s.ltp > trend : s.ltp < trend);
    if (!trendOk) return hold("EMA: trend EMA galat side");

    const slPts = Math.min(Math.max(a * Number(p.atr_mult), Number(p.min_sl_points)), Number(p.max_sl_points));
    const stop = crossedUp ? s.ltp - slPts : s.ltp + slPts;
    const target = crossedUp ? s.ltp + slPts * Number(p.target_rr) : s.ltp - slPts * Number(p.target_rr);
    return makeSignal(
      crossedUp ? "buy" : "sell",
      `EMA ${crossedUp ? "bullish" : "bearish"} cross (5m, ADX ${adxV.toFixed(0)})`,
      0.6,
      stop,
      target,
      { tag: this.name, meta: { adx: adxV, atr: a } },
    );
  }
}

// ============================================================ Supertrend + ADX
export class SupertrendAdxStrategy implements Strategy {
  readonly name = "supertrend_adx";
  readonly timeframes = ["5m", "15m"];
  private p = params({
    st_period: 10,
    st_mult: 3.0,
    rsi_period: 14,
    rsi_bull: 54,
    rsi_bear: 46,
    adx_min: 15,
    atr_mult: 1.0,
    min_sl_points: 15,
    max_sl_points: 60,
    target_rr: 2.0,
    max_trades: 2,
  });
  private prevUp: boolean | null = null;

  warmup(): number {
    return 40;
  }
  resetDay(): void {
    this.prevUp = null;
  }

  onState(s: MarketState): Signal {
    const p = this.p;
    const tf = "5m";
    const c = closesOf(s, tf);
    const h = highsOf(s, tf);
    const l = lowsOf(s, tf);
    if (c.length < this.warmup()) return hold("ST: warmup");

    const st = supertrend(h, l, c, Number(p.st_period), Number(p.st_mult));
    const up = st.up[st.up.length - 1] ?? false;
    const line = last(st.line) ?? s.ltp;
    const r = last(rsi(c, Number(p.rsi_period))) ?? 50;
    const adxV = last(adx(h, l, c, 14).adx) ?? 0;
    const a = last(atr(h, l, c, 14)) ?? 20;
    const flipped = this.prevUp !== null && up !== this.prevUp;
    this.prevUp = up;

    if (s.tradesToday >= Number(p.max_trades)) return hold("ST: max trades");
    if (adxV < Number(p.adx_min)) return hold(`ST: ADX ${adxV.toFixed(0)} kam`);
    if (!flipped) return hold("ST: flip ka wait");

    if (up && r > Number(p.rsi_bull)) {
      let stop = Math.min(line, s.ltp - a * 0.5);
      stop = Math.min(stop, s.ltp - Number(p.min_sl_points));
      stop = Math.max(stop, s.ltp - Number(p.max_sl_points));
      const risk = s.ltp - stop;
      return makeSignal("buy", `Supertrend up flip, RSI ${r.toFixed(0)}, ADX ${adxV.toFixed(0)}`, Math.min(0.5 + (r - 50) / 100, 0.85), stop, s.ltp + risk * Number(p.target_rr), {
        tag: this.name,
        meta: { adx: adxV, rsi: r },
      });
    }
    if (!up && r < Number(p.rsi_bear)) {
      let stop = Math.max(line, s.ltp + a * 0.5);
      stop = Math.max(stop, s.ltp + Number(p.min_sl_points));
      stop = Math.min(stop, s.ltp + Number(p.max_sl_points));
      const risk = stop - s.ltp;
      return makeSignal("sell", `Supertrend down flip, RSI ${r.toFixed(0)}, ADX ${adxV.toFixed(0)}`, Math.min(0.5 + (50 - r) / 100, 0.85), stop, s.ltp - risk * Number(p.target_rr), {
        tag: this.name,
        meta: { adx: adxV, rsi: r },
      });
    }
    return hold("ST: RSI filter");
  }
}

// ============================================================ VWAP reversion
export class VwapReversionStrategy implements Strategy {
  readonly name = "vwap_reversion";
  readonly timeframes = ["1m", "5m"];
  private p = params({
    k_sigma: 2.0,
    stall_bars: 1,
    stop_sigma: 1.0,
    adx_max: 22,
    min_target_points: 10,
    max_trades: 3,
    skip_first_minutes: 20,
    skip_last_minutes: 30,
    tf: "5m",
  });

  warmup(): number {
    return 35;
  }
  resetDay(): void {
    /* stateless (counts engine se) */
  }

  onState(s: MarketState): Signal {
    const p = this.p;
    const tf = String(p.tf);
    const c = closesOf(s, tf);
    if (c.length < this.warmup() || !s.vwap) return hold("VWAP: warmup/no vwap");

    const mod = minutesOfDay(s.ts);
    if (mod < 9 * 60 + 15 + Number(p.skip_first_minutes)) return hold("VWAP: opening skip");
    if (s.minutesToClose <= Number(p.skip_last_minutes)) return hold("VWAP: close ke paas nahi");

    const barsTf = (s.bars[tf] ?? []) as Bar[];
    const { sigma } = vwapBands(barsTf, s.vwap);
    const sd = sigma > 0 ? sigma : 1;
    const dev = (s.ltp - s.vwap) / sd;
    const distPts = Math.abs(s.ltp - s.vwap);
    const adxV = last(adx(highsOf(s, tf), lowsOf(s, tf), c, 14).adx) ?? 0;

    if (s.position && s.position.qty !== 0) {
      const long = s.position.qty > 0;
      if (long && s.ltp >= s.vwap) return makeSignal("exit", "VWAP touch — mean reversion done", 0.7);
      if (!long && s.ltp <= s.vwap) return makeSignal("exit", "VWAP touch — mean reversion done", 0.7);
    }
    if (adxV > Number(p.adx_max)) return hold(`VWAP: trend regime (ADX ${adxV.toFixed(0)})`);
    if (s.tradesToday >= Number(p.max_trades)) return hold("VWAP: max trades");
    if (distPts < Number(p.min_target_points)) return hold("VWAP: bahut paas");

    const k = Number(p.k_sigma);
    const stall = Number(p.stall_bars);
    const reversingUp = stall > 0 ? c[c.length - 1]! > c[c.length - 1 - stall]! : true;
    const reversingDn = stall > 0 ? c[c.length - 1]! < c[c.length - 1 - stall]! : true;
    const stopSigma = Number(p.stop_sigma);

    if (dev <= -k && reversingUp) {
      return makeSignal("buy", `VWAP fade long: ${dev.toFixed(1)}σ below VWAP, ADX ${adxV.toFixed(0)}`, Math.min(0.5 + (Math.abs(dev) - k) * 0.15, 0.85), s.ltp - stopSigma * sd, s.vwap, {
        tag: this.name,
        meta: { deviation_sigma: dev, sigma: sd, adx: adxV },
      });
    }
    if (dev >= k && reversingDn) {
      return makeSignal("sell", `VWAP fade short: ${dev.toFixed(1)}σ above VWAP, ADX ${adxV.toFixed(0)}`, Math.min(0.5 + (Math.abs(dev) - k) * 0.15, 0.85), s.ltp + stopSigma * sd, s.vwap, {
        tag: this.name,
        meta: { deviation_sigma: dev, sigma: sd, adx: adxV },
      });
    }
    return hold(`VWAP: ${dev.toFixed(2)}σ (trigger ${k.toFixed(1)}σ)`);
  }
}

export const LOCAL_STRATEGIES: Record<string, () => Strategy> = {
  orb: () => new OrbStrategy(),
  ema_cross: () => new EmaCrossStrategy(),
  supertrend_adx: () => new SupertrendAdxStrategy(),
  vwap_reversion: () => new VwapReversionStrategy(),
};

export function createLocalStrategy(name: string): Strategy {
  const make = LOCAL_STRATEGIES[name.toLowerCase()];
  if (!make) {
    throw new Error(`Strategy "${name}" local me nahi hai. Allowed: ${Object.keys(LOCAL_STRATEGIES).join(", ")}`);
  }
  return make();
}

void vwap;
void highs;
void lows;
void closes;
