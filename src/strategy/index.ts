/**
 * index.ts — Strategy runner.
 *
 *   python service chalu hai  → usse signal (asli strategist Python me likhta hai)
 *   nahi chalu / fail hui     → TS local strategy (same logic ka port)
 *
 * Isse ek hi jagah strategy likho (py/algo/strategies/) aur live + backtest
 * dono me wahi chale. Service down hone pe engine rukta nahi — fallback chalta hai.
 */

import { config } from "../config.ts";
import { fetchJson } from "../util.ts";
import { createLocalStrategy } from "./local.ts";
import type { MarketState, Signal, Strategy } from "./types.ts";
import { hold } from "./types.ts";

export class StrategyRunner {
  private local: Strategy;
  private serviceUp: boolean | null = null;
  private lastServiceCheck = 0;
  private lastFallbackLog = 0;
  readonly activeName: string;
  readonly mode: string;

  constructor(name = config.strategy.name) {
    this.activeName = name;
    this.local = createLocalStrategy(name);
    this.mode = config.strategy.mode;
  }

  get timeframes(): string[] {
    return this.local.timeframes;
  }

  warmup(): number {
    return this.local.warmup();
  }

  resetDay(): void {
    this.local.resetDay();
  }

  /** Signal lo — Python pehle, warna local. */
  async signal(state: MarketState): Promise<{ signal: Signal; source: "python" | "local" }> {
    if (config.strategy.mode === "local") {
      return { signal: this.local.onState(state), source: "local" };
    }

    // service health har 30s ek baar check (baaar baar fail na ho)
    if (this.serviceUp === null || Date.now() - this.lastServiceCheck > 30_000) {
      this.serviceUp = await this.ping();
      this.lastServiceCheck = Date.now();
    }

    if (this.serviceUp) {
      try {
        const url = `${config.strategy.url}/signal?strategy=${encodeURIComponent(this.activeName)}`;
        const res = await fetchJson<{ signal?: Signal }>(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(state),
        }, 4000);
        if (res?.signal?.action) {
          return { signal: { ...hold(""), ...res.signal, meta: res.signal.meta ?? {} }, source: "python" };
        }
      } catch (e) {
        this.serviceUp = false;
        this.lastServiceCheck = Date.now();
        if (Date.now() - this.lastFallbackLog > 30_000) {
          this.lastFallbackLog = Date.now();
          console.warn(`[strategy] python service fail (${(e as Error).message}) — TS local fallback chal raha hai`);
        }
      }
    }
    return { signal: this.local.onState(state), source: "local" };
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetchJson<{ ok?: boolean }>(`${config.strategy.url}/health`, {}, 1500);
      return Boolean(res?.ok);
    } catch {
      return false;
    }
  }

  /** Service pe kaunsi strategies available hain (dashboard ke liye). */
  async listServiceStrategies(): Promise<string[]> {
    try {
      const res = await fetchJson<{ strategies?: string[] }>(`${config.strategy.url}/strategies`, {}, 1500);
      return res.strategies ?? [];
    } catch {
      return [];
    }
  }
}
