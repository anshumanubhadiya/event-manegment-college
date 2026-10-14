/**
 * instruments.ts — index F&O metadata: lot size, strike step, expiry, symbol.
 *
 * ⚠️  Ye values exchange notifications se badalti rehti hain (SEBI ne 2024-25 me
 *     lot size aur expiry day dono badle). Live jaane se pehle broker ke
 *     instrument master (JSON/CSV) se VERIFY karo — config me override bhi hai.
 */

import { config } from "../config.ts";
import { istParts, parseHhmm } from "../util.ts";
import { isHoliday } from "./calendar.ts";

export type IndexSymbol = "NIFTY" | "BANKNIFTY" | "SENSEX" | "FINNIFTY" | "MIDCPNIFTY" | "BANKEX";

export interface IndexMeta {
  name: IndexSymbol;
  exchange: "NFO" | "BFO";
  lotSize: number;
  strikeStep: number;
  /** 0=Sunday..6=Saturday — weekly expiry ka din (null = sirf monthly expiry) */
  weeklyExpiryDay: number | null;
  /** Monthly expiry ka din (last <day> of month) */
  monthlyExpiryDay: number;
  symbolPrefix: string;
  /** Broker quote symbol (index spot) */
  spotSymbol: Record<string, string>;
}

const META: Record<IndexSymbol, IndexMeta> = {
  NIFTY: {
    name: "NIFTY",
    exchange: "NFO",
    lotSize: 75,
    strikeStep: 50,
    weeklyExpiryDay: 2, // Tuesday (SEBI 2025 change: NSE weekly = Tuesday)
    monthlyExpiryDay: 2,
    symbolPrefix: "NIFTY",
    spotSymbol: { zerodha: "NSE:NIFTY 50", angel: "99926000", fyers: "NSE:NIFTY50-INDEX", upstox: "NSE_INDEX|Nifty 50", dhan: "13" },
  },
  BANKNIFTY: {
    name: "BANKNIFTY",
    exchange: "NFO",
    lotSize: 35,
    strikeStep: 100,
    weeklyExpiryDay: null, // weekly band (monthly only)
    monthlyExpiryDay: 3, // last Wednesday
    symbolPrefix: "BANKNIFTY",
    spotSymbol: { zerodha: "NSE:NIFTY BANK", angel: "99926009", fyers: "NSE:NIFTYBANK-INDEX", upstox: "NSE_INDEX|Nifty Bank", dhan: "25" },
  },
  FINNIFTY: {
    name: "FINNIFTY",
    exchange: "NFO",
    lotSize: 65,
    strikeStep: 50,
    weeklyExpiryDay: null,
    monthlyExpiryDay: 2,
    symbolPrefix: "FINNIFTY",
    spotSymbol: { zerodha: "NSE:NIFTY FIN SERVICE", angel: "99926037", fyers: "NSE:FINNIFTY-INDEX", upstox: "NSE_INDEX|Nifty Fin Service", dhan: "27" },
  },
  MIDCPNIFTY: {
    name: "MIDCPNIFTY",
    exchange: "NFO",
    lotSize: 120,
    strikeStep: 25,
    weeklyExpiryDay: null,
    monthlyExpiryDay: 1,
    symbolPrefix: "MIDCPNIFTY",
    spotSymbol: { zerodha: "NSE:NIFTY MID SELECT", angel: "99926074", fyers: "NSE:MIDCPNIFTY-INDEX", upstox: "NSE_INDEX|NIFTY MID SELECT", dhan: "26" },
  },
  BANKEX: {
    name: "BANKEX",
    exchange: "BFO",
    lotSize: 30,
    strikeStep: 100,
    weeklyExpiryDay: null,
    monthlyExpiryDay: 1,
    symbolPrefix: "BANKEX",
    spotSymbol: { zerodha: "BSE:SENSEX", angel: "99919000", fyers: "BSE:BANKEX-INDEX", upstox: "BSE_INDEX|BANKEX", dhan: "" },
  },
  SENSEX: {
    name: "SENSEX",
    exchange: "BFO",
    lotSize: 20,
    strikeStep: 100,
    weeklyExpiryDay: 4, // Thursday (BSE weekly)
    monthlyExpiryDay: 4,
    symbolPrefix: "SENSEX",
    spotSymbol: { zerodha: "BSE:SENSEX", angel: "99919000", fyers: "BSE:SENSEX-INDEX", upstox: "BSE_INDEX|SENSEX", dhan: "51" },
  },
};

export function indexMeta(symbol: string): IndexMeta {
  const s = symbol.toUpperCase() as IndexSymbol;
  const meta = META[s];
  if (!meta) {
    throw new Error(`Index "${symbol}" support nahi hai. Allowed: ${Object.keys(META).join(", ")}`);
  }
  const override = config.indexes.lotSizeOverride[meta.name];
  return override ? { ...meta, lotSize: override } : meta;
}

export function allIndexes(): IndexMeta[] {
  return Object.values(META);
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** Date ko aage badhao jab tak trading day na mil jaye (holiday/weekend skip). */
function shiftToTradingDay(d: Date): Date {
  const out = new Date(d.getTime());
  for (let i = 0; i < 10; i++) {
    const key = istParts(out.getTime()).dateKey;
    const wd = istParts(out.getTime()).weekday;
    if (wd !== 0 && wd !== 6 && !isHoliday(key)) return out;
    out.setUTCDate(out.getUTCDate() + 1);
  }
  return out;
}

// IST me ek date banao (sirf date chahiye)
function istDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day) - 5.5 * 3600 * 1000);
}

