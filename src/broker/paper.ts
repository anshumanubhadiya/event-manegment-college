/**
 * paper.ts — Paper broker: asli broker ki tarah behave karta hai par paisa nahi lagta.
 *
 * Kya simulate hota hai:
 *   * fills — bid/ask + slippage (market order = thoda kharaab price)
 *   * charges — poori Indian charge structure (STT, exchange, GST, stamp, SEBI)
 *   * SL-M orders — engine jab price bhejta hai tab trigger hote hain
 *   * margins — capital se qty * price block, exit pe wapas
 *   * P&L — realized + unrealized
 *
 * Isliye paper mode me strategy ko exactly wahi feedback milta hai jo live me milega.
 */

import { config } from "../config.ts";
import { orderCharges } from "../charges.ts";
import { round2 } from "../util.ts";
import type { Quote, OptionRef } from "../market/feed.ts";
import type {
  Broker,
  BrokerPosition,
  MarginInfo,
  OrderRequest,
  OrderResult,
  OrderStatus,
} from "./types.ts";
import { BrokerError } from "./types.ts";

interface PaperOrder extends OrderResult {
  triggerPrice?: number;
  price?: number;
}

export class PaperBroker implements Broker {
  readonly name = "paper";
  readonly simulated = true;
  private priceMap = new Map<string, Quote>();
  private ordersMap = new Map<string, PaperOrder>();
  private posMap = new Map<string, { qty: number; avgPrice: number; symbol: string }>();
  private seq = 0;
  private realized = 0;
  private totalCharges = 0;
  private startCash: number;

  constructor(private cash = config.risk.capital) {
    this.startCash = cash;
  }

  async init(): Promise<void> {
    return;
  }

  quoteSymbolFor(index: string): string {
    return `${index}-SPOT`;
  }

  optionSymbolFor(ref: OptionRef): string {
    return ref.symbol || `${ref.index}${ref.expiryCode}${ref.strike}${ref.optType}`;
  }

  /** Engine har tick pe price set karta hai (paper fills ke liye). */
  setPrice(symbol: string, q: Partial<Quote> & { ltp: number }): void {
    // sirf ltp diya gaya ho to bid/ask ltp ke around derive karo (purana bid/ask
    // carry mat karo — warna fill purane price pe ho jaata hai)
    const spread = Math.max(q.ltp * 0.004, 0.05);
    const merged: Quote = {
      symbol,
      ts: q.ts ?? Date.now(),
      ltp: q.ltp,
      bid: q.bid ?? q.ltp - spread / 2,
      ask: q.ask ?? q.ltp + spread / 2,
      volume: q.volume,
    };
    this.priceMap.set(symbol, merged);
  }

  /** Alias (feed se aane wale quotes ke liye). */
  tick(q: Quote): void {
    this.setPrice(q.symbol, q);
    this.checkPendingSls(q.symbol, q.ltp);
  }

  async quotes(symbols: string[]): Promise<Quote[]> {
    const out: Quote[] = [];
    for (const s of symbols) {
      const q = this.priceMap.get(s);
      if (q) out.push(q);
    }
    return out;
  }

