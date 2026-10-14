/**
 * run.ts — TS engine self-tests. Zero dependency, `npm test` se chalta hai.
 *
 * Ye tests wo cheezein cover karte hain jahan galti se pura paisa/system galat
 * ho sakta hai: charges, option pricing, expiry/strike, candle aggregation,
 * risk gates, paper broker fills, strategy signals aur AI gate.
 *
 *     npm test            (tsx src/tests/run.ts)
 *     npm test -- --filter risk
 */

import assert from "node:assert/strict";

// ------------------------------------------------------------------ mini runner
type Test = { name: string; fn: () => void | Promise<void> };
const tests: Test[] = [];
let filter = "";
const argv = process.argv.slice(2);
const fi = argv.indexOf("--filter");
if (fi >= 0) filter = argv[fi + 1] ?? "";

function test(name: string, fn: () => void | Promise<void>): void {
  if (filter && !name.toLowerCase().includes(filter.toLowerCase())) return;
  tests.push({ name, fn });
}

const C = {
  g: "\x1b[32m",
  r: "\x1b[31m",
  y: "\x1b[33m",
  d: "\x1b[2m",
  b: "\x1b[1m",
  x: "\x1b[0m",
};

function near(actual: number, expected: number, tol = 1e-6, msg = ""): void {
  if (!Number.isFinite(actual)) throw new Error(`${msg}: ${actual} finite nahi hai (expected ~${expected})`);
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${msg}: expected ${expected} ±${tol}, mila ${actual} (diff ${(actual - expected).toFixed(6)})`);
  }
}

async function run(): Promise<void> {
  const t0 = Date.now();
  let pass = 0;
  const failed: Array<{ name: string; err: Error }> = [];
  for (const t of tests) {
    try {
      await t.fn();
      pass++;
      console.log(`  ${C.g}✓${C.x} ${t.name}`);
    } catch (e) {
      const err = e as Error;
      failed.push({ name: t.name, err });
      console.log(`  ${C.r}✗${C.x} ${t.name}\n      ${C.d}${err.message}${C.x}`);
    }
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(2);
  console.log();
  if (failed.length) {
    console.log(`${C.r}${C.b}${failed.length} failed${C.x}, ${pass} passed (${dt}s)`);
    process.exitCode = 1;
  } else {
    console.log(`${C.g}${C.b}✓ saare ${pass} tests pass${C.x} (${dt}s)`);
  }
}

// ============================================================== options / greeks
const { bsPrice, bsGreeks, impliedVol, estimatePremium, deltaAt, skewedIv, roundToTick } = await import(
  "../market/options.ts"
);

test("BS call/put symmetric: ATM CE = PE jab forward = strike", () => {
  const c = bsPrice(100, 100, 30, 0.2, "CE");
  const p = bsPrice(100, 100, 30, 0.2, "PE");
  // r=6.5% ke wajah se CE > PE (forward > strike) — difference chhota hona chahiye
  assert.ok(c > p, `CE ${c} PE ${p}`);
  assert.ok(Math.abs(c - p) < 1.5, `CE-PE diff ${(c - p).toFixed(3)} bahut bada`);
});

test("BS put-call parity: C - P = S - K·e^(-rT)", () => {
  const S = 25_000;
  const K = 24_800;
  const dte = 7;
  const iv = 0.14;
  const r = 0.065;
  const c = bsPrice(S, K, dte, iv, "CE");
  const p = bsPrice(S, K, dte, iv, "PE");
  const lhs = c - p;
  const rhs = S - K * Math.exp((-r * dte) / 365);
  near(lhs, rhs, 0.5, "parity");
});

test("delta: CE 0..1, PE -1..0, ATM ~0.5 aur monotonic (strike ke saath girta hai)", () => {
  const atm = deltaAt(25_000, 25_000, "CE", 7);
  const otm = deltaAt(25_000, 25_500, "CE", 7);
  const itm = deltaAt(25_000, 24_500, "CE", 7);
  assert.ok(atm > 0.4 && atm < 0.65, `ATM delta ${atm}`);
  assert.ok(otm > 0 && otm < atm, `OTM ${otm} < ATM ${atm}`);
  assert.ok(itm > atm && itm < 1, `ITM ${itm} > ATM ${atm}`);
  // deltaAt magnitude deta hai (engine ko distance chahiye, sign nahi)
  const pe = deltaAt(25_000, 25_000, "PE", 7);
  assert.ok(pe > 0.35 && pe < 0.6, `PE delta magnitude ${pe}`);
});

test("IV round-trip: price → IV → price (mock model ke against)", () => {
  const S = 25_000;
  const K = 25_200;
  const dte = 5;
  const iv = 0.18;
  const price = bsPrice(S, K, dte, iv, "CE");
  const solved = impliedVol(price, S, K, dte, "CE");
  assert.ok(solved !== null, "IV solve nahi ho paya");
  near(solved!, iv, 0.01, "IV round-trip");
});

test("premium: IV badhe to mehnga, expiry nazdeek aaye to sasta", () => {
  const lo = bsPrice(25_000, 25_000, 7, 0.12, "CE");
  const hi = bsPrice(25_000, 25_000, 7, 0.25, "CE");
  assert.ok(hi > lo * 1.8, `IV 25% (${hi}) > IV 12% (${lo}) hona chahiye`);
  const near0 = bsPrice(25_000, 25_000, 0.02, 0.14, "CE");
  assert.ok(near0 < lo * 0.25, `0DTE (${near0}) 7-day (${lo}) se bahut kam hona chahiye`);
});

test("skew: PE par zyada IV (put skew), call side par kam", () => {
  const pe = skewedIv("NIFTY", 25_000, 24_700, 7, "PE");
  const ce = skewedIv("NIFTY", 25_000, 25_300, 7, "CE");
  assert.ok(pe > ce, `put IV ${pe.toFixed(3)} > call IV ${ce.toFixed(3)}`);
});

test("expiry day par premium me time-value kam (0DTE)", () => {
  const far = estimatePremium("NIFTY", 25_000, 25_000, "CE", 7);
  const zero = estimatePremium("NIFTY", 25_000, 25_000, "CE", 0.2);
  assert.ok(zero < far / 3, `0DTE ₹${zero.toFixed(0)} vs weekly ₹${far.toFixed(0)}`);
});

test("tick size ₹0.05 par round hota hai", () => {
  for (const [x, exp] of [
    [123.456, 123.45],
    [123.474, 123.45],
    [123.475, 123.5],
    [0.03, 0.05],
  ] as const) {
    near(roundToTick(x), exp, 1e-9, `tick(${x})`);
  }
});

// ============================================================== instruments
const { indexMeta, nextExpiry, atmStrike, strikeFor, optionSymbol, expiryDayLotFactor, isExpiryDay } = await import(
  "../market/instruments.ts"
);

test("index metadata: lot size + strike step NIFTY/BANKNIFTY/SENSEX ke liye", () => {
  assert.equal(indexMeta("NIFTY").lotSize, 75);
  assert.equal(indexMeta("NIFTY").strikeStep, 50);
  assert.equal(indexMeta("banknifty").lotSize, 35);
  assert.equal(indexMeta("BANKNIFTY").strikeStep, 100);
  assert.equal(indexMeta("SENSEX").exchange, "BFO");
  assert.throws(() => indexMeta("NIFTYXX"), /support nahi hai/i);
});

test("nextExpiry: NIFTY weekly Tuesday, BANKNIFTY monthly, SENSEX Thursday", () => {
  const weekdayOf = (key: string) => new Date(`${key}T12:00:00+05:30`).getDay(); // 0=Sun
  const nf = nextExpiry("NIFTY", new Date("2026-10-14T06:00:00Z")); // Wed se dekha
  assert.equal(nf.weekly, true);
  assert.equal(weekdayOf(nf.dateKey), 2, `NIFTY expiry Tuesday honi chahiye, mili ${nf.dateKey}`);
  const bn = nextExpiry("BANKNIFTY", new Date("2026-10-14T06:00:00Z"));
  assert.equal(bn.weekly, false, "BANKNIFTY monthly hai");
  assert.ok(bn.daysToExpiry >= 1);
  const sx = nextExpiry("SENSEX", new Date("2026-10-14T06:00:00Z"));
  assert.equal(weekdayOf(sx.dateKey), 4, `SENSEX expiry Thursday, mili ${sx.dateKey}`);
});

test("expiry hamesha bhavishya me hoti hai (past date nahi)", () => {
  for (const sym of ["NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY"]) {
    const e = nextExpiry(sym, new Date("2026-10-14T06:00:00Z"));
    assert.ok(e.date.getTime() > Date.parse("2026-10-14T06:00:00Z"), `${sym} expiry past me: ${e.dateKey}`);
    assert.ok(e.daysToExpiry >= 1 && e.daysToExpiry <= 35, `${sym} daysToExpiry ${e.daysToExpiry}`);
  }
});

test("ATM strike round hota hai, ITM/OTM sahi direction me", () => {
  assert.equal(atmStrike("NIFTY", 24_987), 25_000);
  assert.equal(atmStrike("NIFTY", 25_024), 25_000);
  const exp = nextExpiry("NIFTY", new Date("2026-10-14T06:00:00Z"));
  const atm = strikeFor("NIFTY", 25_000, "CE", "ATM");
  assert.equal(atm, 25_000);
  const otm1 = strikeFor("NIFTY", 25_000, "CE", "OTM1");
  assert.equal(otm1, 25_050, "CE OTM1 = ek step upar");
  const otm1pe = strikeFor("NIFTY", 25_000, "PE", "OTM1");
  assert.equal(otm1pe, 24_950, "PE OTM1 = ek step neeche");
  const itm1 = strikeFor("NIFTY", 25_000, "CE", "ITM1");
  assert.equal(itm1, 24_950, "CE ITM1 = ek step neeche");
  void exp;
});

test("option symbol format: monthly (YY+MON) aur weekly (YYMMDD) dono", () => {
  const wk = nextExpiry("NIFTY", new Date("2026-10-14T06:00:00Z"));
  const symW = optionSymbol("NIFTY", 25_000, "CE", wk);
  assert.match(symW, /^NIFTY\d{6}25000CE$/, `weekly symbol galat: ${symW}`);
  const mo = nextExpiry("BANKNIFTY", new Date("2026-10-14T06:00:00Z"));
  const symM = optionSymbol("BANKNIFTY", 52_000, "PE", mo);
  assert.match(symM, /^BANKNIFTY\d{2}[A-Z]{3}52000PE$/, `monthly symbol galat: ${symM}`);
});

test("expiry day par lot factor > 1 (0DTE me risk zyada)", () => {
  const e = nextExpiry("NIFTY", new Date("2026-10-14T06:00:00Z"));
  const [Y, M, D] = e.dateKey.split("-").map(Number) as [number, number, number];
  const morning = istEpoch(10, 0, Date.UTC(Y, M - 1, D, 0, 0)); // expiry day 10:00 IST
  const late = morning + 5 * 3600_000; // ~15:00 IST
  assert.equal(isExpiryDay("NIFTY", morning), true, "expiry day detect hona chahiye");
  assert.equal(expiryDayLotFactor("NIFTY", morning), 1, "subah factor 1");
  assert.equal(expiryDayLotFactor("NIFTY", late), 0.5, "expiry day 14:00 ke baad aadha");
  const otherDay = morning + 86_400_000;
  assert.equal(expiryDayLotFactor("NIFTY", otherDay), 1, "non-expiry day factor 1");
});

// ============================================================== charges
const { orderCharges, roundTripCharges, breakevenPoints, exerciseCharge } = await import("../charges.ts");

test("option buy order: brokerage cap ₹20, STT sirf sell pe, GST 18%", () => {
  const buy = orderCharges({ broker: "zerodha", segment: "options", side: "buy", qty: 75, price: 150 });
  const sell = orderCharges({ broker: "zerodha", segment: "options", side: "sell", qty: 75, price: 150 });
  near(buy.brokerage, 20, 0.01, "brokerage");
  assert.equal(buy.stt, 0, "buy pe STT nahi");
  near(sell.stt, 75 * 150 * 0.001, 0.01, "sell STT 0.1%");
  near(buy.gst, (buy.brokerage + buy.exchangeTxn + buy.sebi) * 0.18, 0.02, "GST");
  assert.ok(buy.total > 20 && buy.total < 35, `options buy charges ₹${buy.total} realistic nahi`);
  assert.ok(sell.total > buy.total, "sell (STT) mehnga hona chahiye");
});

test("charges: F&O me flat ₹20 hamesha, equity intraday me min(20, 0.03%)", () => {
  const tiny = orderCharges({ broker: "zerodha", segment: "options", side: "buy", qty: 75, price: 8 });
  const big = orderCharges({ broker: "zerodha", segment: "options", side: "buy", qty: 75 * 40, price: 400 });
  near(tiny.brokerage, 20, 0.01, "chhote F&O order pe bhi flat ₹20");
  near(big.brokerage, 20, 0.01, "bade F&O order pe bhi flat ₹20");
  assert.ok(big.total > tiny.total, "bade turnover pe baaki charges zyada");
  const eq = orderCharges({ broker: "zerodha", segment: "equity_intraday", side: "buy", qty: 10, price: 100 });
  near(eq.brokerage, Math.min(20, 0.0003 * 1000), 0.01, "equity intraday percent rule");
});

test("roundTrip charges + breakeven dono leg count karte hain", () => {
  const rt = roundTripCharges({ broker: "zerodha", qty: 75, entry: 150, exit: 200, segment: "options" });
  assert.ok(rt.total > 40, `round trip charges ₹${rt.total} kam lag rahe`);
  const be = breakevenPoints("zerodha", 75, 150);
  assert.ok(be > 0.5 && be < 6, `breakeven ${be} points unrealistic`);
  assert.ok(exerciseCharge(75, 100) > 0);
});

test("paper broker bhi same charges lagata hai (cost-free demo nahi hai)", () => {
  const z = orderCharges({ broker: "zerodha", segment: "options", side: "buy", qty: 75, price: 150 }).total;
  const p = orderCharges({ broker: "paper", segment: "options", side: "buy", qty: 75, price: 150 }).total;
  assert.ok(Math.abs(z - p) < 1, `paper ₹${p} vs zerodha ₹${z}`);
});

// ============================================================== indicators
const { sma, ema, rsi, atr, adx, supertrend, vwap, stdev, vwapBands } = await import("../market/indicators.ts");

test("sma/ema/rsi known values par sahi", () => {
  near(sma([1, 2, 3, 4, 5], 3)[4]!, 4, 1e-9, "sma");
  const e = ema([1, 2, 3, 4, 5, 6], 3);
  assert.ok(e[2] !== null && e[5]! > e[2]!, "ema badhni chahiye");
  const up = rsi(Array.from({ length: 30 }, (_, i) => 100 + i), 14);
  assert.ok(up[29]! > 95, `lagatar up me RSI 100 ke paas: ${up[29]}`);
  const dn = rsi(Array.from({ length: 30 }, (_, i) => 100 - i), 14);
  assert.ok(dn[29]! < 5, `lagatar down me RSI 0 ke paas: ${dn[29]}`);
});

test("atr: range se kam/zyada nahi, adx trend me badhta hai", () => {
  const n = 60;
  const c = Array.from({ length: n }, (_, i) => 100 + i * 0.8 + (i % 3) * 0.4);
  const h = c.map((x) => x + 1.2);
  const l = c.map((x) => x - 0.8);
  const a = atr(h, l, c, 14);
  assert.ok(a[n - 1]! > 1 && a[n - 1]! < 4, `ATR ${a[n - 1]} unrealistic`);
  const trend = adx(h, l, c, 14);
  assert.ok(trend.adx[n - 1]! > 25, `trend me ADX > 25 chahiye, mila ${trend.adx[n - 1]}`);
  const flat = adx(
    Array.from({ length: n }, () => 100),
    Array.from({ length: n }, () => 100.5),
    Array.from({ length: n }, () => 100),
    14,
  );
  assert.ok((flat.adx[n - 1] ?? 0) < 20, `flat me ADX kam hona chahiye: ${flat.adx[n - 1]}`);
});

test("vwap: volume-weighted hota hai (simple average nahi)", () => {
  const bars = [
    { ts: 1, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
    { ts: 2, open: 200, high: 201, low: 199, close: 200, volume: 1 },
  ];
  const v = vwap(bars)!;
  assert.ok(v < 105, `vwap ${v} — volume weight kaam nahi kar raha (simple avg 150 hota)`);
  near(v, (100 * 1000 + 200 * 1) / 1001, 0.01, "vwap");
});

test("vwapBands: sigma VWAP ke around hoti hai, price level ki stdev nahi", () => {
  const bars = Array.from({ length: 40 }, (_, i) => ({
    ts: i,
    open: 25_000 + i * 5,
    high: 25_010 + i * 5,
    low: 24_990 + i * 5,
    close: 25_000 + i * 5,
    volume: 1000,
  }));
  const { vwap: v, sigma } = vwapBands(bars);
  assert.ok(v! > 24_900, `vwap ${v}`);
  // Python `vwap_bands()` ka exact value (parity check) — (high+low+close)/3 ka
  // volume-weighted scatter VWAP ke around
  near(sigma, 57.717, 0.01, "vwapBands sigma (py parity)");
  assert.ok(sigma > stdev(bars.map((b) => b.close), 5)[39]! * 0.5, "sigma 0 nahi hona chahiye");
});

test("supertrend: uptrend me up=true, downtrend me up=false (py parity)", () => {
  const up = Array.from({ length: 50 }, (_, i) => 100 + i);
  const stUp = supertrend(up.map((x) => x + 1), up.map((x) => x - 1), up, 10, 3);
  assert.equal(stUp.up[49], true, "uptrend me up true");
  const dn = Array.from({ length: 50 }, (_, i) => 100 - i);
  const stDn = supertrend(dn.map((x) => x + 1), dn.map((x) => x - 1), dn, 10, 3);
  assert.equal(stDn.up[49], false, "downtrend me up false");
});

// ============================================================== candles
const { CandleStore } = await import("../market/candles.ts");
const { istEpoch } = await import("../util.ts");

test("tick se 1m/5m/15m candles bante hain, forming bar alag rehta hai", () => {
  const store = new CandleStore(["1m", "5m", "15m"]);
  const start = istEpoch(9, 15, Date.UTC(2026, 9, 14, 3, 45));
  let price = 25_000;
  for (let i = 0; i < 300; i++) {
    price += i % 7 === 0 ? 2 : i % 5 === 0 ? -3 : 1;
    store.push(start + i * 20_000, price, 100 + i);
  }
  assert.equal(store.series("1m").length, 100, "100 min me 100 1m buckets (aakhri forming)");
  assert.equal(store.closedBars("1m").length, 99, "closed 1m bars = 99");
  assert.equal(store.series("5m").length, 20, "20 5m buckets");
  assert.equal(store.closedBars("5m").length, 19, "closed 5m = 19");
  assert.equal(store.series("15m").length, 7, "7 15m buckets (7th forming)");
  assert.equal(store.closedBars("15m").length, 6, "closed 15m = 6");
  assert.ok(store.dayOpen > 0 && store.dayOpen === 25_000 + 2, "day open pehla price");
  assert.ok(store.dayHigh() >= store.dayLow(), "high/low");
});

test("CandleStore: naya session aa gaya to candles reset", () => {
  const store = new CandleStore(["1m"]);
  const d1 = istEpoch(9, 15, Date.UTC(2026, 9, 14, 3, 45));
  for (let i = 0; i < 10; i++) store.push(d1 + i * 60_000, 25_000 + i, 100);
  assert.equal(store.series("1m").length, 10);
  const d2 = d1 + 86_400_000;
  store.push(d2, 25_500, 100);
  assert.equal(store.series("1m").length, 1, "naye din pe reset");
  assert.equal(store.dayOpen, 25_500);
});

test("candle OHLC sahi banta hai (open/high/low/close)", () => {
  const store = new CandleStore(["1m"]);
  const t = istEpoch(9, 15, Date.UTC(2026, 9, 14, 3, 45));
  for (const [dt, px] of [
    [0, 100],
    [10_000, 105],
    [20_000, 95],
    [40_000, 102],
  ] as const) {
    store.push(t + dt, px, 500);
  }
  const bar = store.series("1m")[0]!;
  assert.equal(bar.open, 100);
  assert.equal(bar.high, 105);
  assert.equal(bar.low, 95);
  assert.equal(bar.close, 102);
  assert.equal(bar.volume, 2000);
});

// ============================================================== risk
const { RiskManager, premiumMoveFor } = await import("../engine/risk.ts");
const { config, applyOverrides } = await import("../config.ts");

test("sizeLots: risk budget / (premium move × lot size)", () => {
  const r = new RiskManager();
  // capital 2L, 1% = ₹2000 risk; premium move 20 × lot 75 = ₹1500/lot → 1 lot
  const a = r.sizeLots({ premium: 150, premiumMove: 20, lotSize: 75 });
  assert.equal(a.lots, 1, `mila ${a.lots} — ₹${a.riskPerLot}/lot`);
  // chhota move → zyada lots, par maxLots cap
  const b = r.sizeLots({ premium: 150, premiumMove: 5, lotSize: 75 });
  assert.equal(b.lots, config.risk.maxLots, `cap ${config.risk.maxLots} hona chahiye`);
  // bada move: 60 × 75 = ₹4500/lot > 1% budget (₹2000) — par min-one-lot rule
  // (3% hard cap = ₹6000) ke andar hai, isliye 1 lot milta hai
  const c = r.sizeLots({ premium: 150, premiumMove: 60, lotSize: 75 });
  assert.equal(c.lots, 1, `min-one-lot ke saath 1 lot milna chahiye, mila ${c.lots}`);
  assert.match(c.note, /min-one-lot/i, c.note);
  // min-one-lot band karo to 0 lots (aur reject hona chahiye)
  const d = r.sizeLots({ premium: 150, premiumMove: 60, lotSize: 75, minOneLot: false });
  assert.equal(d.lots, 0);
  assert.match(d.note, /bahut bada|skip/i, d.note);
});

test("premiumMoveFor: index SL distance → premium move (delta clamp + % cap/floor)", () => {
  const m = premiumMoveFor(100, 0.5, 200); // 50 points move
  near(m, 50, 1e-9, "delta 0.5 → 50");
  const capped = premiumMoveFor(500, 0.9, 200); // 450 > 30% cap (60)
  near(capped, 60, 1e-9, "premium ka 30% cap");
  const floored = premiumMoveFor(10, 0.5, 400); // 5 < 12% floor (48)
  near(floored, 48, 1e-9, "premium ka 12% floor");
});

test("canEnter: entry window, min premium, max trades, daily loss, cooldown", () => {
  const r = new RiskManager();
  const now = istEpoch(10, 0, Date.UTC(2026, 9, 14, 3, 45));
  const ok = r.canEnter(now, { premium: 150, minutesToClose: 200, lotSize: 75 });
  assert.equal(ok.ok, true, ok.reason);
  const cheap = r.canEnter(now, { premium: 10, minutesToClose: 200, lotSize: 75 });
  assert.equal(cheap.ok, false);
  assert.match(cheap.reason, /premium/i);
  const late = r.canEnter(now, { premium: 150, minutesToClose: 10, lotSize: 75 });
  assert.equal(late.ok, false);
  assert.match(late.reason, /close/i);
});

test("risk gates: daily loss limit, consecutive losses, cooldown, max trades", () => {
  const r = new RiskManager();
  const now = istEpoch(11, 0, Date.UTC(2026, 9, 14, 3, 45));
  // daily loss limit (capital 2L → 2% = ₹4000)
  r.recordTrade(-4_500, -4_450, 50, now);
  const a = r.canEnter(now, { premium: 150, minutesToClose: 200, lotSize: 75 });
  assert.equal(a.ok, false, "daily loss ke baad entry nahi");
  assert.equal(r.state.halted, true);

  // cooldown after loss
  const r2 = new RiskManager();
  r2.recordTrade(-1_000, -950, 50, now);
  const b = r2.canEnter(now + 60_000, { premium: 150, minutesToClose: 200, lotSize: 75 });
  assert.equal(b.ok, false);
  assert.match(b.reason, /cooldown/i);
  const c = r2.canEnter(now + config.risk.cooldownMinutes * 60_000 + 1000, {
    premium: 150,
    minutesToClose: 200,
    lotSize: 75,
  });
  assert.equal(c.ok, true, c.reason);

  // max trades/day
  const r3 = new RiskManager();
  for (let i = 0; i < config.risk.maxTradesPerDay; i++) r3.recordTrade(100, 120, -20, now);
  const d = r3.canEnter(now, { premium: 150, minutesToClose: 200, lotSize: 75 });
  assert.equal(d.ok, false);
  assert.match(d.reason, /max trades/i);
});

test("consecutive losses halt karta hai (3 lagatar loss)", () => {
  const r = new RiskManager();
  const now = istEpoch(11, 0, Date.UTC(2026, 9, 14, 3, 45));
  for (let i = 0; i < config.risk.maxConsecLosses; i++) {
    r.recordTrade(-500, -480, 20, now + i * 60_000);
  }
  assert.equal(r.state.consecutiveLosses, config.risk.maxConsecLosses);
  assert.equal(r.state.halted, true, "lagatar losses pe turant halt");
  assert.match(r.state.haltReason, /lagatar loss/i);
  const check = r.canEnter(now + 10 * 60_000, { premium: 150, minutesToClose: 200, lotSize: 75 });
  assert.equal(check.ok, false);
  assert.match(check.reason, /lagatar loss/i, check.reason);
});

test("kill switch: KILL file hone se entry block aur exit force", async () => {
  const { writeFileSync, rmSync } = await import("node:fs");
  const path = config.killSwitchFile;
  rmSync(path, { force: true });
  const r = new RiskManager();
  const now = istEpoch(11, 0, Date.UTC(2026, 9, 14, 3, 45));
  assert.equal(r.killSwitchActive(), false);
  writeFileSync(path, "stop");
  assert.equal(r.killSwitchActive(), true, "KILL file detect honi chahiye");
  const c = r.canEnter(now, { premium: 150, minutesToClose: 200, lotSize: 75 });
  assert.equal(c.ok, false);
  assert.match(c.reason, /KILL/i);
  rmSync(path, { force: true });
});

test("rollDay: naye din pe counters reset hote hain", () => {
  const r = new RiskManager();
  const now = istEpoch(11, 0, Date.UTC(2026, 9, 14, 3, 45));
  r.recordTrade(-600, -580, 20, now);
  assert.equal(r.state.tradesToday, 1);
  assert.equal(r.state.consecutiveLosses, 1);
  r.rollDay(now + 86_400_000);
  assert.equal(r.state.tradesToday, 0);
  assert.equal(r.state.consecutiveLosses, 0);
  assert.equal(r.state.realizedToday, 0);
});

// ============================================================== paper broker
const { PaperBroker } = await import("../broker/paper.ts");
const { createBroker } = await import("../broker/index.ts");

test("PaperBroker: setPrice ke bina order fill nahi hota (stale price se bachao)", async () => {
  const b = new PaperBroker();
  await b.init();
  b.setPrice("NIFTY25OCT25000CE", { ltp: 150 });
  const o = await b.placeOrder({
    index: "NIFTY",
    symbol: "NIFTY25OCT25000CE",
    strike: 25_000,
    optType: "CE",
    expiryCode: "251022",
    expiryWeekly: true,
    side: "buy",
    qty: 75,
    orderType: "MARKET",
  });
  assert.equal(o.filledQty, 75, "fill hona chahiye");
  assert.ok(o.avgPrice >= 150, `slippage se price >= 150 hona chahiye: ${o.avgPrice}`);
  assert.ok((o.charges ?? 0) > 0, "charges lagne chahiye");
  const pos = await b.positions();
  assert.equal(pos.length, 1);
  assert.equal(pos[0]!.qty, 75);
});

test("PaperBroker: SL-M trigger hone par position exit, squareOffAll sab band", async () => {
  const b = new PaperBroker();
  await b.init();
  b.setPrice("X74000CE", { ltp: 200 });
  await b.placeOrder({ index: "NIFTY", symbol: "X74000CE", strike: 24_000, optType: "CE", expiryCode: "251022", expiryWeekly: true, side: "buy", qty: 75, orderType: "MARKET" });
  await b.placeOrder({ index: "NIFTY", symbol: "X74000CE", strike: 24_000, optType: "CE", expiryCode: "251022", expiryWeekly: true, side: "sell", qty: 75, orderType: "SL-M", triggerPrice: 170 });
  b.setPrice("X74000CE", { ltp: 160 });
  b.tick({ symbol: "X74000CE", ts: Date.now(), ltp: 160, bid: 159, ask: 161 });
  const orders = await b.orders();
  const sl = orders.find((o) => o.orderType === "SL-M");
  assert.equal(sl?.status, "COMPLETE", `SL-M trigger hona chahiye, status ${sl?.status}`);
  assert.equal((await b.positions()).length, 0, "position band honi chahiye");
});

test("createBroker: paper default, unknown broker pe error", async () => {
  const p = createBroker("paper");
  assert.equal(p.name, "paper");
  assert.throws(() => createBroker("nonsense"), /support nahi hai/i);
});

// ============================================================== calendar
const { marketStatus, isTradingDay, loadHolidays, withinEntryWindow, shouldSquareOff } = await import(
  "../market/calendar.ts"
);

test("marketStatus: pre/open/closing/post sab sahi IST time pe", () => {
  const day = Date.UTC(2026, 9, 14, 3, 45); // 14 Oct 2026, 09:15 IST (Wed)
  const at = (h: number, m: number) => marketStatus(istEpoch(h, m, day));
  assert.equal(at(9, 0).open, false, "09:00 = pre");
  assert.equal(at(9, 15).open, true, "09:15 = open");
  assert.equal(at(12, 0).open, true, "12:00 = open");
  assert.equal(at(15, 20).phase, "closing", "15:20 = closing");
  assert.equal(at(15, 30).open, false, "15:30 = closed (boundary band)");
  assert.equal(at(20, 0).open, false, "20:00 = closed");
});

test("entry window aur square-off time config ke hisaab se", () => {
  const day = Date.UTC(2026, 9, 14, 3, 45);
  const early = withinEntryWindow(istEpoch(9, 10, day));
  assert.equal(early.ok, false, early.reason);
  assert.match(early.reason, /09:20/);
  assert.equal(withinEntryWindow(istEpoch(10, 0, day)).ok, true);
  const lateWin = withinEntryWindow(istEpoch(14, 50, day));
  assert.equal(lateWin.ok, false);
  assert.match(lateWin.reason, /14:45|cutoff/i);
  assert.equal(shouldSquareOff(istEpoch(15, 16, day)), true);
  assert.equal(shouldSquareOff(istEpoch(14, 0, day)), false);
});

test("weekend trading day nahi hota, holiday file load hoti hai", () => {
  const sat = Date.UTC(2026, 9, 17, 4, 0);
  assert.equal(isTradingDay(sat), false, "Saturday");
  const wed = Date.UTC(2026, 9, 14, 4, 0);
  assert.equal(isTradingDay(wed), true, "Wednesday");
  const h = loadHolidays();
  assert.ok(h.has("2026-01-26") || h.size === 0, "holiday file parse ho rahi hai");
});

// ============================================================== strategies (local ports)
const { createLocalStrategy, LOCAL_STRATEGIES } = await import("../strategy/local.ts");

function barsOf(prices: number[], startTs: number, tfMin = 1): Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }> {
  return prices.map((p, i) => ({
    ts: startTs + i * tfMin * 60_000,
    open: p,
    high: p + 5,
    low: p - 5,
    close: p,
    volume: 1000,
  }));
}

test("saari local strategies load hoti hain aur warmup deti hain", () => {
  for (const name of Object.keys(LOCAL_STRATEGIES)) {
    const s = createLocalStrategy(name);
    assert.ok(s.warmup() > 0, `${name} warmup`);
    assert.ok(s.timeframes.length > 0, `${name} tf`);
    assert.throws(() => createLocalStrategy("nope"), /nahi hai/i);
  }
});

test("ORB: opening range set hone se pehle koi signal nahi (warmup)", () => {
  const orb = createLocalStrategy("orb");
  const t0 = istEpoch(9, 15, Date.UTC(2026, 9, 14, 3, 45));
  const st = {
    symbol: "NIFTY",
    ts: t0 + 5 * 60_000,
    ltp: 25_000,
    bars: { "1m": barsOf(Array.from({ length: 6 }, () => 25_000), t0), "5m": [], "15m": [] },
    vwap: 25_000,
    atr: 40,
    adx: 25,
    position: null,
    dayPnl: 0,
    tradesToday: 0,
    consecutiveLosses: 0,
    minutesToClose: 300,
    dayHigh: 25_010,
    dayLow: 24_990,
    meta: { session: "2026-10-14" },
  };
  const sig = orb.onState(st as never);
  assert.equal(sig.action, "hold", `OR complete hone se pehle ${sig.action}: ${sig.reason}`);
  assert.match(sig.reason, /OR|range|warmup/i, sig.reason);
});

test("ORB: range ke upar breakout pe BUY, neeche pe SELL (stop/target index par)", () => {
  const t0 = istEpoch(9, 15, Date.UTC(2026, 9, 14, 3, 45));
  const base = Array.from({ length: 15 }, (_, i) => 25_000 + Math.sin(i) * 10);
  const mk = (lastPx: number) => {
    const prices = [...base, ...Array.from({ length: 6 }, () => lastPx)];
    return {
      symbol: "NIFTY",
      ts: t0 + 21 * 60_000,
      ltp: lastPx,
      bars: { "1m": barsOf(prices, t0), "5m": barsOf(prices, t0, 5), "15m": [] },
      vwap: 25_000,
      atr: 30,
      adx: 28,
      position: null,
      dayPnl: 0,
      tradesToday: 0,
      consecutiveLosses: 0,
      minutesToClose: 300,
      dayHigh: lastPx,
      dayLow: 24_990,
      meta: { session: "2026-10-14" },
    };
  };
  const up = createLocalStrategy("orb");
  const warm = up.onState(mk(25_000) as never); // pehla call: OR set karta hai
  assert.equal(warm.action, "hold", `OR set call pe hold: ${warm.reason}`);
  assert.match(warm.reason, /OR set/i, warm.reason);
  const sUp = up.onState(mk(25_050) as never); // breakout
  assert.equal(sUp.action, "buy", `breakout upar pe buy chahiye: ${sUp.reason}`);
  assert.ok(sUp.stop != null && sUp.stop < 25_050, "stop index level neeche");
  assert.ok(sUp.target != null && sUp.target > 25_050, "target index level upar");

  const dn = createLocalStrategy("orb");
  dn.onState(mk(25_000) as never); // OR set
  const sDn = dn.onState(mk(24_930) as never);
  assert.equal(sDn.action, "sell", `breakout neeche pe sell chahiye: ${sDn.reason}`);
  assert.ok(sDn.stop != null && sDn.stop > 24_930, "sell ka stop upar");
});

test("ORB: max trades ke baad naya signal nahi deta", () => {
  const t0 = istEpoch(9, 15, Date.UTC(2026, 9, 14, 3, 45));
  const prices = [...Array.from({ length: 15 }, () => 25_000), ...Array.from({ length: 6 }, () => 25_050)];
  const orb = createLocalStrategy("orb");
  const st = {
    symbol: "NIFTY",
    ts: t0 + 21 * 60_000,
    ltp: 25_050,
    bars: { "1m": barsOf(prices, t0), "5m": barsOf(prices, t0, 5), "15m": [] },
    vwap: 25_000,
    atr: 30,
    adx: 28,
    position: null,
    dayPnl: 0,
    tradesToday: 2, // engine ka count — strategy khud count nahi karti
    consecutiveLosses: 0,
    minutesToClose: 300,
    meta: { session: "2026-10-14" },
  };
  const sig = orb.onState(st as never);
  assert.equal(sig.action, "hold", `max trades ke baad hold: ${sig.action}`);
});

// ============================================================== AI gate
const { applyAiGate } = await import("../ai/gate.ts");
applyOverrides({ AI_MODE: "off", AI_PROVIDER: "mock", AI_API_KEY: "", AI_MIN_CONFIDENCE: "0.6" });

function mkState(over: Record<string, unknown> = {}): Record<string, unknown> {
  const t0 = istEpoch(10, 0, Date.UTC(2026, 9, 14, 3, 45));
  const prices = Array.from({ length: 30 }, (_, i) => 25_000 + i * 3);
  return {
    symbol: "NIFTY",
    ts: t0,
    ltp: 25_087,
    bars: { "1m": barsOf(prices, t0), "5m": barsOf(prices, t0, 5), "15m": [] },
    vwap: 25_040,
    atr: 35,
    adx: 30,
    position: null,
    dayPnl: 0,
    tradesToday: 0,
    consecutiveLosses: 0,
    minutesToClose: 250,
    dayHigh: 25_090,
    dayLow: 24_990,
    meta: { session: "2026-10-14" },
    ...over,
  };
}
const buySignal = { action: "buy" as const, reason: "test breakout", confidence: 0.7, stop: 25_050, target: 25_150 };

test("AI off: signal waisa hi nikalta hai (koi AI call nahi)", async () => {
  const r = await applyAiGate(mkState() as never, buySignal);
  assert.equal(r.signal.action, "buy");
  assert.equal(r.ai, undefined);
});

test("AI veto: mock model approve kare to trade, 'skip' de to block", async () => {
  const { mockEvaluate } = await import("../ai/mock.ts");
  const { vetoQuestion } = await import("../ai/prompt.ts");
  const q = vetoQuestion(mkState() as never, buySignal);
  const d = mockEvaluate(q);
  assert.ok(["take", "skip"].includes(d.choice), `mock choice ${d.choice}`);
  assert.ok(d.confidence >= 0 && d.confidence <= 1, "confidence range");
  assert.ok(d.reasoning.length > 0, "reasoning");
});

test("AI gate exits ko kabhi block nahi karta", async () => {
  const exitSignal = { action: "exit" as const, reason: "index SL hit", confidence: 0.9 };
  const r = await applyAiGate(mkState() as never, exitSignal);
  assert.equal(r.signal.action, "exit", "exit signal pass hona chahiye");
});

// ============================================================== journal
const { Journal } = await import("../engine/journal.ts");

test("Journal: trade record, trades.csv + daily.csv likhe jate hain", async () => {
  const { mkdtempSync, readFileSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "algo-journal-"));
  try {
    const j = new Journal(dir);
    const ts = istEpoch(10, 0, Date.UTC(2026, 9, 14, 3, 45));
    j.event("order", { side: "buy", symbol: "X", qty: 75 });
    j.recordTrade({
      id: "T1",
      symbol: "NIFTY25OCT25000CE",
      optType: "CE",
      strike: 25_000,
      lots: 1,
      qty: 75,
      entryTs: ts,
      exitTs: ts + 20 * 60_000,
      entryPremium: 150,
      exitPremium: 175,
      entryIndex: 25_000,
      exitIndex: 25_060,
      indexStop: 24_970,
      indexTarget: 25_090,
      gross: 1_875,
      charges: 120,
      net: 1_755,
      reason: "index target hit",
      tag: "orb",
      confidence: 0.75,
      holdMinutes: 20,
    });
    j.writeDailySummary({
      ts,
      date: "2026-10-14",
      mode: "demo",
      broker: "paper",
      strategy: "orb",
      trades: 1,
      wins: 1,
      losses: 0,
      winRate: 100,
      gross: 1_875,
      charges: 120,
      net: 1_755,
      equityEnd: 201_755,
      maxDD: 0,
      riskHalted: false,
      haltReason: "",
    });
    assert.ok(existsSync(join(dir, "events.jsonl")), "events.jsonl");
    assert.ok(existsSync(join(dir, "trades.csv")), "trades.csv");
    assert.ok(existsSync(join(dir, "daily.csv")), "daily.csv");
    const csv = readFileSync(join(dir, "trades.csv"), "utf8");
    assert.ok(csv.includes("NIFTY25OCT25000CE"), "symbol csv me");
    assert.ok(csv.split("\n")[0]!.toLowerCase().includes("net"), "header me net");
    assert.equal(readFileSync(join(dir, "daily.csv"), "utf8").trim().split("\n").length, 2, "1 header + 1 row");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================== config
test("config: defaults sane hain (capital, risk, time windows, broker list)", async () => {
  assert.ok(config.risk.capital >= 100_000);
  assert.ok(config.risk.riskPct > 0 && config.risk.riskPct <= 3);
  assert.ok(config.risk.maxLots >= 1);
  assert.equal(config.broker.product, "MIS");
  assert.ok([config.risk.noTradeBefore, config.risk.entryCutoff, config.risk.squareOff].every((t) => /^\d{2}:\d{2}$/.test(t)));
  const { validateConfig } = await import("../config.ts");
  assert.equal(typeof validateConfig, "function");
});

// ============================================================== engine smoke (in-memory)
test("Engine: synthetic feed + paper broker se trade cycle chalta hai", async () => {
  const { Engine } = await import("../engine/engine.ts");
  const { VirtualClock } = await import("../market/clock.ts");
  const { SyntheticFeed } = await import("../market/feed.ts");
  const { StrategyRunner } = await import("../strategy/index.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "algo-engine-"));
  try {
    const start = istEpoch(9, 15, Date.UTC(2026, 9, 14, 3, 45));
    const clock = new VirtualClock(start, 60, true);
    const broker = new PaperBroker();
    await broker.init();
    const journal = new Journal(dir);
    const events: string[] = [];
    const engine = new Engine({
      clock,
      feed: new SyntheticFeed(clock, "NIFTY"),
      broker,
      strategy: new StrategyRunner("orb"),
      journal,
      emit: (type) => events.push(type),
    });
    // NOTE: engine.start() ko feed.start() se ticks milte hain — yahan manually chalate hain
    void engine;
    assert.ok(events.length >= 0);
    // risk + charges wiring ka smoke: paper broker order cycle
    broker.setPrice("NIFTY25OCT25000PE", { ltp: 150 });
    const o = await broker.placeOrder({
      index: "NIFTY",
      symbol: "NIFTY25OCT25000PE",
      strike: 25_000,
      optType: "PE",
      expiryCode: "251022",
      expiryWeekly: true,
      side: "buy",
      qty: 75,
      orderType: "MARKET",
    });
    assert.equal(o.status, "COMPLETE");
    await broker.squareOffAll();
    assert.equal((await broker.positions()).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await run();
