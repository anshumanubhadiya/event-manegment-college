/**
 * upstox.ts — Upstox API v2 adapter.
 *
 * Orders "instrument_token" (instrument_key) se jaate hain — wo complete.json.gz
 * master se aate hain (ek baar download + cache).
 *   index  : NSE_INDEX|Nifty 50
 *   option : NSE_FO|NIFTY26FEB24000CE — instrument_key = "NSE_FO|<instrument_token>"
 */

import { config } from "../config.ts";
import { round2 } from "../util.ts";
import { indexMeta } from "../market/instruments.ts";
import type { Quote, OptionRef } from "../market/feed.ts";
import { brokerCall } from "./http.ts";
import { cachedDownload, parseCsv } from "./masters.ts";
import type { Broker, BrokerPosition, MarginInfo, OrderRequest, OrderResult, OrderStatus } from "./types.ts";
import { BrokerError } from "./types.ts";

const BASE = "https://api.upstox.com/v2";
// Upstox instruments: complete.json.gz (JSON). Kuch accounts ke liye CSV bhi hoti hai.
const MASTER_URL = "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

interface UpstoxRow {
  instrument_key?: string;
  trading_symbol?: string;
  name?: string;
  exchange?: string;
  segment?: string;
  instrument_type?: string;
}

export class UpstoxBroker implements Broker {
  readonly name = "upstox";
  readonly simulated = false;
  private headers: Record<string, string>;
  private keyBySymbol = new Map<string, string>();
  private loaded = false;

  constructor(creds = config.credentials["upstox"] as Record<string, string>) {
    if (!creds.accessToken) throw new BrokerError("UPSTOX_ACCESS_TOKEN missing (.env)", "upstox");
    this.headers = { Accept: "application/json", Authorization: `Bearer ${creds.accessToken}` };
  }

  async init(): Promise<void> {
    await brokerCall<{ status?: string }>(`${BASE}/user/profile`, { headers: this.headers, broker: this.name });
    await this.loadMaster();
  }

  private async loadMaster(): Promise<void> {
    if (this.loaded) return;
    const text = await cachedDownload(MASTER_URL, "upstox-instruments.json", { gzip: true });
    const rows = JSON.parse(text) as UpstoxRow[];
    for (const r of rows) {
      if (!r.trading_symbol || !r.instrument_key) continue;
      if (r.exchange !== "NSE" && r.exchange !== "BSE") continue;
      if (r.segment && !/FO/.test(r.segment)) continue;
      this.keyBySymbol.set(r.trading_symbol, r.instrument_key);
    }
    this.loaded = true;
    if (!this.keyBySymbol.size) {
      console.warn("[upstox] master khali laga — format badla ho sakta hai, docs/BROKERS.md dekho");
    }
  }

  private keyFor(tradingsymbol: string, exchange: "NSE" | "BSE"): string {
    const k = this.keyBySymbol.get(tradingsymbol);
    if (!k) throw new BrokerError(`Upstox: "${tradingsymbol}" ka instrument_key nahi mila (master refresh karo)`, this.name);
    return `${exchange}_FO|${k}`;
  }

  quoteSymbolFor(index: string): string {
    return indexMeta(index).spotSymbol["upstox"]!; // "NSE_INDEX|Nifty 50"
  }

  optionSymbolFor(ref: OptionRef): string {
    const meta = indexMeta(ref.index);
    const tradingsymbol = `${meta.symbolPrefix}${ref.expiryCode}${ref.strike}${ref.optType}`;
    return this.keyFor(tradingsymbol, meta.exchange === "BFO" ? "BSE" : "NSE");
  }

  async quotes(symbols: string[]): Promise<Quote[]> {
    if (!symbols.length) return [];
    const qs = symbols.map((s) => `instrument_key=${encodeURIComponent(s)}`).join("&");
    const res = await brokerCall<{ data?: Record<string, { last_price: number; volume?: number; depth?: { buy?: Array<{ price: number }>; sell?: Array<{ price: number }> } }> }>(
      `${BASE}/market-quote/quotes?${qs}`,
      { headers: this.headers, broker: this.name },
    );
    const out: Quote[] = [];
    for (const [key, q] of Object.entries(res.data ?? {})) {
      out.push({
        symbol: key.split("|")[0] ? key : key,
        ts: Date.now(),
        ltp: q.last_price,
        bid: q.depth?.buy?.[0]?.price ?? q.last_price,
        ask: q.depth?.sell?.[0]?.price ?? q.last_price,
        volume: q.volume,
      });
    }
    return out;
  }