  async ltp(symbol: string): Promise<number> {
    const q = this.priceMap.get(symbol);
    if (!q) throw new BrokerError(`paper: "${symbol}" ka price nahi mila (feed se set karo)`, this.name, true);
    return q.ltp;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const id = `PAPER-${Date.now().toString(36)}-${++this.seq}`;
    const q = this.priceMap.get(req.symbol);
    const now = Date.now();

    if (!q) {
      // price nahi hai to order pending rakho (engine agli tick pe retry karega)
      const pending: PaperOrder = {
        id,
        symbol: req.symbol,
        side: req.side,
        qty: req.qty,
        filledQty: 0,
        avgPrice: 0,
        status: "PENDING",
        orderType: req.orderType,
        price: req.price,
        triggerPrice: req.triggerPrice,
        ts: now,
        message: "price pending",
      };
      this.ordersMap.set(id, pending);
      return pending;
    }

    if (req.orderType === "SL-M" || req.orderType === "SL") {
      // pending SL — price trigger hone pe fill (engine ticks deta rahega)
      const order: PaperOrder = {
        id,
        symbol: req.symbol,
        side: req.side,
        qty: req.qty,
        filledQty: 0,
        avgPrice: 0,
        status: "OPEN",
        orderType: req.orderType,
        price: req.price,
        triggerPrice: req.triggerPrice,
        ts: now,
      };
      this.ordersMap.set(id, order);
      this.checkPendingSls(req.symbol, q.ltp);
      return this.ordersMap.get(id)!;
    }

    if (req.orderType === "LIMIT" && req.price !== undefined) {
      const crosses = req.side === "buy" ? req.price >= q.ask : req.price <= q.bid;
      if (!crosses) {
        const order: PaperOrder = {
          id,
          symbol: req.symbol,
          side: req.side,
          qty: req.qty,
          filledQty: 0,
          avgPrice: 0,
          status: "OPEN",
          orderType: "LIMIT",
          price: req.price,
          ts: now,
        };
        this.ordersMap.set(id, order);
        return order;
      }
    }

    return this.fill(id, req.symbol, req.side, req.qty, req.orderType, req.price, now, req.product);
  }

  /** Market/limit order fill karo (slippage + charges). */
  private fill(
    id: string,
    symbol: string,
    side: "buy" | "sell",
    qty: number,
    orderType: OrderRequest["orderType"],
    limitPrice: number | undefined,
    ts: number,
    product?: string,
  ): OrderResult {
    const q = this.priceMap.get(symbol);
    if (!q) throw new BrokerError(`paper fill: "${symbol}" ka price nahi hai`, this.name, true);

    const slipPct = config.broker.slippagePct / 100;
    const raw = side === "buy" ? q.ask : q.bid;
    const slipped = side === "buy" ? raw * (1 + slipPct) : raw * (1 - slipPct);
    let price = limitPrice !== undefined && orderType === "LIMIT"
      ? side === "buy"
        ? Math.min(slipped, limitPrice)
        : Math.max(slipped, limitPrice)
      : slipped;
    price = round2(Math.max(price, 0.05));

    // cash check (long options ke liye premium block hota hai)
    const cost = price * qty;
    const charges = orderCharges({ broker: this.name, segment: "options", side, qty, price }).total;
    if (side === "buy" && cost + charges > this.cash) {
      const rejected: PaperOrder = {
        id,
        symbol,
        side,
        qty,
        filledQty: 0,
        avgPrice: 0,
        status: "REJECTED",
        orderType,
        ts,
        message: `paper: cash kam hai (chahiye ₹${Math.round(cost + charges)}, hai ₹${Math.round(this.cash)})`,
      };
      this.ordersMap.set(id, rejected);
      return rejected;
    }

    // position update
    const pos = this.posMap.get(symbol) ?? { qty: 0, avgPrice: 0, symbol };
    const signed = side === "buy" ? qty : -qty;
    let realized = 0;
    if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(signed)) {
      const newQty = pos.qty + signed;
      pos.avgPrice = (pos.avgPrice * Math.abs(pos.qty) + price * qty) / Math.abs(newQty);
      pos.qty = newQty;
    } else {
      // closing (ya reverse)
      const closingQty = Math.min(Math.abs(signed), Math.abs(pos.qty));
      realized = (price - pos.avgPrice) * closingQty * Math.sign(pos.qty);
      this.realized += realized - charges;
      pos.qty += signed;
      if (pos.qty === 0) pos.avgPrice = 0;
      else if (Math.sign(pos.qty) !== Math.sign(pos.qty - signed)) pos.avgPrice = price;
    }
    this.cash -= signed * price;
    this.cash -= charges;
    this.totalCharges += charges;
    if (pos.qty === 0) this.posMap.delete(symbol);
    else this.posMap.set(symbol, pos);

