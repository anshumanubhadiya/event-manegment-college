/**
 * dhan.ts — DhanHQ v2 adapter.
 *
 * Dhan orders "securityId" se jaate hain — wo api-scrip-master.csv se aate hain.
 *   exchangeSegment: NSE_FNO / BSE_FNO
 *   productType    : INTRA (MIS) / CNC / MARGIN
 *   headers        : access-token
 */

import { config } from "../config.ts";
import { round2 } from "../util.ts";
import { indexMeta } from "../market/instruments.ts";
import type { Quote, OptionRef } from "../market/feed.ts";
import { brokerCall } from "./http.ts";
import { cachedDownload, parseCsv } from "./masters.ts";
import type { Broker, BrokerPosition, MarginInfo, OrderRequest, OrderResult, OrderStatus } from "./types.ts";
import { BrokerError } from "./types.ts";

const BASE = "https://api.dhan.co";
const MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master.csv";

export class DhanBroker implements Broker {
  readonly name = "dhan";
  readonly simulated = false;
  private headers: Record<string, string>;
  private clientId: string;
  private idBySymbol = new Map<string, string>();
  private loaded = false;

  constructor(creds = config.credentials["dhan"] as Record<string, string>) {
    if (!creds.accessToken || !creds.clientId) throw new BrokerError("DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN missing (.env)", "dhan");
    this.clientId = creds.clientId;
    this.headers = { "access-token": creds.accessToken, "Content-Type": "application/json", Accept: "application/json" };
  }

  async init(): Promise<void> {
    await brokerCall<{ dhanClientId?: string }>(`${BASE}/v2/fundlimit`, { headers: this.headers, broker: this.name });
    await this.loadMaster();
  }

  private async loadMaster(): Promise<void> {
    if (this.loaded) return;
    const text = await cachedDownload(MASTER_URL, "dhan-scrip-master.csv");
    const rows = parseCsv(text);
    for (const r of rows) {
      const semi = r["SEM_CUSTOM_SYMBOL"] ?? r["SEM_TRADING_SYMBOL"] ?? "";
      const id = r["SEM_SMST_SECURITY_ID"] ?? "";
      const exch = r["SEM_EXM_EXCH_ID"] ?? "";
      if (!semi || !id) continue;
      if (exch !== "NSE" && exch !== "BSE") continue;
      this.idBySymbol.set(semi, id);
    }
    this.loaded = true;
    if (!this.idBySymbol.size) console.warn("[dhan] scrip master parse hua par rows khali — CSV format check karo");
  }

  private securityId(tradingsymbol: string): string {
    const id = this.idBySymbol.get(tradingsymbol);
    if (!id) throw new BrokerError(`Dhan: "${tradingsymbol}" ka securityId nahi mila (master refresh karo)`, this.name);
    return id;
  }

  quoteSymbolFor(index: string): string {
    // Dhan index IDs: NIFTY 13, BANKNIFTY 25, SENSEX 51 (segment IDX_I)
    return `IDX_I:${indexMeta(index).spotSymbol["dhan"] || "13"}`;
  }

  optionSymbolFor(ref: OptionRef): string {
    const meta = indexMeta(ref.index);
    const tradingsymbol = `${meta.symbolPrefix}${ref.expiryCode}${ref.strike}${ref.optType}`;
    return `${meta.exchange === "BFO" ? "BSE_FNO" : "NSE_FNO"}:${this.securityId(tradingsymbol)}`;
  }

  async quotes(symbols: string[]): Promise<Quote[]> {
    const idxIds: number[] = [];
    const optIds: Record<string, number[]> = { NSE_FNO: [], BSE_FNO: [] };
    for (const s of symbols) {
      const [seg, id] = s.split(":");
      if (!seg || !id) continue;
      if (seg === "IDX_I") idxIds.push(Number(id));
      else if (seg in optIds) optIds[seg]!.push(Number(id));
    }
    const body: Record<string, number[]> = {};
    if (idxIds.length) body["IDX_I"] = idxIds;
    for (const [seg, ids] of Object.entries(optIds)) if (ids.length) body[seg] = ids;

    const res = await brokerCall<{ data?: Record<string, Record<string, { last_price?: number; ltp?: number; volume?: number }>> }>(
      `${BASE}/v2/marketfeed/ltp`,
      { method: "POST", headers: this.headers, body, broker: this.name },
    );
    const out: Quote[] = [];
    for (const [seg, byId] of Object.entries(res.data ?? {})) {
      for (const [id, q] of Object.entries(byId ?? {})) {
        const ltp = Number(q.last_price ?? q.ltp ?? 0);
        out.push({ symbol: `${seg}:${id}`, ts: Date.now(), ltp, bid: ltp, ask: ltp, volume: Number(q.volume ?? 0) });
      }
    }
    return out;
  }