export interface ExpiryInfo {
  date: Date;
  /** NSE/BSE trading symbol suffix — weekly: YYMMDD, monthly: YYMMM */
  code: string;
  weekly: boolean;
  daysToExpiry: number;
  dateKey: string;
}

/**
 * Agli expiry. Weekly index ke liye is hafte ka expiry (agar guzar gaya to next),
 * monthly-only index ke liye last <weekday> of month.
 */
export function nextExpiry(symbol: string, from: Date = new Date()): ExpiryInfo {
  const meta = indexMeta(symbol);
  const p = istParts(from.getTime());
  const todayMin = p.minuteOfDay;
  const expiryCutoff = 15 * 60 + 30; // expiry din close tak trade hota hai

  if (meta.weeklyExpiryDay !== null) {
    // is hafte ka expiry
    const delta = (meta.weeklyExpiryDay - p.weekday + 7) % 7;
    let d = istDate(p.year, p.month, p.day + delta);
    if (delta === 0 && todayMin > expiryCutoff) {
      d = istDate(p.year, p.month, p.day + 7);
    }
    d = shiftToTradingDay(d);
    const ep = istParts(d.getTime());
    return {
      date: d,
      code: `${String(ep.year).slice(2)}${String(ep.month).padStart(2, "0")}${String(ep.day).padStart(2, "0")}`,
      weekly: true,
      daysToExpiry: daysBetween(from, d),
      dateKey: ep.dateKey,
    };
  }

  // monthly: is mahine ka last <weekday>, guzar gaya to agle mahine ka
  let year = p.year;
  let month = p.month;
  let d = lastWeekdayOfMonth(year, month, meta.monthlyExpiryDay);
  if (d.getTime() < from.getTime() && !(p.dateKey === istParts(d.getTime()).dateKey && todayMin <= expiryCutoff)) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    d = lastWeekdayOfMonth(year, month, meta.monthlyExpiryDay);
  }
  d = shiftToTradingDay(d);
  const ep = istParts(d.getTime());
  return {
    date: d,
    code: `${String(ep.year).slice(2)}${MONTHS[ep.month - 1]!}`,
    weekly: false,
    daysToExpiry: daysBetween(from, d),
    dateKey: ep.dateKey,
  };
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  let d = istDate(year, month + 1, 0); // last day of month
  while (istParts(d.getTime()).weekday !== weekday) {
    d = istDate(year, month, istParts(d.getTime()).day - 1);
  }
  return d;
}

function daysBetween(a: Date, b: Date): number {
  const pa = istParts(a.getTime());
  const pb = istParts(b.getTime());
  const da = Date.UTC(pa.year, pa.month - 1, pa.day);
  const db = Date.UTC(pb.year, pb.month - 1, pb.day);
  return Math.round((db - da) / 86_400_000);
}

/** ATM strike (nearest strike to spot). */
export function atmStrike(symbol: string, spot: number): number {
  const meta = indexMeta(symbol);
  return Math.round(spot / meta.strikeStep) * meta.strikeStep;
}

/**
 * Strike choose karo. CE me "OTM1" = strike + step (upar), PE me neeche.
 * ITM ulta. ATM = nearest.
 */
export function strikeFor(symbol: string, spot: number, optionType: "CE" | "PE", moneyness: string): number {
  const meta = indexMeta(symbol);
  const atm = atmStrike(symbol, spot);
  const m = /^(ATM|ITM|OTM)(\d*)$/i.exec(moneyness.trim());
  if (!m) throw new Error(`INSTRUMENT "${moneyness}" galat. ATM | ITM1 | ITM2 | OTM1 | OTM2`);
  const kind = m[1]!.toUpperCase();
  const steps = Number(m[2] || "0");
  if (kind === "ATM" || steps === 0) return atm;
  const awayFromMoney = kind === "OTM" ? steps : -steps;
  const dir = optionType === "CE" ? 1 : -1;
  const strike = atm + dir * awayFromMoney * meta.strikeStep;
  return strike > 0 ? strike : atm;
}

/** NSE/BSE option trading symbol. Weekly: NIFTY26021124000CE (style varies by broker master) */
export function optionSymbol(symbol: string, strike: number, optionType: "CE" | "PE", expiry: ExpiryInfo): string {
  const meta = indexMeta(symbol);
  const strikeCode = Number.isInteger(strike) ? String(strike) : strike.toFixed(1);
  return `${meta.symbolPrefix}${expiry.code}${strikeCode}${optionType.toUpperCase()}`;
}

/** Broker ke liye spot symbol. */
export function spotSymbolFor(symbol: string, broker: string): string {
  const meta = indexMeta(symbol);
  return meta.spotSymbol[broker] ?? meta.spotSymbol["zerodha"] ?? "";
}

/** Expiry ke din ko "expiry day" maano (afternoon me intraday gamma risk). */
export function isExpiryDay(symbol: string, ts: number): boolean {
  const exp = nextExpiry(symbol, new Date(ts));
  return exp.dateKey === istParts(ts).dateKey;
}

/** Expiry ke din ka time-based lot reduce (expiry day pe risk kam karo). */
/**
 * Expiry day ka size factor. Expiry ke din 14:00 ke baad gamma/theta bahut tez
 * hota hai — lots aadhe kar dete hain (baaki din 1.0).
 */
export function expiryDayLotFactor(symbol: string, ts: number): number {
  if (!isExpiryDay(symbol, ts)) return 1;
  const p = istParts(ts);
  return p.minuteOfDay >= 14 * 60 ? 0.5 : 1;
}

export function parseNoTradeTime(): number {
  const [h, m] = parseHhmm(config.risk.noTradeBefore);
  return h * 60 + m;
}
