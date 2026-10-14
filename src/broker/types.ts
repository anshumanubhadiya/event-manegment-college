/**
 * types.ts — Broker interface. Har broker (paper + 5 real) isi ko implement karta hai,
 * isliye engine ko farak nahi padta ki paisa kahan jaa raha hai.
 *
 * Naya broker add karna hai? Ye interface implement karo aur broker/index.ts me
 * register kar do. Bas.
 */

import type { Quote, OptionRef } from "../market/feed.ts";

export type OrderSide = "buy" | "sell";
export type OrderType = "MARKET" | "LIMIT" | "SL-M" | "SL";
export type OrderStatus = "PENDING" | "OPEN" | "COMPLETE" | "REJECTED" | "CANCELLED";

export interface OrderRequest {
  index: string; // NIFTY / BANKNIFTY / SENSEX
  /** generic trading symbol (journal/log ke liye) */
  symbol: string;
  strike: number;
  optType: "CE" | "PE";
  expiryCode: string; // "26FEB" ya "260211"
  expiryWeekly: boolean;
  side: OrderSide;
  qty: number;
  orderType: OrderType;
  price?: number;
  triggerPrice?: number;
  product?: string;
  tag?: string;
}

export interface OrderResult {
  id: string;
  symbol: string;
  side: OrderSide;
  qty: number;
  filledQty: number;
  avgPrice: number;
  status: OrderStatus;
  orderType: OrderType;
  price?: number;
  triggerPrice?: number;
  ts: number;
  message?: string;
  charges?: number;
}

export interface BrokerPosition {
  symbol: string;
  qty: number; // + long, - short
  avgPrice: number;
  ltp: number;
  pnl: number;
}

export interface MarginInfo {
  cash: number;
  used: number;
  available: number;
}

export interface Broker {
  readonly name: string;
  /** Startup — login/token verify, master load etc. */
  init(): Promise<void>;
  /** Is index ka broker-specific spot symbol (quote ke liye). */
  quoteSymbolFor(index: string): string;
  /** Option leg ka broker symbol. */
  optionSymbolFor(ref: OptionRef): string;
  quotes(symbols: string[]): Promise<Quote[]>;
  ltp(symbol: string): Promise<number>;
  placeOrder(req: OrderRequest): Promise<OrderResult>;
  cancelOrder(id: string): Promise<void>;
  orderStatus(id: string): Promise<OrderResult | undefined>;
  orders(): Promise<OrderResult[]>;
  positions(): Promise<BrokerPosition[]>;
  margins(): Promise<MarginInfo>;
  /** Engine price update deta hai (paper broker pending SL trigger ke liye). */
  tick?(q: Quote): void;
  /** Din ke end pe sab band. */
  squareOffAll?(): Promise<void>;
  /** Paper broker true — engine charges khud lagata hai. */
  readonly simulated: boolean;
}

export class BrokerError extends Error {
  constructor(
    message: string,
    readonly broker: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}