    const done: PaperOrder = {
      id,
      symbol,
      side,
      qty,
      filledQty: qty,
      avgPrice: price,
      status: "COMPLETE",
      orderType,
      ts,
      charges: round2(charges),
      message: product ? `product ${product}` : undefined,
    };
    this.ordersMap.set(id, done);
    return done;
  }

  /** Pending SL/limit orders check karo jab price aata hai. */
  private checkPendingSls(symbol: string, ltp: number): void {
    for (const o of this.ordersMap.values()) {
      if (o.symbol !== symbol) continue;
      if (o.status !== "OPEN" && o.status !== "PENDING") continue;
      if (o.orderType === "SL-M" || o.orderType === "SL") {
        const trig = o.triggerPrice ?? 0;
        const hit = o.side === "sell" ? ltp <= trig : ltp >= trig;
        if (hit && o.filledQty === 0) {
          try {
            this.fill(o.id, o.symbol, o.side, o.qty, o.orderType, undefined, Date.now(), "MIS");
          } catch {
            /* price nahi mila — agli tick pe */
          }
        }
      } else if (o.orderType === "LIMIT" && o.price !== undefined) {
        const q = this.priceMap.get(symbol)!;
        const crosses = o.side === "buy" ? q.ask <= o.price : q.bid >= o.price;
        if (crosses && o.filledQty === 0) {
          this.fill(o.id, o.symbol, o.side, o.qty, "LIMIT", o.price, Date.now(), "MIS");
        }
      }
    }
  }

  async cancelOrder(id: string): Promise<void> {
    const o = this.ordersMap.get(id);
    if (o && (o.status === "OPEN" || o.status === "PENDING")) {
      o.status = "CANCELLED";
      const status: OrderStatus = "CANCELLED";
      o.status = status;
    }
  }

  async orderStatus(id: string): Promise<OrderResult | undefined> {
    return this.ordersMap.get(id);
  }

  async orders(): Promise<OrderResult[]> {
    return [...this.ordersMap.values()];
  }

  async positions(): Promise<BrokerPosition[]> {
    const out: BrokerPosition[] = [];
    for (const [symbol, p] of this.posMap) {
      const q = this.priceMap.get(symbol);
      const ltp = q?.ltp ?? p.avgPrice;
      out.push({
        symbol,
        qty: p.qty,
        avgPrice: round2(p.avgPrice),
        ltp: round2(ltp),
        pnl: round2((ltp - p.avgPrice) * p.qty),
      });
    }
    return out;
  }

  async margins(): Promise<MarginInfo> {
    let used = 0;
    for (const [symbol, p] of this.posMap) {
      const q = this.priceMap.get(symbol);
      used += (q?.ltp ?? p.avgPrice) * Math.abs(p.qty);
    }
    return {
      cash: round2(this.cash),
      used: round2(used),
      available: round2(this.cash),
    };
  }

  async squareOffAll(): Promise<void> {
    for (const [symbol, p] of [...this.posMap]) {
      if (p.qty === 0) continue;
      const side = p.qty > 0 ? "sell" : "buy";
      try {
        this.fill(`PAPER-SQ-${Date.now().toString(36)}`, symbol, side, Math.abs(p.qty), "MARKET", undefined, Date.now(), "MIS");
      } catch (e) {
        console.warn(`[paper] square-off fail ${symbol}: ${(e as Error).message}`);
      }
    }
  }

  stats(): { realized: number; charges: number; cash: number; startCash: number; orders: number } {
    return {
      realized: round2(this.realized),
      charges: round2(this.totalCharges),
      cash: round2(this.cash),
      startCash: this.startCash,
      orders: this.ordersMap.size,
    };
  }

  /** Testing ke liye: open orders ki list. */
  openOrders(): OrderResult[] {
    return [...this.ordersMap.values()].filter((o) => o.status === "OPEN" || o.status === "PENDING");
  }
}
