/**
 * fyers.ts — Fyers API v3 adapter.
 *
 * Fyers me bhi symbol direct banta hai:
 *   index  : NSE:NIFTY50-INDEX, BSE:SENSEX-INDEX
 *   option : NSE:NIFTY26FEB24000CE (weekly = YY+MM+DD, monthly = YY+MMM)
 *
 * Auth: client_id (jaise "ABC12345-100") + access_token, header
 * `Authorization: {client_id}:{access_token}`. Access token daily refresh hota hai.
 */

import { config } from "../config.ts";
import { round2 } from "../util.ts";
import { indexMeta } from "../market/instruments.ts";
import type { Quote, OptionRef } from "../market/feed.ts";
import { brokerCall } from "./http.ts";
import type { Broker, BrokerPosition, MarginInfo, OrderRequest, OrderResult, OrderStatus } from "./types.ts";
import { BrokerError } from "./types.ts";

const BASE = "https://api-t1.fyers.in/api/v3";

interface FyersQuote {
  n?: string;
  s?: string;
  v?: { cmd?: { c?: string } };
  lp?: number;
  bid?: number;
  ask?: number;
  volume?: number;
}

export class FyersBroker implements Broker {
  readonly name = "fyers";
  readonly simulated = false;
  private headers: Record<string, string>;
  private clientId: string;

  constructor(creds = config.credentials["fyers"] as Record<string, string>) {
    const { clientId, accessToken } = creds;
    if (!clientId || !accessToken) {
      throw new BrokerError("FYERS_CLIENT_ID / FYERS_ACCESS_TOKEN missing (.env). Token daily refresh hota hai.", "fyers");
    }
    this.clientId = clientId;
    this.headers = { Authorization: `${clientId}:${accessToken}` };
  }

  async init(): Promise<void> {
    const res = await brokerCall<{ s?: string; code?: number }>(`${BASE}/profile`, { headers: this.headers, broker: this.name });
    if (res && res.s === "error") throw new BrokerError("Fyers profile call fail — access token check karo", this.name);
  }

  quoteSymbolFor(index: string): string {
    return indexMeta(index).spotSymbol["fyers"]!;
  }

  optionSymbolFor(ref: OptionRef): string {
    const meta = indexMeta(ref.index);
    const prefix = meta.exchange === "BFO" ? "BSE" : "NSE";
    return `${prefix}:${meta.symbolPrefix}${ref.expiryCode}${ref.strike}${ref.optType}`;
  }

  async quotes(symbols: string[]): Promise<Quote[]> {
    if (!symbols.length) return [];
    const res = await brokerCall<{ d?: FyersQuote[] }>(`${BASE}/data/quotes?symbols=${encodeURIComponent(symbols.join(","))}`, {
      headers: this.headers,
      broker: this.name,
    });
    return (res.d ?? []).map((q) => ({
      symbol: q.n ?? "",
      ts: Date.now(),
      ltp: Number(q.lp ?? q.v?.cmd?.c ?? 0),
      bid: Number(q.bid ?? q.lp ?? 0),
      ask: Number(q.ask ?? q.lp ?? 0),
      volume: q.volume,
    }));
  }

