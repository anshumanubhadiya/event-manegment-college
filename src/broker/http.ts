/**
 * http.ts — broker REST calls ke liye chhota helper (retry + timeout + error mapping).
 */

import { fetchJson } from "../util.ts";
import { BrokerError } from "./types.ts";

export interface HttpOpts {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  /** form-urlencoded bhejna hai (Zerodha/Upstox style) */
  form?: boolean;
  timeoutMs?: number;
  retries?: number;
  broker: string;
}

export async function brokerCall<T>(url: string, opts: HttpOpts): Promise<T> {
  const retries = opts.retries ?? 2;
  let lastErr: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = { Accept: "application/json", ...(opts.headers ?? {}) };
      let body: string | undefined;
      if (opts.form && opts.body) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        body = new URLSearchParams(opts.body as Record<string, string>).toString();
      } else if (opts.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(opts.body);
      }
      return await fetchJson<T>(url, { method: opts.method ?? "GET", headers, body }, opts.timeoutMs ?? 8000);
    } catch (e) {
      lastErr = e as Error;
      const msg = lastErr.message;
      // auth/validation errors pe retry ka koi fayda nahi
      if (/HTTP 4\d\d/.test(msg) && !/HTTP 429/.test(msg)) break;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw new BrokerError(`${opts.broker} API fail: ${lastErr?.message ?? "unknown"}`, opts.broker, true);
}

/** "NSE:NIFTY26FEB24000CE" → "NFO:NIFTY26FEB24000CE" (index options NFO/BFO hoti hain). */
export function withExchange(exchange: string, symbol: string): string {
  const bare = symbol.includes(":") ? symbol.split(":")[1]! : symbol;
  return `${exchange}:${bare}`;
}
