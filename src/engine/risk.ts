/**
 * risk.ts — Risk manager. Ye engine ka brake hai — strategy signal deti hai,
 * par paisa risk manager ke rules se lagta hai.
 *
 * Rules (sab config se):
 *   * per-trade risk = CAPITAL × RISK_PCT (index SL distance × delta se premium move)
 *   * max lots, max trades/day, entry window, min premium
 *   * daily loss limit → din band
 *   * consecutive losses → halt, cooldown after a loss
 *   * kill switch file → turant square-off
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.ts";
import { clamp, istParts, round2 } from "../util.ts";

export interface RiskState {
  dayKey: string;
  tradesToday: number;
  realizedToday: number;
  grossToday: number;
  chargesToday: number;
  consecutiveLosses: number;
  lastLossTs: number | null;
  halted: boolean;
  haltReason: string;
}

export interface EntryCheck {
  ok: boolean;
  reason: string;
  lots: number;
  riskPerLot: number;
  premiumMove: number;
}

export class RiskManager {
  state: RiskState;
  readonly capital: number;

  constructor(capital = config.risk.capital) {
    this.capital = capital;
    this.state = {
      dayKey: istParts(Date.now()).dateKey,
      tradesToday: 0,
      realizedToday: 0,
      grossToday: 0,
      chargesToday: 0,
      consecutiveLosses: 0,
      lastLossTs: null,
      halted: false,
      haltReason: "",
    };
  }

  /** Naya din — counters reset (cooldown/halt bhi). */
  rollDay(ts: number): void {
    const key = istParts(ts).dateKey;
    if (key === this.state.dayKey) return;
    this.state = {
      dayKey: key,
      tradesToday: 0,
      realizedToday: 0,
      grossToday: 0,
      chargesToday: 0,
      consecutiveLosses: 0,
      lastLossTs: null,
      halted: false,
      haltReason: "",
    };
  }

  /** Kill switch — KILL file mili to sab band. */
  killSwitchActive(): boolean {
    const p = resolve(process.cwd(), config.killSwitchFile);
    return existsSync(p);
  }

  /** Kitne lots? risk budget / (premium move × lot size). */
  sizeLots(opts: {
    premium: number;
    premiumMove: number; // index SL distance ka premium equivalent
    lotSize: number;
    minOneLot?: boolean;
  }): { lots: number; riskPerLot: number; note: string } {
    const budget = (this.capital * config.risk.riskPct) / 100;
    const perLot = Math.max(opts.premiumMove, 0.5) * opts.lotSize;
    let lots = Math.floor(budget / perLot);
    const maxAffordable = Math.floor((this.capital * 0.5) / (opts.premium * opts.lotSize));
    lots = Math.min(lots, config.risk.maxLots, Math.max(maxAffordable, 0));

    if (lots < 1) {
      // min-one-lot rule: retail reality — 1 lot ka risk chhote account ke liye
      // risk_pct se zyada hota hai; allow karo agar hard cap ke andar hai
      const hardCap = (this.capital * config.risk.maxSingleLotRiskPct) / 100;
      if (perLot <= hardCap && config.risk.minOneLot && opts.minOneLot !== false && maxAffordable >= 1) {
        return {
          lots: 1,
          riskPerLot: round2(perLot),
          note: `1 lot (min-one-lot: risk/lot ₹${Math.round(perLot)} ≤ ${config.risk.maxSingleLotRiskPct}% cap)`,
        };
      }
      return { lots: 0, riskPerLot: round2(perLot), note: `risk/lot ₹${Math.round(perLot)} bahut bada — skip` };
    }
    return { lots, riskPerLot: round2(perLot), note: `risk ₹${Math.round(perLot * lots)} (${((perLot * lots * 100) / this.capital).toFixed(2)}% capital)` };
  }

  /** Entry allowed? */
  canEnter(ts: number, opts: { premium: number; minutesToClose: number; lotSize: number }): EntryCheck {
    const s = this.state;
    const fail = (reason: string): EntryCheck => ({ ok: false, reason, lots: 0, riskPerLot: 0, premiumMove: 0 });

    if (this.killSwitchActive()) return fail(`KILL switch file mili (${config.killSwitchFile}) — engine band`);
    if (s.halted) return fail(`din halt hai: ${s.haltReason}`);
    if (opts.minutesToClose < 20) return fail(`market close ke paas (${opts.minutesToClose} min) — naya entry nahi`);
    if (s.tradesToday >= config.risk.maxTradesPerDay) return fail(`max trades/day (${config.risk.maxTradesPerDay}) ho gaye`);

    const dailyLossLimit = -(this.capital * config.risk.dailyLossPct) / 100;
    if (s.realizedToday <= dailyLossLimit) {
      s.halted = true;
      s.haltReason = `daily loss limit hit (₹${Math.round(s.realizedToday)})`;
      return fail(s.haltReason);
    }

    if (s.consecutiveLosses >= config.risk.maxConsecLosses) {
      s.halted = true;
      s.haltReason = `${s.consecutiveLosses} lagatar loss`;
      return fail(s.haltReason);
    }

    if (s.lastLossTs && s.consecutiveLosses > 0) {
      const cooldownLeft = config.risk.cooldownMinutes * 60_000 - (ts - s.lastLossTs);
      if (cooldownLeft > 0) return fail(`cooldown chal raha hai (${Math.ceil(cooldownLeft / 60_000)} min baaki)`);
    }

    if (opts.premium < config.risk.minPremium) {
      return fail(`premium ₹${opts.premium.toFixed(1)} < MIN_PREMIUM ₹${config.risk.minPremium} (charges kha jayenge)`);
    }
    return { ok: true, reason: "ok", lots: 0, riskPerLot: 0, premiumMove: 0 };
  }

  /** Trade band hone pe counters update. */
  recordTrade(netPnl: number, gross: number, charges: number, ts: number): void {
    const s = this.state;
    s.tradesToday += 1;
    s.realizedToday += netPnl;
    s.grossToday += gross;
    s.chargesToday += charges;
    if (netPnl < 0) {
      s.consecutiveLosses += 1;
      s.lastLossTs = ts;
    } else {
      s.consecutiveLosses = 0;
    }
    if (s.consecutiveLosses >= config.risk.maxConsecLosses) {
      s.halted = true;
      s.haltReason = `${s.consecutiveLosses} lagatar loss`;
    }
    const dailyLossLimit = -(this.capital * config.risk.dailyLossPct) / 100;
    if (s.realizedToday <= dailyLossLimit) {
      s.halted = true;
      s.haltReason = `daily loss limit hit (₹${Math.round(s.realizedToday)})`;
    }
  }

  /** Equity = capital + realized + unrealized. */
  equity(unrealized = 0): number {
    return round2(this.capital + this.state.realizedToday + unrealized);
  }

  snapshot(): Record<string, unknown> {
    return {
      capital: this.capital,
      dayKey: this.state.dayKey,
      tradesToday: this.state.tradesToday,
      maxTradesPerDay: config.risk.maxTradesPerDay,
      realizedToday: round2(this.state.realizedToday),
      grossToday: round2(this.state.grossToday),
      chargesToday: round2(this.state.chargesToday),
      consecutiveLosses: this.state.consecutiveLosses,
      halted: this.state.halted,
      haltReason: this.state.haltReason,
      dailyLossLimit: round2(-(this.capital * config.risk.dailyLossPct) / 100),
      riskPerTrade: round2((this.capital * config.risk.riskPct) / 100),
      equity: this.equity(),
      cooldownMinutes: config.risk.cooldownMinutes,
      killSwitch: this.killSwitchActive(),
    };
  }
}

/**
 * Index SL distance → option premium move (delta ke through). Python `premium_move()`
 * ka exact port:
 *   move = index SL distance × delta        (delta missing → 0.5)
 *   phir premium ke % me cap (PREMIUM_SL_CAP_PCT, default 30%) aur
 *   floor (PREMIUM_SL_FLOOR_PCT, default 12%) lagta hai — 0DTE me index SL
 *   bahut bada ho jata hai aur premium-based SL realistic rakhna hai.
 */
export function premiumMoveFor(indexRiskPoints: number, delta: number, premium?: number): number {
  const d = Math.abs(delta) > 0.001 ? Math.abs(delta) : 0.5;
  const move = Math.abs(indexRiskPoints) * d;
  if (!premium || premium <= 0) return move;
  const cap = (premium * config.risk.premiumSlCapPct) / 100;
  const floor = (premium * config.risk.premiumSlFloorPct) / 100;
  return Math.min(Math.max(move, floor), cap);
}