  async ltp(symbol: string): Promise<number> {
    const q = await this.quotes([symbol]);
    if (!q.length) throw new BrokerError(`dhan: "${symbol}" LTP nahi mila`, this.name);
    return q[0]!.ltp;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const meta = indexMeta(req.index);
    const tradingsymbol = `${meta.symbolPrefix}${req.expiryCode}${req.strike}${req.optType}`;
    const body: Record<string, unknown> = {
      dhanClientId: this.clientId,
      transactionType: req.side === "buy" ? "BUY" : "SELL",
      exchangeSegment: meta.exchange === "BFO" ? "BSE_FNO" : "NSE_FNO",
      productType: config.broker.product === "MIS" ? "INTRA" : "MARGIN",
      orderType: req.orderType === "SL-M" ? "STOP_LOSS_MARKET" : req.orderType === "SL" ? "STOP_LOSS" : req.orderType,
      validity: "DAY",
      securityId: this.securityId(tradingsymbol),
      quantity: req.qty,
      price: req.price ?? 0,
      triggerPrice: req.triggerPrice ?? 0,
      disclosedQuantity: 0,
      afterMarketOrder: false,
    };
    const res = await brokerCall<{ orderId?: string; orderStatus?: string; errorMessage?: string }>(`${BASE}/v2/orders`, {
      method: "POST",
      headers: this.headers,
      body,
      broker: this.name,
    });
    if (!res.orderId) throw new BrokerError(`Dhan order reject: ${res.errorMessage ?? JSON.stringify(res)}`, this.name);
    return {
      id: res.orderId,
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
    await brokerCall(`${BASE}/v2/orders/${id}`, { method: "DELETE", headers: this.headers, broker: this.name });
  }

  async orderStatus(id: string): Promise<OrderResult | undefined> {
    const res = await brokerCall<{ orderId?: string; orderStatus?: string; filledQty?: number; averageTradedPrice?: number; quantity?: number; transactionType?: string; tradedSymbol?: string }>(
      `${BASE}/v2/orders/${id}`,
      { headers: this.headers, broker: this.name },
    );
    if (!res?.orderId) return undefined;
    return {
      id,
      symbol: String(res.tradedSymbol ?? ""),
      side: String(res.transactionType ?? "BUY").toUpperCase() === "BUY" ? ("buy" as const) : ("sell" as const),
      qty: Number(res.quantity ?? 0),
      filledQty: Number(res.filledQty ?? 0),
      avgPrice: round2(Number(res.averageTradedPrice ?? 0)),
      status: mapDhanStatus(String(res.orderStatus ?? "")),
      orderType: "MARKET" as const,
      ts: Date.now(),
    };
  }

  async orders(): Promise<OrderResult[]> {
    const res = await brokerCall<Array<Record<string, unknown>>>(`${BASE}/v2/orders`, { headers: this.headers, broker: this.name });
    return (Array.isArray(res) ? res : []).map((o) => ({
      id: String(o["orderId"] ?? ""),
      symbol: String(o["tradingSymbol"] ?? ""),
      side: String(o["transactionType"] ?? "BUY").toUpperCase() === "BUY" ? ("buy" as const) : ("sell" as const),
      qty: Number(o["quantity"] ?? 0),
      filledQty: Number(o["filledQty"] ?? 0),
      avgPrice: round2(Number(o["averageTradedPrice"] ?? 0)),
      status: mapDhanStatus(String(o["orderStatus"] ?? "")),
      orderType: "MARKET" as const,
      ts: Date.now(),
    }));
  }

  async positions(): Promise<BrokerPosition[]> {
    const res = await brokerCall<Array<Record<string, unknown>>>(`${BASE}/v2/positions`, { headers: this.headers, broker: this.name });
    return (Array.isArray(res) ? res : [])
      .filter((p) => Number(p["netQty"] ?? 0) !== 0)
      .map((p) => ({
        symbol: String(p["tradingSymbol"] ?? ""),
        qty: Number(p["netQty"] ?? 0),
        avgPrice: round2(Number(p["buyAvg"] ?? p["costPrice"] ?? 0)),
        ltp: round2(Number(p["ltp"] ?? 0)),
        pnl: round2(Number(p["realizedProfit"] ?? 0) + Number(p["unrealizedProfit"] ?? 0)),
      }));
  }

  async margins(): Promise<MarginInfo> {
    const res = await brokerCall<{ availabelBalance?: number; sodLimit?: number; blockedPayoutAmount?: number }>(`${BASE}/v2/fundlimit`, {
      headers: this.headers,
      broker: this.name,
    });
    const avail = res.availabelBalance ?? res.sodLimit ?? 0; // Dhan ka API typo "availabelBalance"
    return { cash: round2(avail), used: round2(res.blockedPayoutAmount ?? 0), available: round2(avail) };
  }
}

function mapDhanStatus(s: string): OrderStatus {
  const u = s.toLowerCase();
  if (u.includes("traded") || u.includes("complete")) return "COMPLETE";
  if (u.includes("reject") || u.includes("cancelled by")) return "REJECTED";
  if (u.includes("cancel")) return "CANCELLED";
  if (u.includes("pending") || u.includes("open") || u.includes("trigger")) return "OPEN";
  return "PENDING";
}
