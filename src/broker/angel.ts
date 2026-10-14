/**
 * angel.ts — Angel One SmartAPI adapter.
 *
 * Angel me orders "symboltoken" se jaate hain (tradingsymbol bhi chahiye). Token
 * scrip master se milta hai — hum use ek baar download karke data/masters/ me
 * cache karte hain (30 MB+, isliye har startup pe nahi).
 *
 *   master URL: https://margincalculator.angelone.in/Download/master.json
 *
 * Login: POST /rest/auth/angelbroking/user/v1/loginByPassword
 *   { clientcode, password (PIN), totp }  → jwtToken + refreshToken
 * TOTP chahiye — agar totpSecret diya hai to hum khud TOTP generate karte hain
 * (RFC 6238, SHA-1, 30s step) — dekho totp().
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHmac } from "node:crypto";
import { config } from "../config.ts";
import { round2 } from "../util.ts";
import { indexMeta } from "../market/instruments.ts";
import type { Quote, OptionRef } from "../market/feed.ts";
import { brokerCall } from "./http.ts";
import type { Broker, BrokerPosition, MarginInfo, OrderRequest, OrderResult, OrderStatus } from "./types.ts";
import { BrokerError } from "./types.ts";

const BASE = "https://apiconnect.angelone.in";
const MASTER_URL = "https://margincalculator.angelone.in/Download/master.json";

/** Base32 TOTP (RFC 6238) — Angel ke 2FA ke liye. */
export function totp(secret: string, at: number = Date.now()): string {
  const b32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = secret.replace(/[\s=]/g, "").toUpperCase();
  let bits = "";
  for (const c of clean) {
    const idx = b32.indexOf(c);
    if (idx < 0) continue;
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const counter = Math.floor(at / 30_000);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", Buffer.from(bytes)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) | ((hmac[offset + 1]! & 0xff) << 16) | ((hmac[offset + 2]! & 0xff) << 8) | (hmac[offset + 3]! & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

interface AngelMasterRow {
  token: string;
  symbol: string;
  name: string;
  exch_seg: string;
  instrumenttype?: string;
}

export class AngelBroker implements Broker {
  readonly name = "angel";
  readonly simulated = false;
  private headers: Record<string, string> = {};
  private creds: Record<string, string>;
  private tokenBySymbol = new Map<string, string>();
  private masterLoaded = false;

  constructor(creds = config.credentials["angel"] as Record<string, string>) {
    this.creds = creds;
    if (!creds.apiKey) throw new BrokerError("ANGEL_API_KEY missing (.env)", "angel");
  }

  private baseHeaders(jwt?: string): Record<string, string> {
    return {
      "X-UserType": "USER",
      "X-SourceID": "WEB",
      "X-ClientLocalIP": "127.0.0.1",
      "X-ClientPublicIP": "127.0.0.1",
      "X-MACAddress": "00:00:00:00:00:00",
      "X-PrivateKey": this.creds["apiKey"] ?? "",
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    };
  }

  async init(): Promise<void> {
    let jwt = this.creds["jwtToken"] ?? "";
    if (!jwt) {
      const { clientId, pin, totpSecret } = this.creds;
      if (!clientId || !pin || !totpSecret) {
        throw new BrokerError(
          "Angel login ke liye ANGEL_CLIENT_ID + ANGEL_PIN + ANGEL_TOTP_SECRET (ya direct ANGEL_JWT_TOKEN) chahiye",
          "angel",
        );
      }
      const res = await brokerCall<{ data?: { jwtToken?: string }; status?: boolean; message?: string }>(
        `${BASE}/rest/auth/angelbroking/user/v1/loginByPassword`,
        { method: "POST", headers: this.baseHeaders(), body: { clientcode: clientId, password: pin, totp: totp(totpSecret) }, broker: this.name },
      );
      jwt = res.data?.jwtToken ?? "";
      if (!jwt) throw new BrokerError(`Angel login fail: ${res.message ?? "no jwtToken"}`, this.name);
    }
    this.headers = this.baseHeaders(jwt);
    await this.loadMaster();
  }

  /** Scrip master load (cached). */
  async loadMaster(): Promise<void> {
    if (this.masterLoaded) return;
    const dir = resolve(process.cwd(), config.dataDir, "masters");
    const file = resolve(dir, "angel-master.json");
    let text: string;
    if (existsSync(file)) {
      text = readFileSync(file, "utf8");
    } else {
      console.log("[angel] scrip master download ho raha hai (30 MB+, ek hi baar)...");
      const res = await fetch(MASTER_URL);
      if (!res.ok) throw new BrokerError(`Angel master download fail: HTTP ${res.status}`, this.name);
      text = await res.text();
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, text);
    }
    const rows = JSON.parse(text) as AngelMasterRow[];
    for (const r of rows) {
      if (!r.exch_seg || !/^(NFO|BFO)$/.test(r.exch_seg)) continue;
      this.tokenBySymbol.set(r.symbol, r.token);
    }
    this.masterLoaded = true;
  }

  private tokenFor(symbol: string): string {
    const t = this.tokenBySymbol.get(symbol);
    if (!t) throw new BrokerError(`Angel: "${symbol}" ka token master me nahi mila (naya contract? master refresh karo)`, this.name);
    return t;
  }

  quoteSymbolFor(index: string): string {
    return `NSE:${indexMeta(index).spotSymbol["angel"]!}`; // "NSE:99926000"
  }

  optionSymbolFor(ref: OptionRef): string {
    const meta = indexMeta(ref.index);
    const prefix = meta.exchange === "BFO" ? "BSE" : "NSE";
    return `${prefix}:${meta.symbolPrefix}${ref.expiryCode}${ref.strike}${ref.optType}`;
  }

  async quotes(symbols: string[]): Promise<Quote[]> {
    const byExchange: Record<string, string[]> = {};
    for (const s of symbols) {
      const [exch, token] = s.split(":");
      if (!exch || !token) continue;
      (byExchange[exch] ??= []).push(token);
    }
    const res = await brokerCall<{ data?: { fetched?: Array<Record<string, unknown>> } }>(
      `${BASE}/rest/secure/angelbroking/market/v1/quote`,
      { method: "POST", headers: this.headers, body: { mode: "FULL", exchangeTokens: byExchange }, broker: this.name },
    );
    const out: Quote[] = [];
    for (const q of res.data?.fetched ?? []) {
      const token = String(q["symbolToken"] ?? "");
      const exch = String(q["exchange"] ?? "NFO");
      out.push({
        symbol: `${exch}:${token}`,
        ts: Date.now(),
        ltp: Number(q["ltp"] ?? 0),
        bid: Number((q["depth"] as { buy?: Array<{ price: number }> } | undefined)?.buy?.[0]?.price ?? q["ltp"] ?? 0),
        ask: Number((q["depth"] as { sell?: Array<{ price: number }> } | undefined)?.sell?.[0]?.price ?? q["ltp"] ?? 0),
        volume: Number(q["tradeVolume"] ?? 0),
      });
    }
    return out;
  }

  async ltp(symbol: string): Promise<number> {
    const q = await this.quotes([symbol]);
    if (!q.length) throw new BrokerError(`angel: "${symbol}" quote nahi mila`, this.name);
    return q[0]!.ltp;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const meta = indexMeta(req.index);
    const tradingsymbol = `${meta.symbolPrefix}${req.expiryCode}${req.strike}${req.optType}`;
    const symboltoken = this.tokenFor(tradingsymbol);
    const body = {
      variety: "NORMAL",
      tradingsymbol,
      symboltoken,
      transactiontype: req.side.toUpperCase(),
      exchange: meta.exchange,
      ordertype: req.orderType === "SL-M" ? "STOPLOSS_MARKET" : req.orderType,
      producttype: config.broker.product === "MIS" ? "INTRADAY" : "CARRYFORWARD",
      duration: "DAY",
      price: String(req.price ?? 0),
      squareoff: "0",
      stoploss: "0",
      quantity: String(req.qty),
      ...(req.triggerPrice !== undefined ? { triggerprice: String(req.triggerPrice) } : {}),
    };
    const res = await brokerCall<{ data?: { orderid?: string }; message?: string; status?: boolean }>(
      `${BASE}/rest/secure/angelbroking/order/v1/placeOrder`,
      { method: "POST", headers: this.headers, body, broker: this.name },
    );
    if (!res.data?.orderid) throw new BrokerError(`Angel order reject: ${res.message ?? JSON.stringify(res)}`, this.name);
    return {
      id: res.data.orderid,
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
    await brokerCall(`${BASE}/rest/secure/angelbroking/order/v1/cancelOrder`, {
      method: "POST",
      headers: this.headers,
      body: { variety: "NORMAL", orderid: id },
      broker: this.name,
    });
  }

  async orderStatus(id: string): Promise<OrderResult | undefined> {
    const all = await this.orders();
    return all.find((o) => o.id === id);
  }

  async orders(): Promise<OrderResult[]> {
    const res = await brokerCall<{ data?: Array<Record<string, unknown>> }>(`${BASE}/rest/secure/angelbroking/order/v1/getOrderBook`, {
      headers: this.headers,
      broker: this.name,
    });
    return (res.data ?? []).map((o) => ({
      id: String(o["orderid"] ?? ""),
      symbol: String(o["tradingsymbol"] ?? ""),
      side: String(o["transactiontype"] ?? "BUY").toUpperCase() === "BUY" ? ("buy" as const) : ("sell" as const),
      qty: Number(o["quantity"] ?? 0),
      filledQty: Number(o["filledshares"] ?? 0),
      avgPrice: round2(Number(o["averageprice"] ?? 0)),
      status: mapAngelStatus(String(o["status"] ?? "")),
      orderType: "MARKET" as const,
      ts: Date.now(),
    }));
  }

  async positions(): Promise<BrokerPosition[]> {
    const res = await brokerCall<{ data?: Array<Record<string, unknown>> }>(`${BASE}/rest/secure/angelbroking/order/v1/getPosition`, {
      headers: this.headers,
      broker: this.name,
    });
    return (res.data ?? [])
      .filter((p) => Number(p["netqty"] ?? 0) !== 0)
      .map((p) => ({
        symbol: String(p["tradingsymbol"] ?? ""),
        qty: Number(p["netqty"] ?? 0),
        avgPrice: round2(Number(p["avgnetprice"] ?? 0)),
        ltp: round2(Number(p["ltp"] ?? 0)),
        pnl: round2(Number(p["pnl"] ?? 0)),
      }));
  }

  async margins(): Promise<MarginInfo> {
    const res = await brokerCall<{ data?: { availablecash?: string; utiliseddebits?: string } }>(
      `${BASE}/rest/secure/angelbroking/user/v1/getRMS`,
      { headers: this.headers, broker: this.name },
    );
    const avail = Number(res.data?.availablecash ?? 0);
    const used = Number(res.data?.utiliseddebits ?? 0);
    return { cash: round2(avail + used), used: round2(used), available: round2(avail) };
  }
}

function mapAngelStatus(s: string): OrderStatus {
  const u = s.toLowerCase();
  if (u.includes("complete")) return "COMPLETE";
  if (u.includes("reject")) return "REJECTED";
  if (u.includes("cancel")) return "CANCELLED";
  if (u.includes("open") || u.includes("trigger")) return "OPEN";
  return "PENDING";
}
