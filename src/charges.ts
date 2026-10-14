/**
 * charges.ts — Indian brokerage/taxes model (Python side se identical).
 *
 * Ye cheez backtest me sabse zyada ignore hoti hai aur sabse zyada paisa khaati hai.
 * Index options me round-trip charge ~₹60-80/lot hota hai — 2 trades/day × 20 din
 * = ₹2,400-3,200/month sirf charges. Isliye har trade pe lagta hai.
 *
 * Rates: 2025-26 (SEBI/exchange notifications). Budget ke baad badal sakte hain,
 * isliye live jaane se pehle ek baar broker ke contract note se verify kar lena.
 */

export interface ChargeInput {
  broker: string;
  segment: "options" | "futures" | "equity_intraday" | "equity_delivery";
  side: "buy" | "sell";
  qty: number;
  price: number;
}

export interface ChargeBreakdown {
  brokerage: number;
  stt: number;
  exchangeTxn: number;
  sebi: number;
  stamp: number;
  gst: number;
  total: number;
}

interface BrokerSpec {
  /** per-order flat brokerage (₹) — 0 = percent based */
  flat: number;
  /** percent-based brokerage (0.0003 = 0.03%) */
  pct: number;
  /** percent-based cap per order */
  cap: number;
  /** delivery brokerage free? */
  deliveryFree: boolean;
}

const BROKERS: Record<string, BrokerSpec> = {
  // Zerodha: ₹20/order flat (F&O), equity intraday min(20, 0.03%)
  zerodha: { flat: 20, pct: 0.0003, cap: 20, deliveryFree: true },
  angel: { flat: 20, pct: 0.0003, cap: 20, deliveryFree: true },
  // Fyers: ₹20/order, 0.03% min
  fyers: { flat: 20, pct: 0.0003, cap: 20, deliveryFree: true },
  upstox: { flat: 20, pct: 0.0003, cap: 20, deliveryFree: true },
  // Dhan: ₹20/order
  dhan: { flat: 20, pct: 0.0003, cap: 20, deliveryFree: true },
  paper: { flat: 20, pct: 0.0003, cap: 20, deliveryFree: true },
};

const STT = {
  options_sell: 0.001, // 0.1% of premium (Oct 2024 se)
  options_exercise: 0.00125, // 0.125% of intrinsic (ITM expiry)
  futures_sell: 0.0002,
  equity_intraday_sell: 0.00025,
  equity_delivery: 0.001,
};

const EXCHANGE_TXN = {
  nse_options: 0.0003503, // 0.03503% of premium
  bse_options: 0.000325,
  nse_futures: 0.0000173,
  nse_equity: 0.0000297,
  bse_equity: 0.0000375,
};

const SEBI_RATE = 0.000001; // ₹10 per crore = 0.0001% → 0.000001 as fraction
const GST_RATE = 0.18;
const STAMP = {
  options_buy: 0.00003, // 0.003%
  futures_buy: 0.00002,
  equity_intraday_buy: 0.00003,
  equity_delivery_buy: 0.00015,
};

function brokerSpec(name: string): BrokerSpec {
  return BROKERS[name.toLowerCase()] ?? BROKERS["zerodha"]!;
}

export function orderCharges(input: ChargeInput): ChargeBreakdown {
  const spec = brokerSpec(input.broker);
  const turnover = input.qty * input.price;

  let brokerage: number;
  if (input.segment === "equity_delivery" && spec.deliveryFree) {
    brokerage = 0;
  } else if (input.segment === "equity_intraday") {
    brokerage = Math.min(spec.pct * turnover, spec.cap);
  } else {
    brokerage = Math.min(spec.flat, Math.max(spec.pct * turnover, 0)) || spec.flat;
    // flat ₹20 — percent wala sirf tab jab cap se kam ho (broker rule)
    brokerage = spec.flat;
  }

  let stt = 0;
  if (input.segment === "options") {
    stt = input.side === "sell" ? turnover * STT.options_sell : 0;
  } else if (input.segment === "futures") {
    stt = input.side === "sell" ? turnover * STT.futures_sell : 0;
  } else if (input.segment === "equity_intraday") {
    stt = input.side === "sell" ? turnover * STT.equity_intraday_sell : 0;
  } else {
    stt = turnover * STT.equity_delivery;
  }

  const exchangeTxn =
    input.segment === "options"
      ? turnover * EXCHANGE_TXN.nse_options
      : input.segment === "futures"
        ? turnover * EXCHANGE_TXN.nse_futures
        : turnover * EXCHANGE_TXN.nse_equity;

  const sebi = turnover * SEBI_RATE;

  let stamp = 0;
  if (input.side === "buy") {
    if (input.segment === "options") stamp = turnover * STAMP.options_buy;
    else if (input.segment === "futures") stamp = turnover * STAMP.futures_buy;
    else if (input.segment === "equity_intraday") stamp = turnover * STAMP.equity_intraday_buy;
    else stamp = turnover * STAMP.equity_delivery_buy;
  }

  const gst = GST_RATE * (brokerage + exchangeTxn + sebi);

  const total = brokerage + stt + exchangeTxn + sebi + stamp + gst;
  const r = (x: number) => Math.round(x * 100) / 100;
  return {
    brokerage: r(brokerage),
    stt: r(stt),
    exchangeTxn: r(exchangeTxn),
    sebi: r(sebi),
    stamp: r(stamp),
    gst: r(gst),
    total: r(total),
  };
}

/** Ek round-trip (entry + exit) ka total charge. */
export function roundTripCharges(opts: {
  broker: string;
  qty: number;
  entry: number;
  exit: number;
  segment?: "options" | "futures" | "equity_intraday";
}): ChargeBreakdown & { entryCharges: ChargeBreakdown; exitCharges: ChargeBreakdown } {
  const segment = opts.segment ?? "options";
  const entryCharges = orderCharges({ broker: opts.broker, segment, side: "buy", qty: opts.qty, price: opts.entry });
  const exitCharges = orderCharges({ broker: opts.broker, segment, side: "sell", qty: opts.qty, price: opts.exit });
  const sum = (k: keyof ChargeBreakdown): number =>
    Math.round((entryCharges[k] + exitCharges[k]) * 100) / 100;
  return {
    entryCharges,
    exitCharges,
    brokerage: sum("brokerage"),
    stt: sum("stt"),
    exchangeTxn: sum("exchangeTxn"),
    sebi: sum("sebi"),
    stamp: sum("stamp"),
    gst: sum("gst"),
    total: sum("total"),
  };
}

/** Kitne point premium move pe trade break-even hota hai (charges cover). */
export function breakevenPoints(broker: string, qty: number, premium: number): number {
  const c = roundTripCharges({ broker, qty, entry: premium, exit: premium }).total;
  return c / qty;
}

/** Charges as % of premium turnover — sasta option = bada drag. */
export function costPctOfPremium(broker: string, qty: number, premium: number): number {
  const turnover = qty * premium;
  if (turnover <= 0) return 0;
  const c = roundTripCharges({ broker, qty, entry: premium, exit: premium }).total;
  return (c / turnover) * 100;
}

/**
 * ITM expiry pe exercise charge (0.125% intrinsic) — isse bachne ke liye
 * expiry se pehle square-off karo (ya ITM options bech do).
 */
export function exerciseCharge(qty: number, intrinsic: number): number {
  return Math.round(qty * intrinsic * STT.options_exercise * 100) / 100;
}
