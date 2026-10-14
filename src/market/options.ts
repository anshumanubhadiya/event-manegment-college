/**
 * options.ts — Black-Scholes pricing + greeks.
 *
 * Kaam:
 *  1. Synthetic/premium estimate — demo me option ka price nikalne ke liye,
 *     aur paper broker ke fills ke liye.
 *  2. Risk sizing — index SL distance ko premium move me convert karne ke liye
 *     (delta ke through).
 *  3. IV calibrate — live me broker quote se implied vol nikal sakte ho.
 *
 * NOTE: India me index options European hain (expiry pe settle), isliye BS theek hai.
 * Asli quotes me IV smile hota hai — isliye chain banate waqt skew daalte hain.
 */

export interface Greeks {
  delta: number;
  gamma: number;
  theta: number; // per day (premium points)
  vega: number; // per 1% IV
  price: number;
}

const RISK_FREE = 0.065; // India 1-yr G-Sec approx (risk-free)

function normCdf(x: number): number {
  // Abramowitz-Stegun 7.1.26 approximation — 1e-7 accuracy
  const b1 = 0.31938153;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;
  const p = 0.2316419;
  const c = 0.39894228;
  if (x >= 0) {
    const t = 1 / (1 + p * x);
    const cnd = c * Math.exp((-x * x) / 2);
    return 1 - cnd * (t * (b1 + t * (b2 + t * (b3 + t * (b4 + t * b5)))));
  }
  // x < 0: N(x) = 1 - N(-x) → same polynomial, k = 1/(1 - p*x)
  const t = 1 / (1 - p * x);
  const cnd = c * Math.exp((-x * x) / 2);
  return cnd * (t * (b1 + t * (b2 + t * (b3 + t * (b4 + t * b5)))));
}

function normPdf(x: number): number {
  return Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);
}

/**
 * BS price + greeks.
 * @param spot index level
 * @param strike strike
 * @param dteDays calendar days to expiry (0.01 min)
 * @param iv annualised IV (0.13 = 13%)
 */
export function bsGreeks(
  spot: number,
  strike: number,
  dteDays: number,
  iv: number,
  optType: "CE" | "PE",
  rate = RISK_FREE,
): Greeks {
  const t = Math.max(dteDays, 0.01) / 365;
  const v = Math.max(iv, 0.01);
  const sigmaT = v * Math.sqrt(t);
  const d1 = (Math.log(spot / strike) + (rate + (v * v) / 2) * t) / sigmaT;
  const d2 = d1 - sigmaT;
  const disc = Math.exp(-rate * t);
  const nd1 = normCdf(d1);
  const nd2 = normCdf(d2);

  let price: number;
  let delta: number;
  if (optType === "CE") {
    price = spot * nd1 - strike * disc * nd2;
    delta = nd1;
  } else {
    price = strike * disc * (1 - nd2) - spot * (1 - nd1);
    delta = nd1 - 1;
  }
  const gamma = normPdf(d1) / (spot * sigmaT);
  const vega = (spot * normPdf(d1) * Math.sqrt(t)) / 100; // per 1% IV
  const thetaRaw =
    -(spot * normPdf(d1) * v) / (2 * Math.sqrt(t)) -
    (optType === "CE" ? 1 : -1) * rate * strike * disc * (optType === "CE" ? nd2 : 1 - nd2);
  const theta = thetaRaw / 365; // per day

  return {
    delta: optType === "CE" ? delta : delta,
    gamma,
    theta,
    vega,
    price: Math.max(price, 0.05),
  };
}

export function bsPrice(spot: number, strike: number, dteDays: number, iv: number, optType: "CE" | "PE"): number {
  return bsGreeks(spot, strike, dteDays, iv, optType).price;
}

/** Newton IV solver — live quote se IV nikalne ke liye. */
export function impliedVol(
  price: number,
  spot: number,
  strike: number,
  dteDays: number,
  optType: "CE" | "PE",
): number | null {
  if (price <= 0.05 || dteDays <= 0) return null;
  let iv = 0.2;
  for (let i = 0; i < 40; i++) {
    const g = bsGreeks(spot, strike, dteDays, iv, optType);
    const diff = g.price - price;
    if (Math.abs(diff) < 0.01) return iv;
    const vegaAbs = g.vega * 100; // per 1.0 IV
    if (vegaAbs < 1e-6) break;
    iv -= diff / vegaAbs;
    if (iv <= 0.01) iv = 0.01;
    if (iv > 5) iv = 5;
  }
  return null;
}

/** Index ka default IV (NIFTY ~12-14% normally, event days pe zyada). */
export function defaultIv(index: string, dteDays: number): number {
  const base = index === "SENSEX" || index === "BANKEX" ? 0.15 : index.startsWith("BANK") ? 0.16 : 0.13;
  // 0DTE pe IV thoda upar (gamma), lambi expiry pe thoda neeche
  const adj = dteDays <= 1 ? 1.1 : dteDays > 20 ? 0.95 : 1;
  return base * adj;
}

/** Moneyness ke hisaab se IV skew (OTM puts mehedge zyada IV). */
export function skewedIv(index: string, spot: number, strike: number, dteDays: number, optType: "CE" | "PE"): number {
  const base = defaultIv(index, dteDays);
  const moneyness = (strike - spot) / spot; // + = upar (CE OTM side)
  const skew = optType === "PE" ? -0.45 : 0.25; // put side steeper (fear premium)
  const smile = 2.2 * moneyness * moneyness * 100;
  const iv = base * (1 + skew * moneyness * 10 + smile / 100);
  return Math.min(Math.max(iv, 0.06), 0.9);
}

/** Delta — index SL distance → premium move convert karne ke liye. */
export function deltaAt(
  spot: number,
  strike: number,
  optType: "CE" | "PE",
  dteDays: number,
  iv?: number,
): number {
  const v = iv ?? skewedIv("NIFTY", spot, strike, dteDays, optType);
  return Math.abs(bsGreeks(spot, strike, dteDays, v, optType).delta);
}

/** Premium estimate (skew-aware) — paper mode aur sanity checks ke liye. */
export function estimatePremium(
  index: string,
  spot: number,
  strike: number,
  optType: "CE" | "PE",
  dteDays: number,
): number {
  const iv = skewedIv(index, spot, strike, dteDays, optType);
  return Math.max(bsPrice(spot, strike, dteDays, iv, optType), 0.5);
}

export interface LegAdjustment {
  /** index points me SL distance → premium me kitna move */
  premiumMove: number;
  delta: number;
  iv: number;
}

/**
 * Index-level SL/target ko option premium level me convert karo.
 * stopPremium = entryPremium - delta*riskPoints (approx; convexity ignore).
 */
export function legAdjustment(
  index: string,
  spot: number,
  strike: number,
  optType: "CE" | "PE",
  dteDays: number,
  indexRiskPoints: number,
): LegAdjustment {
  const iv = skewedIv(index, spot, strike, dteDays, optType);
  const delta = Math.abs(bsGreeks(spot, strike, dteDays, iv, optType).delta);
  return { premiumMove: delta * indexRiskPoints, delta, iv };
}

/** Tick size / round to option tick (₹0.05). */
export function roundToTick(price: number): number {
  return Math.round(price * 20) / 20;
}
