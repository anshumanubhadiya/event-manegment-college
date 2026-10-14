/**
 * run.ts — TS self tests (npm test). Zero deps, simple assertions.
 *
 * Ye un cheezon ko check karta hai jo live trading me paisa bacha sakti hain:
 * option pricing, charges, candles, expiry, risk sizing, paper broker, strategy signals.
 */

import { strict as assert } from "node:assert";
import { config } from "../config.ts";
import { breakevenPoints, costPctOfPremium, orderCharges, roundTripCharges } from "../charges.ts";
import { bsGreeks, bsPrice, deltaAt, estimatePremium, impliedVol, skewedIv } from "../market/options.ts";
import { atmStrike, indexMeta, nextExpiry, strikeFor } from "../market/instruments.ts";
import { CandleStore } from "../market/candles.ts";
import { adx, atr, ema, rsi, supertrend, vwap } from "../market/indicators.ts";
import { marketStatus, SESSION } from "../market/calendar.ts";
import { RiskManager, premiumMoveFor } from "../engine/risk.ts";
import { PaperBroker } from "../broker/paper.ts";
import { createLocalStrategy } from "../strategy/local.ts";
import { hhmmToMinutes, istEpoch, istParts } from "../util.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void | Promise<void>): void {
  if (fn.constructor.name === "AsyncFunction") {
    // async — queue karo (main me await hoga)
    pending.push(
      (async () => {
        try {
          await fn();
          passed++;
          console.log(`  \x1b[32m✓\x1b[0m ${name}`);
        } catch (e) {
          failed++;
          failures.push(`${name}: ${(e as Error).message}`);
          console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${(e as Error).message}`);
        }
      })(),
    );
    return;
  }
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    failures.push(`${name}: ${(e as Error).message}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${(e as Error).message}`);
  }
}
const pending: Promise<void>[] = [];

function section(t: string): void {
  console.log(`\n\x1b[36m${t}\x1b[0m`);
}

const near = (a: number, b: number, tol: number, msg = ""): void => {
  assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} ≈ ${b} (±${tol}) nahi hai`);
};

async function main(): Promise<void> {
  console.log("\x1b[36mAlgo India — TS self tests\x1b[0m");

  section("Option pricing (Black-Scholes)");
  test("put-call parity C - P = S - K·e^-rt", () => {
    const S = 25000;
    const K = 25000;
    const dte = 7; // din
    const v = 0.13;
    const r = 0.065;
    const c = bsPrice(S, K, dte, v, "CE");
    const p = bsPrice(S, K, dte, v, "PE");
    near(c - p, S - K * Math.exp((-r * dte) / 365), 1.5, "parity");
  });
  test("ATM delta ≈ 0.5, theta negative, gamma/vega positive", () => {
    const g = bsGreeks(25000, 25000, 7, 0.13, "CE");
    near(Math.abs(g.delta), 0.5, 0.08);
    assert.ok(g.theta < 0, "theta negative hona chahiye");
    assert.ok(g.gamma > 0 && g.vega > 0, "gamma/vega positive");
  });
  test("IV round trip", () => {
    const price = bsPrice(25000, 25200, 5, 0.18, "CE");
    const iv = impliedVol(price, 25000, 25200, 5, "CE");
    assert.ok(iv !== null);
    near(iv as number, 0.18, 0.02, "IV");
  });
  test("deep OTM premium < ATM premium; put side IV zyada (skew)", () => {
    const atm = estimatePremium("NIFTY", 25000, 25000, "CE", 2);
    const far = estimatePremium("NIFTY", 25000, 26000, "CE", 2);
    assert.ok(far < atm, "OTM premium chhota hona chahiye");
    assert.ok(skewedIv("NIFTY", 25000, 24500, 2, "PE") > skewedIv("NIFTY", 25000, 25000, 2, "CE"), "put skew");
  });
  test("deltaAt sanity (ATM 0.4-0.7)", () => {
    const d = deltaAt(25000, 25000, "CE", 7);
    assert.ok(d > 0.4 && d < 0.7, `delta ${d}`);
  });
  test("premiumMoveFor: index SL → premium move (py cap/floor ke saath)", () => {
    near(premiumMoveFor(60, 0.5), 30, 0.01, "50 delta (bina premium — raw)");
    near(premiumMoveFor(60, 0.5, 100), 30, 0.01, "premium ₹100 pe cap 30% = ₹30");
    near(premiumMoveFor(60, 0.5, 400), 48, 0.01, "premium ₹400 pe floor 12% = ₹48 (raw ₹30 se upar)");
    near(premiumMoveFor(20, 0.05, 100), 12, 0.01, "chhota move floor 12% of ₹100 pe aata hai");
    near(premiumMoveFor(60, 0, 200), 30, 0.01, "delta missing → 0.5 maana jaata hai (cap ₹60 ke andar)");
  });

  section("Instruments & expiry");
  test("strike selection CE/PE + moneyness", () => {
    assert.equal(strikeFor("NIFTY", 25237, "CE", "ATM"), 25250);
    assert.equal(strikeFor("NIFTY", 25237, "CE", "OTM1"), 25300);
    assert.equal(strikeFor("NIFTY", 25237, "CE", "OTM2"), 25350);
    assert.equal(strikeFor("NIFTY", 25237, "CE", "ITM1"), 25200);
    assert.equal(strikeFor("NIFTY", 25237, "PE", "OTM1"), 25200);
    assert.equal(strikeFor("NIFTY", 25237, "PE", "ITM1"), 25300);
    assert.equal(atmStrike("SENSEX", 72543), 72500);
  });
  test("lot sizes + expiry weekday sahi", () => {
    assert.equal(indexMeta("NIFTY").lotSize, 75);
    assert.equal(indexMeta("BANKNIFTY").lotSize, 35);
    assert.equal(indexMeta("SENSEX").lotSize, 20);
    const wed = new Date(istEpoch(10, 0, istEpoch(9, 15) + 2 * 86_400_000)); // +2 din
    const n = nextExpiry("NIFTY", wed);
    assert.ok(n.daysToExpiry >= 0 && n.daysToExpiry <= 7, `NIFTY dte ${n.daysToExpiry}`);
    const b = nextExpiry("BANKNIFTY", wed);
    assert.ok(b.daysToExpiry >= 0 && b.daysToExpiry <= 31, `BANKNIFTY monthly dte ${b.daysToExpiry}`);
    assert.ok(/^\d{2}([A-Z]{3}|\d{4})$/.test(n.code), `expiry code ${n.code}`);
  });

  section("Charges (Indian brokers)");
  test("options buy pe STT 0, sell pe 0.1%", () => {
    const buy = orderCharges({ broker: "zerodha", segment: "options", side: "buy", qty: 75, price: 120 });
    const sell = orderCharges({ broker: "zerodha", segment: "options", side: "sell", qty: 75, price: 120 });
    assert.equal(buy.stt, 0);
    near(sell.stt, 75 * 120 * 0.001, 0.01);
    near(buy.brokerage, 20, 0.01);
  });
  test("round trip = 2 orders + taxes", () => {
    const c = roundTripCharges({ broker: "zerodha", qty: 75, entry: 120, exit: 145 });
    assert.ok(c.total > 40 && c.total < 120, `round trip ${c.total} range me nahi`);
    assert.ok(c.gst > 0 && c.stamp > 0);
  });
  test("sasta premium = bada % drag; breakeven points", () => {
    assert.ok(costPctOfPremium("zerodha", 75, 25) > costPctOfPremium("zerodha", 75, 300));
    assert.ok(breakevenPoints("zerodha", 75, 120) > 0.5);
  });
  test("saare brokers ka charge model chalta hai", () => {
    for (const b of ["zerodha", "angel", "fyers", "upstox", "dhan", "paper"]) {
      assert.ok(roundTripCharges({ broker: b, qty: 75, entry: 100, exit: 100 }).total > 0, b);
    }
  });

  section("Candles & calendar");
  test("tick se 1m/5m/15m candles bante hain", () => {
    const store = new CandleStore(["1m", "5m", "15m"]);
    const start = istEpoch(9, 15);
    for (let m = 0; m < 30; m++) {
      for (let k = 0; k < 3; k++) store.push(start + m * 60_000 + k * 20_000, 25000 + m + k, 100);
    }
    assert.equal(store.closedBars("1m").length, 29, "29 candles close honi chahiye (30th abhi ban rahi hai)");
    assert.ok(store.closedBars("5m").length >= 5, "5m candles");
    assert.ok(store.closedBars("15m").length >= 1, "15m candle");
    near(store.closedBars("5m")[0]!.open, 25000, 0.001, "first 5m open");
    assert.equal(store.sessionKey, istParts(start).dateKey);
    assert.equal(store.dayOpen, 25000);
  });
  test("session times IST me sahi", () => {
    const t = istEpoch(9, 15);
    assert.equal(istParts(t).minuteOfDay, 555);
    assert.equal(hhmmToMinutes("09:15"), 555);
    assert.equal(marketStatus(t).open, true);
    assert.equal(marketStatus(t).minutesToClose, SESSION.close - 555);
    const weekend = istEpoch(11, 0, istEpoch(9, 15) + (6 - istParts(t).weekday + 7) % 7 * 86_400_000);
    void weekend;
    const night = istEpoch(22, 0);
    assert.equal(marketStatus(night).open, false);
  });

  section("Indicators");
  test("EMA known values", () => {
    const e = ema([1, 2, 3, 4, 5, 6], 3);
    near(e[2] as number, 2, 1e-9);
    near(e[3] as number, 3, 1e-9);
    near(e[5] as number, 5, 1e-9);
  });
  test("RSI extremes (sirf up = ~100, sirf down = ~0)", () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    const down = Array.from({ length: 40 }, (_, i) => 140 - i);
    assert.ok((rsi(up, 14)[39] as number) > 95);
    assert.ok((rsi(down, 14)[39] as number) < 5);
  });
  test("ATR positive, ADX 0..100", () => {
    const { h, l, c } = fakeBars(60);
    assert.ok((atr(h, l, c, 14)[59] as number) > 0);
    const a = adx(h, l, c, 14).adx[59];
    if (a !== null && a !== undefined) assert.ok(a >= 0 && a <= 100);
  });
  test("supertrend line dono direction me jaata hai", () => {
    const { h, l, c } = fakeBars(160);
    const st = supertrend(h, l, c, 10, 3);
    assert.ok(st.up.some((x) => x) && st.up.some((x) => !x));
  });
  test("VWAP high/low ke beech hota hai", () => {
    const { h, l, c, v } = fakeBars(50);
    const candles = c.map((close, i) => ({ ts: i, open: close, high: h[i]!, low: l[i]!, close, volume: v[i]! }));
    const w = vwap(candles);
    assert.ok(w !== null && w >= Math.min(...l) - 5 && w <= Math.max(...h) + 5);
  });

  section("Risk manager");
  test("sizing: risk budget se zyada nahi, min 1 lot rule", () => {
    const rm = new RiskManager(200_000);
    const s = rm.sizeLots({ premium: 120, premiumMove: 30, lotSize: 75 }); // risk/lot 2250, budget 2000
    assert.equal(s.lots, 1, "1 lot allow hona chahiye (3% cap ke andar)");
    const s2 = rm.sizeLots({ premium: 500, premiumMove: 60, lotSize: 75 }); // 4500 (2.25%)
    assert.equal(s2.lots, 1);
    const s3 = rm.sizeLots({ premium: 2000, premiumMove: 250, lotSize: 75 }); // 18750 > 3% -> skip
    assert.equal(s3.lots, 0, "bahut bada risk skip hona chahiye");
  });
  test("min premium check", () => {
    const rm = new RiskManager(200_000);
    const r = rm.canEnter(Date.now(), { premium: 12, minutesToClose: 200, lotSize: 75 });
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes("MIN_PREMIUM"), r.reason);
  });
  test("daily loss limit pe halt", () => {
    const rm = new RiskManager(200_000);
    rm.recordTrade(-4200, -4150, 50, Date.now()); // 2.1% > 2%
    const r = rm.canEnter(Date.now(), { premium: 200, minutesToClose: 200, lotSize: 75 });
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes("loss limit"), r.reason);
  });
  test("consecutive losses pe halt + cooldown", () => {
    const rm = new RiskManager(200_000);
    rm.recordTrade(-100, -95, 5, Date.now());
    const r = rm.canEnter(Date.now(), { premium: 200, minutesToClose: 200, lotSize: 75 });
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes("cooldown"), r.reason);
  });
  test("max trades/day", () => {
    const rm = new RiskManager(200_000);
    for (let i = 0; i < config.risk.maxTradesPerDay; i++) rm.recordTrade(100, 105, 5, Date.now());
    const r = rm.canEnter(Date.now(), { premium: 200, minutesToClose: 200, lotSize: 75 });
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes("max trades"), r.reason);
  });

  section("Paper broker");
  test("buy/sell se cash, position aur charges sahi", async () => {
    const pb = new PaperBroker(200_000);
    await pb.init();
    pb.setPrice("NIFTY-TEST-PE", { ltp: 150 });
    const o1 = await pb.placeOrder({
      index: "NIFTY", symbol: "NIFTY-TEST-PE", strike: 25000, optType: "PE", expiryCode: "26FEB", expiryWeekly: false,
      side: "buy", qty: 75, orderType: "MARKET", tag: "t1",
    });
    assert.equal(o1.status, "COMPLETE");
    assert.ok(o1.avgPrice > 150, "buy slippage upar");
    assert.equal((await pb.positions())[0]!.qty, 75);
    pb.setPrice("NIFTY-TEST-PE", { ltp: 180 });
    const o2 = await pb.placeOrder({
      index: "NIFTY", symbol: "NIFTY-TEST-PE", strike: 25000, optType: "PE", expiryCode: "26FEB", expiryWeekly: false,
      side: "sell", qty: 75, orderType: "MARKET", tag: "t2",
    });
    assert.ok(o2.avgPrice < 180, "sell slippage neeche");
    const m = await pb.margins();
    assert.ok(m.cash > 200_000, `profit ke baad cash badhna chahiye, mila ${m.cash}`);
    assert.ok(pb.stats().charges > 40, "charges lagne chahiye");
    assert.equal((await pb.positions()).length, 0, "position band ho gayi");
  });
  test("cash kam ho to order reject hota hai", async () => {
    const pb = new PaperBroker(1000);
    await pb.init();
    pb.setPrice("X-CE", { ltp: 200 });
    const o = await pb.placeOrder({
      index: "NIFTY", symbol: "X-CE", strike: 25000, optType: "CE", expiryCode: "26FEB", expiryWeekly: false,
      side: "buy", qty: 75, orderType: "MARKET",
    });
    assert.equal(o.status, "REJECTED");
  });

  section("Strategies (TS local ports)");
  test("saari strategies load ho jaati hain", () => {
    for (const name of ["orb", "ema_cross", "supertrend_adx", "vwap_reversion"]) {
      const s = createLocalStrategy(name);
      assert.equal(s.name, name);
      assert.ok(s.timeframes.length > 0);
      assert.ok(s.warmup() > 0);
    }
  });
  test("ORB opening range poora hone se pehle signal nahi deta", () => {
    const s = createLocalStrategy("orb");
    const sig = s.onState(orbState(9, 20, 25000) as never);
    assert.equal(sig.action, "hold");
    assert.ok(/opening range/i.test(sig.reason), sig.reason);
  });
  test("ORB: OR set hone ke baad breakout pe buy/sell", () => {
    const s = createLocalStrategy("orb");
    const setup = s.onState(orbState(9, 35, 25010) as never);
    assert.equal(setup.action, "hold", `setup ke baad hold aana chahiye, mila ${setup.action}`);
    assert.ok(/OR set/.test(setup.reason), setup.reason);
    const sig = s.onState(orbState(9, 40, 25051) as never);
    assert.equal(sig.action, "buy", `breakout pe buy chahiye, mila ${sig.action} (${sig.reason})`);
    assert.ok((sig.stop as number) < 25051 && (sig.target as number) > 25051);
    const s2 = createLocalStrategy("orb");
    s2.onState(orbState(9, 35, 25010) as never);
    const dn = s2.onState(orbState(9, 40, 24969) as never);
    assert.equal(dn.action, "sell", `breakdown pe sell chahiye, mila ${dn.action} (${dn.reason})`);
  });
  test("VWAP reversion sirf range regime me fade karta hai", () => {
    const s = createLocalStrategy("vwap_reversion");
    const st = orbState(13, 0, 25160) as Record<string, unknown>;
    const bars5: Array<Record<string, number>> = [];
    const dayStart = istEpoch(9, 15);
    for (let i = 0; i < 48; i++) {
      const base = 25000 + (i < 10 ? i * 2 : 20 - (i - 10) * 0.4);
      bars5.push({ ts: dayStart + i * 5 * 60_000, open: base, high: base + 8, low: base - 8, close: base, volume: 5000 });
    }
    st["bars"] = { "1m": st["bars"] ? (st["bars"] as Record<string, unknown>)["1m"] : [], "5m": bars5, "15m": [] };
    st["vwap"] = 25005;
    st["adx"] = 30; // trend regime — yahan fade nahi karna chahiye
    const sig = s.onState(st as never);
    assert.equal(sig.action, "hold", `trend regime me hold chahiye, mila ${sig.action}: ${sig.reason}`);
    assert.ok(/trend|regime/i.test(sig.reason), sig.reason);
  });

  await Promise.all(pending);

  console.log(`\n\x1b[36m${passed} passed, ${failed} failed\x1b[0m`);
  if (failed) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- helpers
function fakeBars(n: number, seed = 7): { h: number[]; l: number[]; c: number[]; v: number[] } {
  const h: number[] = [];
  const l: number[] = [];
  const c: number[] = [];
  const v: number[] = [];
  let price = 25000;
  let s = seed;
  const rnd = (): number => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  for (let i = 0; i < n; i++) {
    const drift = (rnd() - 0.5) * 40 + (i % 17 === 0 ? 25 : -3);
    const open = price;
    price = Math.max(100, open + drift);
    h.push(Math.max(open, price) + rnd() * 8);
    l.push(Math.min(open, price) - rnd() * 8);
    c.push(price);
    v.push(1000 + rnd() * 500);
  }
  return { h, l, c, v };
}

/** ORB test ke liye synthetic state — 09:15-09:30 ka OR 24980-25040. */
function orbState(hour: number, minute: number, ltp: number, orLow = 24980, orHigh = 25040): Record<string, unknown> {
  const dayStart = istEpoch(9, 15);
  const bars1: Array<Record<string, number>> = [];
  for (let i = 0; i < 15; i++) {
    const high = i === 5 ? orHigh : orLow + 10 + i;
    const low = i === 2 ? orLow : orHigh - 15 - i;
    bars1.push({ ts: dayStart + i * 60_000, open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 1000 });
  }
  const nowTs = istEpoch(hour, minute);
  const nBars = Math.max(1, Math.floor((nowTs - dayStart) / 60_000));
  for (let i = 15; i <= nBars; i++) {
    bars1.push({ ts: dayStart + i * 60_000, open: ltp, high: ltp + 4, low: ltp - 4, close: ltp, volume: 900 });
  }
  const bars5 = bars1.filter((_, i) => i % 5 === 0);
  return {
    symbol: "NIFTY",
    ts: nowTs,
    ltp,
    bars: { "1m": bars1, "5m": bars5, "15m": [bars1[0]] },
    prevClose: 25000,
    dayOpen: 25000,
    dayHigh: Math.max(ltp, orHigh),
    dayLow: Math.min(ltp, orLow),
    vwap: 25010,
    atr: 22,
    adx: 20,
    position: null,
    dayPnl: 0,
    tradesToday: 0,
    consecutiveLosses: 0,
    minutesToClose: 930 - (hour * 60 + minute),
    atmStrike: 25000,
    meta: {},
  };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