  async ltp(symbol: string): Promise<number> {
    const q = await this.quotes([symbol]);
    if (!q.length) throw new BrokerError(`fyers: "${symbol}" quote nahi mila`, this.name);
    return q[0]!.ltp;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const symbol = this.optionSymbolFor({
      symbol: req.symbol,
      index: req.index,
      strike: req.strike,
      optType: req.optType,
      expiryCode: req.expiryCode,
      expiryDate: "",
      expiryWeekly: req.expiryWeekly,
      dteDays: 0,
    });
    const typeMap: Record<string, number> = { LIMIT: 1, MARKET: 2, SL: 3, "SL-M": 4 };
    const body: Record<string, unknown> = {
      symbol,
      qty: req.qty,
      type: typeMap[req.orderType] ?? 2,
      side: req.side === "buy" ? 1 : -1,
      productType: config.broker.product === "MIS" ? "INTRADAY" : "MARGIN",
      limitPrice: req.price ?? 0,
      stopPrice: req.triggerPrice ?? 0,
      validity: "DAY",
      disclosedQty: 0,
      offlineOrder: false,
    };
    const res = await brokerCall<{ id?: string; s?: string; message?: string }>(`${BASE}/orders`, {
      method: "POST",
      headers: this.headers,
      body,
      broker: this.name,
    });
    if (!res.id) throw new BrokerError(`fyers order reject: ${res.message ?? JSON.stringify(res)}`, this.name);
    return {
      id: res.id,
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
    await brokerCall(`${BASE}/orders/${id}`, { method: "DELETE", headers: this.headers, broker: this.name });
  }

  async orderStatus(id: string): Promise<OrderResult | undefined> {
    const all = await this.orders();
    return all.find((o) => o.id === id);
  }

  async orders(): Promise<OrderResult[]> {
    const res = await brokerCall<{ orderBook?: Array<Record<string, unknown>> }>(`${BASE}/orders`, {
      headers: this.headers,
      broker: this.name,
    });
    return (res.orderBook ?? []).map((o) => {
      const statusNum = Number(o["status"] ?? 0);
      return {
        id: String(o["id"] ?? ""),
        symbol: String(o["symbol"] ?? ""),
        side: Number(o["side"] ?? 1) === 1 ? ("buy" as const) : ("sell" as const),
        qty: Number(o["qty"] ?? 0),
        filledQty: Number(o["filledQty"] ?? 0),
        avgPrice: round2(Number(o["tradedPrice"] ?? 0)),
        status: mapFyersStatus(statusNum),
        orderType: "MARKET" as const,
        ts: Date.now(),
      };
    });
  }

  async positions(): Promise<BrokerPosition[]> {
    const res = await brokerCall<{ netPositions?: Array<Record<string, unknown>> }>(`${BASE}/positions`, {
      headers: this.headers,
      broker: this.name,
    });
    return (res.netPositions ?? [])
      .filter((p) => Number(p["netQty"] ?? 0) !== 0)
      .map((p) => ({
        symbol: String(p["symbol"] ?? ""),
        qty: Number(p["netQty"] ?? 0),
        avgPrice: round2(Number(p["netAvg"] ?? 0)),
        ltp: round2(Number(p["ltp"] ?? 0)),
        pnl: round2(Number(p["pl"] ?? 0)),
      }));
  }

  async margins(): Promise<MarginInfo> {
    const res = await brokerCall<{ fund_limit?: Array<{ id: number; title: string; equityAmount: number }> }>(`${BASE}/funds`, {
      headers: this.headers,
      broker: this.name,
    });
    const limits = res.fund_limit ?? [];
    const find = (t: string) => limits.find((l) => l.title?.toLowerCase().includes(t))?.equityAmount ?? 0;
    const available = find("available");
    const used = find("utilized");
    return { cash: round2(available + used), used: round2(used), available: round2(available) };
  }

  async squareOffAll(): Promise<void> {
    for (const o of await this.orders()) {
      if (o.status === "OPEN") {
        try {
          await this.cancelOrder(o.id);
        } catch {
          /* ignore */
        }
      }
    }
    for (const p of await this.positions()) {
      const symbol = p.symbol;
      await brokerCall(`${BASE}/orders`, {
        method: "POST",
        headers: this.headers,
        body: {
          symbol,
          qty: Math.abs(p.qty),
          type: 2,
          side: p.qty > 0 ? -1 : 1,
          productType: "INTRADAY",
          limitPrice: 0,
          stopPrice: 0,
          validity: "DAY",
          offlineOrder: false,
        },
        broker: this.name,
      });
    }
  }
}

function mapFyersStatus(s: number): OrderStatus {
  if (s === 2) return "COMPLETE";
  if (s === 1 || s === 6 || s === 7) return "OPEN";
  if (s === 5) return "REJECTED";
  if (s === 3 || s === 4) return "CANCELLED";
  return "PENDING";
}