  async ltp(symbol: string): Promise<number> {
    const res = await brokerCall<{ data?: Record<string, { last_price: number }> }>(
      `${BASE}/market-quote/ltp?instrument_key=${encodeURIComponent(symbol)}`,
      { headers: this.headers, broker: this.name },
    );
    const first = Object.values(res.data ?? {})[0];
    if (!first) throw new BrokerError(`upstox: "${symbol}" LTP nahi mila`, this.name);
    return first.last_price;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const meta = indexMeta(req.index);
    const tradingsymbol = `${meta.symbolPrefix}${req.expiryCode}${req.strike}${req.optType}`;
    const instrument_token = this.keyFor(tradingsymbol, meta.exchange === "BFO" ? "BSE" : "NSE");
    const body: Record<string, unknown> = {
      quantity: req.qty,
      product: config.broker.product === "MIS" ? "I" : "D",
      validity: "DAY",
      price: req.price ?? 0,
      tag: (req.tag ?? "algo").slice(0, 20),
      instrument_token,
      order_type: req.orderType === "SL-M" ? "SL-M" : req.orderType,
      transaction_type: req.side === "buy" ? "BUY" : "SELL",
      disclosed_quantity: 0,
      trigger_price: req.triggerPrice ?? 0,
      is_amo: false,
    };
    const res = await brokerCall<{ data?: { order_id?: string }; errors?: Array<{ message: string }> }>(`${BASE}/order/place`, {
      method: "POST",
      headers: this.headers,
      body,
      broker: this.name,
    });
    if (!res.data?.order_id) {
      throw new BrokerError(`Upstox order reject: ${res.errors?.[0]?.message ?? JSON.stringify(res)}`, this.name);
    }
    return {
      id: res.data.order_id,
      symbol: req.symbol,
      side: req.side,
      qty: req.qty,
      filledQty: 0,
      avgPrice: 0,
      status: "OPEN",
      orderType: req.orderType,
      price: req.price,
      triggerPrice: req.triggerPrice,
      ts: Date.now(),
    };
  }

  async cancelOrder(id: string): Promise<void> {
    await brokerCall(`${BASE}/order/cancel?order_id=${id}`, { method: "DELETE", headers: this.headers, broker: this.name });
  }

  async orderStatus(id: string): Promise<OrderResult | undefined> {
    const res = await brokerCall<{ data?: Array<Record<string, unknown>> }>(`${BASE}/order/history?order_id=${id}`, {
      headers: this.headers,
      broker: this.name,
    });
    const o = res.data?.[0];
    if (!o) return undefined;
    return {
      id,
      symbol: String(o["trading_symbol"] ?? o["tradingsymbol"] ?? ""),
      side: String(o["transaction_type"] ?? "BUY").toUpperCase() === "BUY" ? ("buy" as const) : ("sell" as const),
      qty: Number(o["quantity"] ?? 0),
      filledQty: Number(o["filled_quantity"] ?? 0),
      avgPrice: round2(Number(o["average_price"] ?? 0)),
      status: mapUpstoxStatus(String(o["status"] ?? "")),
      orderType: "MARKET" as const,
      ts: Date.now(),
    };
  }

  async orders(): Promise<OrderResult[]> {
    const res = await brokerCall<{ data?: Array<Record<string, unknown>> }>(`${BASE}/order/retrieve-all`, {
      headers: this.headers,
      broker: this.name,
    });
    return (res.data ?? []).map((o) => ({
      id: String(o["order_id"] ?? ""),
      symbol: String(o["trading_symbol"] ?? o["tradingsymbol"] ?? ""),
      side: String(o["transaction_type"] ?? "BUY").toUpperCase() === "BUY" ? ("buy" as const) : ("sell" as const),
      qty: Number(o["quantity"] ?? 0),
      filledQty: Number(o["filled_quantity"] ?? 0),
      avgPrice: round2(Number(o["average_price"] ?? 0)),
      status: mapUpstoxStatus(String(o["status"] ?? "")),
      orderType: "MARKET" as const,
      ts: Date.now(),
    }));
  }

  async positions(): Promise<BrokerPosition[]> {
    const res = await brokerCall<{ data?: Array<Record<string, unknown>> }>(`${BASE}/portfolio/short-term-positions`, {
      headers: this.headers,
      broker: this.name,
    });
    return (res.data ?? [])
      .filter((p) => Number(p["quantity"] ?? 0) !== 0)
      .map((p) => ({
        symbol: String(p["trading_symbol"] ?? p["tradingsymbol"] ?? ""),
        qty: Number(p["quantity"] ?? 0),
        avgPrice: round2(Number(p["average_price"] ?? 0)),
        ltp: round2(Number(p["last_price"] ?? 0)),
        pnl: round2(Number(p["pnl"] ?? 0)),
      }));
  }

  async margins(): Promise<MarginInfo> {
    const res = await brokerCall<{ data?: { equity?: { available_margin?: number; used_margin?: number } } }>(
      `${BASE}/user/get-funds-and-margin?segment=SEC`,
      { headers: this.headers, broker: this.name },
    );
    const avail = res.data?.equity?.available_margin ?? 0;
    const used = res.data?.equity?.used_margin ?? 0;
    return { cash: round2(avail + used), used: round2(used), available: round2(avail) };
  }
}

function mapUpstoxStatus(s: string): OrderStatus {
  const u = s.toLowerCase();
  if (u.includes("complete")) return "COMPLETE";
  if (u.includes("reject")) return "REJECTED";
  if (u.includes("cancel")) return "CANCELLED";
  if (u.includes("open") || u.includes("trigger") || u.includes("pending")) return "OPEN";
  return "PENDING";
}

void parseCsv;
