/**
 * engine.ts — live trading engine ka loop.
 *
 * Ek cycle me:
 *   1. naya tick → candles update, broker ko price do (paper fills)
 *   2. position hai? → index SL / index target / premium disaster stop / max hold
 *      / strategy exit / MIS square-off → exit
 *   3. position nahi? → naya 5m bar bana? → strategy signal → AI gate → risk check
 *      → option leg choose → size → order → SL order (broker side safety)
 *   4. sab kuch journal + dashboard event
 *
 * Invariants (tode mat):
 *   * ek time pe ek hi position
 *   * ek time pe ek hi cycle (busy guard) — warna double order
 *   * options me sirf BUY leg (premium risk limited) aur ek hi side
 */

import { config } from "../config.ts";
import { orderCharges } from "../charges.ts";
import { round2, istParts } from "../util.ts";
import type { Clock } from "../market/clock.ts";
import { marketStatus, shouldSquareOff, withinEntryWindow, isTradingDay } from "../market/calendar.ts";
import { CandleStore } from "../market/candles.ts";
import { adx, atr, closes, highs, last, lows, supertrend, vwap, vwapBands, ema, rsi } from "../market/indicators.ts";
import { atmStrike, expiryDayLotFactor, indexMeta, nextExpiry, strikeFor } from "../market/instruments.ts";
import { deltaAt, estimatePremium, legAdjustment } from "../market/options.ts";
import type { Feed, OptionRef, Quote } from "../market/feed.ts";
import type { Broker, OrderResult } from "../broker/types.ts";
import { StrategyRunner } from "../strategy/index.ts";
import type { MarketState, Signal } from "../strategy/types.ts";
import { applyAiGate, type AiOutcome } from "../ai/gate.ts";
import { Journal, type TradeRecord } from "./journal.ts";
import { RiskManager, premiumMoveFor } from "./risk.ts";

export interface EngineDeps {
  clock: Clock;
  feed: Feed;
  broker: Broker;
  strategy: StrategyRunner;
  journal: Journal;
  emit: (type: string, payload: Record<string, unknown>) => void;
}

interface OpenTrade {
  id: string;
  symbol: string;
  index: string;
  optType: "CE" | "PE";
  strike: number;
  lots: number;
  qty: number;
  lotSize: number;
  entryPremium: number;
  entryIndex: number;
  entryTs: number;
  indexStop: number;
  indexTarget: number;
  premiumSafety: number;
  slOrderId?: string;
  tag: string;
  reason: string;
  confidence: number;
  ai?: AiOutcome;
  peakPremium: number;
  optionRef: OptionRef;
  delta: number;
}

