/**
 * zerodha.ts — Zerodha Kite Connect v3 adapter.
 *
 * Zerodha me symbol directly ban jaata hai (instrument master ki zarurat nahi):
 *   index spot : NSE:NIFTY 50 / NSE:NIFTY BANK / BSE:SENSEX
 *   option     : NFO:NIFTY26FEB24000CE   (monthly)
 *                NFO:NIFTY2621724000CE   (weekly — YY + M + DD)
 *
 * Login flow: browser se request_token lo → session generate karo → access_token
 * (roz subah naya). Yahan hum .env ka ZERODHA_ACCESS_TOKEN use karte hain —
 * scripts/zerodha-login.md me steps likhe hain.
 */

import { config } from "../config.ts";
import { round2 } from "../util.ts";
import { indexMeta, optionSymbol } from "../market/instruments.ts";
import type { Quote, OptionRef } from "../market/feed.ts";
import { brokerCall } from "./http.ts";
import type { Broker, BrokerPosition, MarginInfo, OrderRequest, OrderResult, OrderStatus } from "./types.ts";
import { BrokerError } from "./types.ts";

const BASE = "https://api.kite.trade";

interface KiteQuote {
  last_price: number;
  volume?: number;
  ohlc?: { open: number; high: number; low: number; close: number };
  buy?: Array<{ price: number; quantity: number }>;
  sell?: Array<{ price: number; quantity: number }>;
  depth?: { buy: Array<{ price: number }>; sell: Array<{ price: number }> };
}

interface KiteOrder {
  order_id: string;
  status: string;
  filled_quantity: number;
  average_price: number;
  quantity: number;
  transaction_type: "BUY" | "SELL";
  order_type: string;
  tradingsymbol: string;
  price: number;
  trigger_price: number;
  status_message?: string;
  order_timestamp?: string;
}

/** Kite ka weekly format: NIFTY2621724000CE (YY + single-digit month + DD). */
export function kiteExpiryCode(expiryCode: string, weekly: boolean): string {
  if (!weekly) return expiryCode; // YYMMM already
  const yy = expiryCode.slice(0, 2);
  const mm = expiryCode.slice(2, 4);
  const dd = expiryCode.slice(4, 6);
  return `${yy}${Number(mm)}${dd}`;
}

export class ZerodhaBroker implements Broker {
  readonly name = "zerodha";
  readonly simulated = false;
  private headers: Record<string, string>;

  constructor(creds = config.credentials["zerodha"] as Record<string, string>) {
    const { apiKey, accessToken } = creds;
    if (!apiKey || !accessToken) {
      throw new BrokerError(
        "ZERODHA_API_KEY / ZERODHA_ACCESS_TOKEN missing. .env bharo (roz naya access_token chahiye).",
        "zerodha",
      );
    }
    this.headers = {
      "X-Kite-Version": "3",
      Authorization: `token ${apiKey}:${accessToken}`,
    };
  }

  async init(): Promise<void> {
    // profile call se token verify
    await brokerCall<{ data: { user_id: string } }>(`${BASE}/user/profile`, { headers: this.headers, broker: this.name });
  }

  quoteSymbolFor(index: string): string {
    return indexMeta(index).spotSymbol["zerodha"]!;
  }

  optionSymbolFor(ref: OptionRef): string {
    const meta = indexMeta(ref.index);
    const code = kiteExpiryCode(ref.expiryCode, ref.expiryWeekly);
    return `${meta.exchange}:${meta.symbolPrefix}${code}${ref.strike}${ref.optType}`;
  }

  async quotes(symbols: string[]): Promise<Quote[]> {
    if (!symbols.length) return [];
    const qs = symbols.map((s) => `i=${encodeURIComponent(s)}`).join("&");
    const res = await brokerCall<{ data: Record<string, KiteQuote> }>(`${BASE}/quote?${qs}`, {
      headers: this.headers,
      broker: this.name,
    });
    const out: Quote[] = [];
    for (const [symbol, q] of Object.entries(res.data ?? {})) {
      out.push({
        symbol,
        ts: Date.now(),
        ltp: q.last_price,
        bid: q.depth?.buy?.[0]?.price ?? q.buy?.[0]?.price ?? q.last_price,
        ask: q.depth?.sell?.[0]?.price ?? q.sell?.[0]?.price ?? q.last_price,
        volume: q.volume,
      });
    }
    return out;
  }