export class Engine {
  private candles: CandleStore;
  private risk: RiskManager;
  private deps: EngineDeps;
  private open: OpenTrade | null = null;
  private prices = new Map<string, Quote>();
  private busy = false;
  private queued = false;
  private running = false;
  private seq = 0;
  private lastEvalBucket = 0;
  private lastSignal: Signal = { action: "hold", reason: "start", confidence: 0.5 };
  private lastAi: AiOutcome | undefined;
  private lastReject = "";
  private lastTickEmit = 0;
  private wins = 0;
  private losses = 0;
  private grossTotal = 0;
  private chargesTotal = 0;
  private equityCurve: number[] = [];
  private maxDD = 0;
  private peakEquity = 0;
  private dayStartEquity: number;
  private startedAt = Date.now();
  private strategySource: "python" | "local" = "local";
  private sessionClosed = false;
  private paused = false;
  private summaryWrittenFor = "";

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.candles = new CandleStore(["1m", "5m", "15m"]);
    this.risk = new RiskManager();
    this.dayStartEquity = this.risk.capital;
  }

  // ------------------------------------------------------------------ lifecycle
  async start(): Promise<void> {
    this.running = true;
    this.deps.feed.onTick((q) => this.handleTick(q));
    await this.deps.feed.start();
    this.deps.emit("status", { state: "running", mode: config.mode, broker: this.deps.broker.name });
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.deps.feed.stop();
    if (this.open) {
      await this.exitPosition("engine band ho raha hai (shutdown square-off)", this.deps.clock.now());
    }
    try {
      await this.deps.broker.squareOffAll?.();
    } catch (e) {
      console.warn(`[engine] squareOffAll fail: ${(e as Error).message}`);
    }
    this.writeDaySummary();
    this.deps.emit("status", { state: "stopped" });
  }

  // ------------------------------------------------------------------ ticks
  private handleTick(q: Quote): void {
    this.prices.set(q.symbol, q);
    // paper broker ko price do (fills + SL trigger ke liye)
    this.deps.broker.tick?.(q);

    const spotSymbol = this.deps.broker.quoteSymbolFor(config.market.symbol);
    const indexSymbol = this.deps.feed.indexQuote(config.market.symbol)?.symbol ?? spotSymbol;
    if (q.symbol === indexSymbol || q.symbol === spotSymbol || q.symbol === `${config.market.symbol}-SPOT`) {
      if (!this.candles.dayOpen) this.candles.dayOpen = q.ltp;
      this.candles.push(q.ts, q.ltp, q.volume ?? 0);
      this.deps.emit("tick", {
        ts: q.ts,
        ltp: q.ltp,
        bid: q.bid,
        ask: q.ask,
        vwap: this.vwapNow(),
        position: this.positionSnapshot(),
      });
    }
    // open position ka option premium update (paper fills + dashboard)
    if (this.open && q.symbol === indexSymbol) {
      const prem = this.premiumNow(this.open, q.ltp);
      if (prem !== null) this.pushOptionPrice(this.open.optionRef, q.ltp, prem);
    }

    void this.cycle();
  }

  private async cycle(): Promise<void> {
    if (!this.running) return;
    if (this.busy) {
      this.queued = true;
      return;
    }
    this.busy = true;
    try {
      const now = this.deps.clock.now();
      this.risk.rollDay(now);
      const status = marketStatus(now);

      // demo me virtual clock session ke andar hi chal raha hai (weekend/holiday ignore)
      const tradingAllowed = config.mode === "demo" ? true : status.open;
      const dayKey = istParts(now).dateKey;

      // kill switch
      if (this.risk.killSwitchActive()) {
        if (this.open) await this.exitPosition(`KILL switch (${config.killSwitchFile} file mili)`, now);
        this.deps.emit("status", { state: "killed", reason: "kill switch file" });
        return;
      }

      if (!tradingAllowed) {
        if (this.open) await this.exitPosition("market band ho gaya", now);
        this.deps.emit("status", { state: "marketClosed", phase: status.phase, minutesToClose: status.minutesToClose });
        return;
      }

      // MIS auto square-off
      if (shouldSquareOff(now)) {
        if (this.open) await this.exitPosition("square-off (MIS 15:15)", now);
        if (!this.sessionClosed) {
          this.sessionClosed = true;
          this.writeDaySummary();
          this.deps.emit("status", { state: "sessionClosed", dayKey });
        }
        return;
      }

      if (this.open) {
        await this.manageOpen(now);
      }

      // naya entry — naya 5m bar bana ho tab hi (candle-close decisions)
      if (this.paused) {
        this.lastReject = "dashboard se paused hai";
        return;
      }
      const bucket = Math.floor(now / 300_000);
      if (!this.open && bucket !== this.lastEvalBucket) {
        this.lastEvalBucket = bucket;
        await this.evaluateEntry(now);
      }
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`[engine] cycle error: ${msg}`);
      this.deps.emit("error", { where: "cycle", message: msg });
      this.deps.journal.event("error", { where: "cycle", message: msg });
    } finally {
      this.busy = false;
      if (this.queued) {
        this.queued = false;
        void this.cycle();
      }
    }
  }

  // ------------------------------------------------------------------ entry
  private async evaluateEntry(now: number): Promise<void> {
    const index = config.market.symbol;
    const ltp = this.candles.lastPrice;
    if (!ltp) return;

    const window = withinEntryWindow(now);
    if (!window.ok) {
      this.lastReject = window.reason;
      return;
    }

    const state = this.buildState(now, index, ltp);
    const { signal, source } = await this.deps.strategy.signal(state);
    this.strategySource = source;

    if (signal.action === "hold") {
      this.lastSignal = signal;
      this.deps.emit("signal", { action: "hold", reason: signal.reason, source, confidence: signal.confidence });
      return;
    }

    this.lastSignal = signal;
    this.deps.journal.event("signal", { action: signal.action, reason: signal.reason, confidence: signal.confidence, stop: signal.stop, target: signal.target, source });
    this.deps.emit("signal", { action: signal.action, reason: signal.reason, source, confidence: signal.confidence, stop: signal.stop, target: signal.target });

    // AI gate (off/veto/decide)
    const gated = await applyAiGate(state, signal);
    if (gated.ai) {
      this.lastAi = gated.ai;
      this.deps.journal.event("ai", { ...gated.ai, signalAction: signal.action });
      this.deps.emit("ai", { ...gated.ai });
    }
    const finalSignal = gated.signal;
    if (finalSignal.action === "hold" || finalSignal.action === "exit") {
      this.lastReject = finalSignal.reason;
      this.deps.emit("reject", { reason: finalSignal.reason, where: "ai-gate" });
      return;
    }

    await this.openPosition(now, index, ltp, finalSignal);
  }

  private async openPosition(now: number, index: string, ltp: number, signal: Signal): Promise<void> {
    const meta = indexMeta(index);
    const optType: "CE" | "PE" = signal.action === "buy" ? "CE" : "PE";
    const strike = strikeFor(index, ltp, optType, config.market.instrument);
    const exp = nextExpiry(index, new Date(now));
    const p = istParts(now);
    // fractional DTE (expiry day pe minutes ka fraction — sher ke liye)
    const dteDays = exp.daysToExpiry > 0 ? exp.daysToExpiry : Math.max((15 * 60 + 30 - p.minuteOfDay) / 375, 0.02);

    const optionRef: OptionRef = {
      symbol: `${index}${exp.code}${strike}${optType}`,
      index,
      strike,
      optType,
      expiryCode: exp.code,
      expiryDate: exp.dateKey,
      expiryWeekly: exp.weekly,
      dteDays,
    };

    // premium (feed → warna BS estimate)
    let premium = this.deps.feed.optionQuote(optionRef)?.ltp ?? 0;
    if (!premium || !Number.isFinite(premium)) premium = estimatePremium(index, ltp, strike, optType, dteDays);
    // paper broker ko price do (warna order fill nahi hoga)
    this.pushOptionPrice(optionRef, ltp, premium, dteDays);
    if (!Number.isFinite(premium) || premium <= 0) {
      this.lastReject = "premium nahi mila";
      return;
    }

    // risk plan: index SL → premium move
    const stop = signal.stop ?? (signal.action === "buy" ? ltp - this.atrDefault() : ltp + this.atrDefault());
    const indexRiskPoints = Math.abs(ltp - stop);
    const adj = legAdjustment(index, ltp, strike, optType, dteDays, indexRiskPoints);
    const premiumMove = premiumMoveFor(indexRiskPoints, adj.delta, premium);

    const check = this.risk.canEnter(now, { premium, minutesToClose: this.minutesToClose(now), lotSize: meta.lotSize });
    if (!check.ok) {
      this.lastReject = check.reason;
      this.deps.journal.event("reject", { reason: check.reason, where: "risk", signal: signal.reason });
      this.deps.emit("reject", { reason: check.reason, where: "risk" });
      return;
    }

    const sizing = this.risk.sizeLots({ premium, premiumMove, lotSize: meta.lotSize });
    if (sizing.lots < 1) {
      this.lastReject = sizing.note;
      this.deps.journal.event("reject", { reason: sizing.note, where: "sizing", signal: signal.reason });
      this.deps.emit("reject", { reason: sizing.note, where: "sizing" });
      return;
    }

    // expiry day pe lots kam karo (gamma risk)
    const factor = expiryDayLotFactor(now);
    const lots = Math.max(1, Math.floor(sizing.lots * factor));
    const qty = lots * meta.lotSize;

    const order = await this.placeOrder({
      index,
      symbol: optionRef.symbol,
      strike,
      optType,
      expiryCode: exp.code,
      expiryWeekly: exp.weekly,
      side: "buy",
      qty,
      orderType: "MARKET",
      tag: signal.tag || "entry",
    });
    if (!order || order.status === "REJECTED" || order.filledQty === 0) {
      const msg = order?.message ?? "order fill nahi hua";
      this.lastReject = msg;
      this.deps.journal.event("reject", { reason: msg, where: "order", symbol: optionRef.symbol });
      this.deps.emit("reject", { reason: msg, where: "order" });
      return;
    }

    const entryPremium = order.avgPrice > 0 ? order.avgPrice : premium;
    const entryCharges = order.charges ?? orderCharges({ broker: this.deps.broker.name, segment: "options", side: "buy", qty, price: entryPremium }).total;

    // premium disaster stop: index SL ke bahar bhi (IV crush / gap ke liye safety)
    const safetyPct = config.risk.premiumSafetyPct / 100;
    const premiumSafety = round2(
      Math.max(entryPremium * 0.05, entryPremium - Math.min(premiumMove * 1.6, entryPremium * safetyPct)),
    );

    const target = signal.target ?? (signal.action === "buy" ? ltp + indexRiskPoints * 2 : ltp - indexRiskPoints * 2);

    this.open = {
      id: `T${++this.seq}`,
      symbol: optionRef.symbol,
      index,
      optType,
      strike,
      lots,
      qty,
      lotSize: meta.lotSize,
      entryPremium,
      entryIndex: ltp,
      entryTs: now,
      indexStop: stop,
      indexTarget: target,
      premiumSafety,
      tag: signal.tag || this.deps.strategy.activeName,
      reason: signal.reason,
      confidence: signal.confidence,
      ai: gatedAi(signal),
      peakPremium: entryPremium,
      optionRef,
      delta: adj.delta,
    };
    this.deps.feed.watchOption(optionRef);

    // broker-side SL-M (disaster stop) — engine mar bhi jaye to broker band kar dega
    try {
      const sl = await this.deps.broker.placeOrder({
        index,
        symbol: optionRef.symbol,
        strike,
        optType,
        expiryCode: exp.code,
        expiryWeekly: exp.weekly,
        side: "sell",
        qty,
        orderType: "SL-M",
        triggerPrice: premiumSafety,
        tag: "sl",
      });
      this.open.slOrderId = sl.id;
    } catch (e) {
      console.warn(`[engine] broker-side SL order fail (engine khud monitor karega): ${(e as Error).message}`);
    }

    this.deps.journal.event("order", { side: "buy", symbol: optionRef.symbol, qty, price: entryPremium, charges: entryCharges, lots, orderId: order.id });
    console.log(
      `  ENTRY ${this.open.id} ${optType} ${strike} × ${lots}L (${qty}) @ ₹${entryPremium.toFixed(2)} | index ${ltp.toFixed(0)} SL ${stop.toFixed(0)} TGT ${target.toFixed(0)} | premium stop ₹${premiumSafety} | ${sizing.note}`,
    );
    this.deps.emit("position", { event: "open", ...this.positionSnapshot() });
  }

  // ------------------------------------------------------------------ manage / exit
  private async manageOpen(now: number): Promise<void> {
    const o = this.open!;
    const ltp = this.candles.lastPrice || o.entryIndex;
    const premium = this.premiumNow(o, ltp) ?? o.entryPremium;
    o.peakPremium = Math.max(o.peakPremium, premium);

    const long = o.entryIndex < o.indexTarget; // buy signal = index upar jaayega
    const hitIndexStop = long ? ltp <= o.indexStop : ltp >= o.indexStop;
    const hitIndexTarget = long ? ltp >= o.indexTarget : ltp <= o.indexTarget;
    const hitPremiumSafety = premium <= o.premiumSafety;

    if (hitIndexStop) return this.exitPosition(`index SL hit (${o.indexStop.toFixed(0)})`, now);
    if (hitPremiumSafety) return this.exitPosition(`premium disaster stop (₹${o.premiumSafety})`, now);
    if (hitIndexTarget) return this.exitPosition(`index target hit (${o.indexTarget.toFixed(0)})`, now);

    // trailing (1R ke baad SL ko breakeven pe)
    const riskPts = Math.abs(o.entryIndex - o.indexStop);
    if (long && ltp >= o.entryIndex + riskPts && o.indexStop < o.entryIndex) {
      o.indexStop = o.entryIndex; // breakeven
    } else if (!long && ltp <= o.entryIndex - riskPts && o.indexStop > o.entryIndex) {
      o.indexStop = o.entryIndex;
    }

    // max hold
    const heldMin = (now - o.entryTs) / 60_000;
    const maxHold = Math.min(this.minutesToClose(now) - 5, 120);
    if (heldMin >= maxHold) return this.exitPosition(`max hold ${Math.round(heldMin)} min`, now);

    // strategy ka apna exit (jaise VWAP touch)
    if (o.tag === this.deps.strategy.activeName) {
      const state = this.buildState(now, o.index, ltp);
      const { signal } = await this.deps.strategy.signal(state);
      if (signal.action === "exit") return this.exitPosition(signal.reason, now);
    }
  }

  private async exitPosition(reason: string, now: number): Promise<void> {
    const o = this.open;
    if (!o) return;
    const ltp = this.candles.lastPrice || o.entryIndex;
    this.open = null; // pehle clear (double exit na ho)

    if (o.slOrderId) {
      try {
        await this.deps.broker.cancelOrder(o.slOrderId);
      } catch {
        /* already triggered/closed */
      }
    }

    const order = await this.placeOrder({
      index: o.index,
      symbol: o.symbol,
      strike: o.strike,
      optType: o.optType,
      expiryCode: o.optionRef.expiryCode,
      expiryWeekly: o.optionRef.expiryWeekly,
      side: "sell",
      qty: o.qty,
      orderType: "MARKET",
      tag: "exit",
    });

    const exitPremium = order && order.filledQty > 0 ? order.avgPrice : (this.premiumNow(o, ltp) ?? o.entryPremium);
    const gross = round2((exitPremium - o.entryPremium) * o.qty);
    const charges = round2(
      (order?.charges ?? orderCharges({ broker: this.deps.broker.name, segment: "options", side: "sell", qty: o.qty, price: exitPremium }).total) +
        orderCharges({ broker: this.deps.broker.name, segment: "options", side: "buy", qty: o.qty, price: o.entryPremium }).total,
    );
    const net = round2(gross - charges);

    const rec: TradeRecord = {
      id: o.id,
      symbol: o.symbol,
      optType: o.optType,
      strike: o.strike,
      lots: o.lots,
      qty: o.qty,
      entryTs: o.entryTs,
      exitTs: now,
      entryPremium: o.entryPremium,
      exitPremium,
      entryIndex: o.entryIndex,
      exitIndex: ltp,
      indexStop: o.indexStop,
      indexTarget: o.indexTarget,
      gross,
      charges,
      net,
      reason,
      tag: o.tag,
      confidence: o.confidence,
      aiChoice: o.ai?.choice,
      holdMinutes: Math.round((now - o.entryTs) / 60_000),
    };
    this.deps.journal.recordTrade(rec);
    this.risk.recordTrade(net, gross, charges, now);
    this.grossTotal += gross;
    this.chargesTotal += charges;
    if (net >= 0) this.wins++;
    else this.losses++;

    const eq = this.risk.equity();
    this.equityCurve.push(eq);
    this.peakEquity = Math.max(this.peakEquity, eq);
    this.maxDD = Math.max(this.maxDD, this.peakEquity - eq);

    console.log(
      `  EXIT  ${o.id} ${o.optType} ${o.strike} × ${o.qty} @ ₹${exitPremium.toFixed(2)} (entry ₹${o.entryPremium.toFixed(2)}) | ${net >= 0 ? "+" : ""}₹${net.toFixed(0)} net (gross ₹${gross.toFixed(0)}, charges ₹${charges.toFixed(0)}) | ${rec.holdMinutes}m | ${reason}`,
    );
    this.deps.emit("trade", { ...rec, side: o.optType });
    this.deps.emit("position", { event: "close", ...this.positionSnapshot() });
  }

  // ------------------------------------------------------------------ helpers
  private atrDefault(): number {
    const h = highs(this.candles.series("5m"));
    const l = lows(this.candles.series("5m"));
    const c = closes(this.candles.series("5m"));
    const a = last(atr(h, l, c, 14));
    return a ?? Math.max(this.candles.lastPrice * 0.003, 10);
  }

  private minutesToClose(now: number): number {
    const p = istParts(now);
    return Math.max(0, 15 * 60 + 30 - p.minuteOfDay);
  }

  /** Option ka premium: feed quote → warna BS estimate. */
  private premiumNow(o: OpenTrade, indexLtp: number): number | null {
    const q = this.prices.get(o.symbol);
    if (q?.ltp && Number.isFinite(q.ltp)) return q.ltp;
    const feedQ = this.deps.feed.optionQuote(o.optionRef);
    if (feedQ?.ltp) return feedQ.ltp;
    const dte = Math.max(o.optionRef.dteDays - (this.deps.clock.now() - o.entryTs) / 86_400_000, 0.02);
    try {
      return estimatePremium(o.index, indexLtp, o.strike, o.optType, dte);
    } catch {
      return null;
    }
  }

  /** Paper/broker sim ke liye option ka current price push karo. */
  private pushOptionPrice(ref: OptionRef, indexLtp: number, premium?: number, dteDays?: number): void {
    const setPrice = (this.deps.broker as unknown as { setPrice?: (s: string, q: { ltp: number; bid: number; ask: number; ts: number }) => void }).setPrice;
    if (!setPrice) return;
    const px = premium ?? this.deps.feed.optionQuote(ref)?.ltp ?? estimatePremium(ref.index, indexLtp, ref.strike, ref.optType, dteDays ?? ref.dteDays);
    const half = Math.max(px * 0.004, 0.05);
    setPrice.call(this.deps.broker, ref.symbol, { ltp: px, bid: px - half, ask: px + half, ts: this.deps.clock.now() });
  }

  private vwapNow(): number | null {
    const bars = this.candles.series("1m");
    return bars.length ? vwap(bars) : null;
  }

  /** Order bhejo + fill ka wait (real broker me pending ho sakta hai). */
  private async placeOrder(req: Parameters<Broker["placeOrder"]>[0]): Promise<OrderResult | null> {
    try {
      let res = await this.deps.broker.placeOrder(req);
      if (res.filledQty > 0 || res.status === "REJECTED") return res;
      // fill ka intezaar: 6 × 400ms
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 400));
        const st = await this.deps.broker.orderStatus(res.id);
        if (!st) break;
        res = st;
        if (res.status === "COMPLETE" || res.status === "REJECTED" || res.status === "CANCELLED") break;
      }
      if (res.status !== "COMPLETE" && res.status !== "REJECTED" && res.status !== "CANCELLED") {
        // bina fill ke pending — cancel karo aur reject maano
        try {
          await this.deps.broker.cancelOrder(res.id);
        } catch {
          /* ignore */
        }
        return { ...res, status: "CANCELLED", message: "fill nahi hua (timeout) — cancel kiya" };
      }
      return res;
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`[engine] order fail: ${msg}`);
      this.deps.journal.event("error", { where: "order", message: msg, symbol: req.symbol });
      this.deps.emit("error", { where: "order", message: msg });
      return null;
    }
  }

  /** Dashboard/strategy ke liye poora market state. */
  buildState(now: number, index: string, ltp: number): MarketState {
    const bars: Record<string, { ts: number; open: number; high: number; low: number; close: number; volume: number }[]> = {};
    for (const tf of ["1m", "5m", "15m"]) {
      bars[tf] = this.candles.series(tf).slice(-120).map((b) => ({
        ts: b.ts,
        open: Number(b.open.toFixed(2)),
        high: Number(b.high.toFixed(2)),
        low: Number(b.low.toFixed(2)),
        close: Number(b.close.toFixed(2)),
        volume: b.volume,
      }));
    }
    const h5 = highs(this.candles.series("5m"));
    const l5 = lows(this.candles.series("5m"));
    const c5 = closes(this.candles.series("5m"));
    const a = last(atr(h5, l5, c5, 14));
    const adxV = last(adx(h5, l5, c5, 14).adx);
    const st = supertrend(h5, l5, c5, 10, 3);
    const vw = this.vwapNow();
    const { sigma } = vwapBands(this.candles.series("15m"), vw);
    const p = istParts(now);

    const idx = config.market.symbol;
    const exp = nextExpiry(idx, new Date(now));
    const atm = atmStrike(idx, ltp);

    return {
      symbol: idx,
      ts: now,
      ltp,
      bars,
      prevClose: this.candles.prevClose || null,
      dayOpen: this.candles.dayOpen || null,
      dayHigh: this.candles.dayHigh() || null,
      dayLow: this.candles.dayLow() || null,
      vwap: vw !== null ? Number(vw.toFixed(2)) : null,
      atr: a !== null ? Number(a.toFixed(2)) : null,
      adx: adxV !== null ? Number(adxV.toFixed(1)) : null,
      position: this.strategyPosition(),
      dayPnl: round2(this.risk.state.realizedToday),
      tradesToday: this.risk.state.tradesToday,
      consecutiveLosses: this.risk.state.consecutiveLosses,
      minutesToClose: this.minutesToClose(now),
      atmStrike: atm,
      iv: null,
      pcr: null,
      meta: {
        supertrendUp: st.up[st.up.length - 1] ?? null,
        vwapSigma: Number.isFinite(sigma) ? Number(sigma.toFixed(2)) : 0,
        minutesOfDay: p.minuteOfDay,
        expiry: exp.dateKey,
        expiryCode: exp.code,
        dteDays: exp.daysToExpiry,
        mode: config.mode,
        index,
        session: p.dateKey,
      },
    };
  }

  /**
   * Strategy ko dikhne wala position — Python contract (py/algo/types.py Position):
   * qty INDEX-side signed hoti hai (+ long / - short index), entry/stop/target index levels.
   * Dashboard ko `positionSnapshot()` milta hai (option qty/levels) — dono alag rakhe hain.
   */
  private strategyPosition(): MarketState["position"] {
    const o = this.open;
    if (!o) return null;
    const longIndex = o.optType === "CE";
    return {
      symbol: o.symbol,
      qty: longIndex ? o.lots : -o.lots,
      side: longIndex ? "long" : "short",
      entry: round2(o.entryIndex),
      stop: round2(o.indexStop),
      target: round2(o.indexTarget),
      openedTs: o.entryTs,
      tag: o.tag,
      optionSymbol: o.symbol,
      optionEntry: o.entryPremium,
      lots: o.lots,
    };
  }

  positionSnapshot(): Record<string, unknown> | null {
    const o = this.open;
    if (!o) return null;
    const ltp = this.candles.lastPrice || o.entryIndex;
    const premium = this.premiumNow(o, ltp) ?? o.entryPremium;
    return {
      id: o.id,
      symbol: o.symbol,
      qty: o.qty,
      side: "long",
      optType: o.optType,
      strike: o.strike,
      lots: o.lots,
      entry: o.entryPremium,
      optionEntry: o.entryPremium,
      optionSymbol: o.symbol,
      ltp: round2(premium),
      entryIndex: round2(o.entryIndex),
      indexStop: round2(o.indexStop),
      indexTarget: round2(o.indexTarget),
      premiumSafety: o.premiumSafety,
      stop: o.premiumSafety,
      target: round2(this.targetPremiumEstimate(o)),
      unrealized: round2((premium - o.entryPremium) * o.qty),
      pnlPct: round2(((premium - o.entryPremium) / o.entryPremium) * 100),
      openedTs: o.entryTs,
      holdMinutes: Math.round((this.deps.clock.now() - o.entryTs) / 60_000),
      tag: o.tag,
      reason: o.reason,
      confidence: o.confidence,
      delta: round2(o.delta),
      peakPremium: round2(o.peakPremium),
    };
  }

  private targetPremiumEstimate(o: OpenTrade): number {
    const move = Math.abs(o.indexTarget - o.entryIndex) * o.delta;
    return o.entryPremium + (o.indexTarget > o.entryIndex ? move : -move);
  }

  // ------------------------------------------------------------------ reporting
  snapshot(): Record<string, unknown> {
    const now = this.deps.clock.now();
    const status = marketStatus(now);
    const ltp = this.candles.lastPrice;
    const p = istParts(now);
    const trades = this.deps.journal.trades;
    const unrealized = Number(this.positionSnapshot()?.["unrealized"] ?? 0);

    return {
      mode: config.mode,
      broker: this.deps.broker.name,
      brokerSimulated: this.deps.broker.simulated,
      strategy: this.deps.strategy.activeName,
      strategyMode: config.strategy.mode,
      strategySource: this.strategySource,
      aiMode: config.ai.mode,
      aiProvider: config.ai.provider,
      product: config.broker.product,
      instrument: config.market.instrument,
      feed: this.deps.feed.source,
      clock: {
        ts: now,
        ist: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:${String(p.second).padStart(2, "0")}`,
        dateKey: p.dateKey,
        virtual: this.deps.clock.isVirtual(),
        speed: this.deps.clock.speed(),
        minuteOfDay: p.minuteOfDay,
      },
      market: {
        open: status.open,
        phase: status.phase,
        tradingDay: status.tradingDay,
        minutesToClose: status.minutesToClose,
        symbol: config.market.symbol,
        ltp: ltp ? round2(ltp) : null,
        vwap: this.vwapNow() !== null ? round2(this.vwapNow()!) : null,
        atr: this.atrDefault() ? round2(this.atrDefault()) : null,
        dayHigh: round2(this.candles.dayHigh()),
        dayLow: round2(this.candles.dayLow()),
        atmStrike: ltp ? atmStrike(config.market.symbol, ltp) : null,
        expiry: nextExpiry(config.market.symbol, new Date(now)).dateKey,
      },
      position: this.positionSnapshot(),
      lastSignal: this.lastSignal,
      lastAi: this.lastAi ?? null,
      lastReject: this.lastReject,
      risk: this.risk.snapshot(),
      stats: {
        trades: trades.length,
        wins: this.wins,
        losses: this.losses,
        winRate: trades.length ? round2((this.wins / trades.length) * 100) : 0,
        gross: round2(this.grossTotal),
        charges: round2(this.chargesTotal),
        net: round2(this.grossTotal - this.chargesTotal),
        equity: this.risk.equity(unrealized),
        maxDD: round2(this.maxDD),
        dayStartEquity: this.dayStartEquity,
        startedAt: this.startedAt,
      },
      curve: this.equityCurve.slice(-200),
      trades: trades.slice(-40).reverse(),
    };
  }

  writeDaySummary(force = false): void {
    const now = this.deps.clock.now();
    const day = istParts(now).dateKey;
    if (!force && this.summaryWrittenFor === day) return; // ek din me ek hi summary
    this.summaryWrittenFor = day;
    const trades = this.deps.journal.trades;
    const net = round2(this.grossTotal - this.chargesTotal);
    const summary = {
      date: day,
      mode: config.mode,
      broker: this.deps.broker.name,
      strategy: this.deps.strategy.activeName,
      trades: trades.length,
      wins: this.wins,
      losses: this.losses,
      winRate: trades.length ? round2((this.wins / trades.length) * 100) : 0,
      gross: round2(this.grossTotal),
      charges: round2(this.chargesTotal),
      net,
      equityEnd: this.risk.equity(),
      maxDD: round2(this.maxDD),
      riskHalted: this.risk.state.halted,
      haltReason: this.risk.state.haltReason,
    };
    this.deps.journal.writeDailySummary(summary);
    this.deps.journal.sessionSnapshot(day, { summary, trades: trades.slice(-50), snapshot: this.snapshot() });
    this.deps.emit("daySummary", summary);
    console.log(
      `\n  DAY SUMMARY ${day}: ${summary.trades} trades · ${summary.wins}W/${summary.losses}L · net ₹${net.toFixed(0)} · charges ₹${summary.charges.toFixed(0)} · equity ₹${summary.equityEnd.toFixed(0)}`,
    );
  }

  /** Demo mode me naya virtual din shuru karo. */
  resetForNewDay(): void {
    this.open = null;
    this.candles = new CandleStore(["1m", "5m", "15m"]);
    this.risk.rollDay(this.deps.clock.now());
    this.deps.strategy.resetDay();
    this.lastEvalBucket = 0;
    this.sessionClosed = false;
    this.summaryWrittenFor = "";
    this.wins = 0;
    this.losses = 0;
    this.grossTotal = 0;
    this.chargesTotal = 0;
    this.equityCurve = [];
    this.maxDD = 0;
    this.startedAt = Date.now();
    this.dayStartEquity = this.risk.capital;
  }

  get hasPosition(): boolean {
    return this.open !== null;
  }

  /** Dashboard commands. */
  setPaused(v: boolean): void {
    this.paused = v;
    this.deps.emit("status", { state: v ? "paused" : "running" });
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Manual square-off (dashboard button / emergency). */
  async squareOffNow(reason = "manual square-off (dashboard)"): Promise<void> {
    if (this.open) await this.exitPosition(reason, this.deps.clock.now());
    else await this.deps.broker.squareOffAll?.();
  }

  /** Virtual clock ka current time (index.ts ke demo-day loop ke liye). */
  clockNow(): number {
    return this.deps.clock.now();
  }

  /** Demo loop: naya virtual din shuru. */
  beginNewDay(): void {
    this.resetForNewDay();
    this.deps.emit("status", { state: "newDay", dayKey: istParts(this.deps.clock.now()).dateKey });
  }

  isTradingDayNow(): boolean {
    return isTradingDay(this.deps.clock.now());
  }
}

void ema;
void rsi;

function gatedAi(signal: Signal): AiOutcome | undefined {
  const meta = signal.meta?.["ai"];
  return (meta as AiOutcome | undefined) ?? undefined;
}