  async ltp(symbol: string): Promise<number> {
    const q = await this.quotes([symbol]);
    if (!q.length) throw new BrokerError(`zerodha: "${symbol}" ka quote nahi mila`, this.name);
    return q[0]!.ltp;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const meta = indexMeta(req.index);
    const tradingsymbol = `${meta.symbolPrefix}${kiteExpiryCode(req.expiryCode, req.expiryWeekly)}${req.strike}${req.optType}`;
    const orderType = req.orderType === "SL-M" ? "SL-M" : req.orderType;
    const body: Record<string, string> = {
      tradingsymbol,
      exchange: meta.exchange,
      transaction_type: req.side.toUpperCase(),
      order_type: orderType,
      quantity: String(req.qty),
      product: req.product ?? config.broker.product,
      validity: "DAY",
      tag: (req.tag ?? "algo").slice(0, 20),
    };
    if (req.price !== undefined) body.price = String(req.price);
    if (req.triggerPrice !== undefined) body.trigger_price = String(req.triggerPrice);

    const res = await brokerCall<{ data: { order_id: string } }>(`${BASE}/orders/regular`, {
      method: "POST",
      headers: this.headers,
      body,
      form: true,
      broker: this.name,
    });
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
    await brokerCall(`${BASE}/orders/regular/${id}`, { method: "DELETE", headers: this.headers, broker: this.name });
  }

  async orderStatus(id: string): Promise<OrderResult | undefined> {
    const res = await brokerCall<{ data: KiteOrder[] }>(`${BASE}/orders/${id}`, { headers: this.headers, broker: this.name });
    const o = res.data?.[res.data.length - 1];
    if (!o) return undefined;
    return {
      id: o.order_id,
      symbol: o.tradingsymbol,
      side: o.transaction_type === "BUY" ? "buy" : "sell",
      qty: o.quantity,
      filledQty: o.filled_quantity,
      avgPrice: round2(o.average_price),
      status: mapStatus(o.status),
      orderType: o.order_type as OrderResult["orderType"],
      price: o.price,
      triggerPrice: o.trigger_price,
      ts: Date.now(),
      message: o.status_message,
    };
  }

  async orders(): Promise<OrderResult[]> {
    const res = await brokerCall<{ data: KiteOrder[] }>(`${BASE}/orders`, { headers: this.headers, broker: this.name });
    return (res.data ?? []).map((o) => ({
      id: o.order_id,
      symbol: o.tradingsymbol,
      side: o.transaction_type === "BUY" ? ("buy" as const) : ("sell" as const),
      qty: o.quantity,
      filledQty: o.filled_quantity,
      avgPrice: round2(o.average_price),
      status: mapStatus(o.status),
      orderType: o.order_type as OrderResult["orderType"],
      ts: Date.now(),
    }));
  }

  async positions(): Promise<BrokerPosition[]> {
    const res = await brokerCall<{ data: { net: Array<{ tradingsymbol: string; quantity: number; average_price: number; last_price: number; pnl: number }> } }>(
      `${BASE}/portfolio/positions`,
      { headers: this.headers, broker: this.name },
    );
    return (res.data?.net ?? []).map((p) => ({
      symbol: p.tradingsymbol,
      qty: p.quantity,
      avgPrice: round2(p.average_price),
      ltp: round2(p.last_price),
      pnl: round2(p.pnl),
    }));
  }

  async margins(): Promise<MarginInfo> {
    const res = await brokerCall<{ data: { equity: { available: { live_balance: number }; utilised: { debits: number } } } }>(
      `${BASE}/user/margins/equity`,
      { headers: this.headers, broker: this.name },
    );
    const avail = res.data?.equity?.available?.live_balance ?? 0;
    const used = res.data?.equity?.utilised?.debits ?? 0;
    return { cash: round2(avail + used), used: round2(used), available: round2(avail) };
  }

  async squareOffAll(): Promise<void> {
    for (const o of await this.orders()) {
      if (o.status === "OPEN" || o.status === "PENDING") {
        try {
          await this.cancelOrder(o.id);
        } catch {
          /* already gone */
        }
      }
    }
    for (const p of await this.positions()) {
      if (p.qty === 0) continue;
      const side = p.qty > 0 ? "sell" : "buy";
      const meta = indexMeta(config.market.symbol);
      // NOTE: position symbol parse karke order bhejna padega — yahan simple path:
      await brokerCall(`${BASE}/orders/regular`, {
        method: "POST",
        headers: this.headers,
        form: true,
        body: {
          tradingsymbol: p.symbol,
          exchange: meta.exchange,
          transaction_type: side.toUpperCase(),
          order_type: "MARKET",
          quantity: String(Math.abs(p.qty)),
          product: config.broker.product,
          validity: "DAY",
          tag: "squareoff",
        },
        broker: this.name,
      });
    }
  }
}

function mapStatus(s: string): OrderStatus {
  const u = s.toUpperCase();
  if (u === "COMPLETE") return "COMPLETE";
  if (u === "REJECTED") return "REJECTED";
  if (u === "CANCELLED" || u === "CANCELLED AMO") return "CANCELLED";
  if (u === "OPEN" || u === "TRIGGER PENDING") return "OPEN";
  return "PENDING";
}

void optionSymbol;
