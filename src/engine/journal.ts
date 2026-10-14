/**
 * journal.ts — har cheez ka record. Live trading me journal hi sach hai.
 *
 *   data/events.jsonl      — sab kuch (tick/signal/ai/order/trade/error) append-only
 *   data/trades.csv        — closed trades (Excel me kholo)
 *   data/daily.csv         — roz ka summary
 *   data/session-<day>.json — din ka poora snapshot (end pe)
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.ts";
import { csvEscape, istParts, round2 } from "../util.ts";

export interface TradeRecord {
  id: string;
  symbol: string;
  optType: "CE" | "PE";
  strike: number;
  lots: number;
  qty: number;
  entryTs: number;
  exitTs: number;
  entryPremium: number;
  exitPremium: number;
  entryIndex: number;
  exitIndex: number;
  indexStop: number;
  indexTarget: number;
  gross: number;
  charges: number;
  net: number;
  reason: string;
  tag: string;
  confidence: number;
  aiChoice?: string;
  holdMinutes: number;
}

export class Journal {
  private dir: string;
  private eventsPath: string;
  private tradesPath: string;
  private dailyPath: string;
  readonly trades: TradeRecord[] = [];

  constructor(dir = config.dataDir) {
    this.dir = resolve(process.cwd(), dir);
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.eventsPath = resolve(this.dir, "events.jsonl");
    this.tradesPath = resolve(this.dir, "trades.csv");
    this.dailyPath = resolve(this.dir, "daily.csv");
    if (!existsSync(this.tradesPath)) {
      writeFileSync(this.tradesPath, TradeRecordHeaders + "\n");
    }
    if (!existsSync(this.dailyPath)) {
      writeFileSync(this.dailyPath, "date,trades,gross,charges,net,equityEnd,winRate,maxDD\n");
    }
  }

  event(type: string, payload: Record<string, unknown>): void {
    const rec = { ts: Date.now(), ist: istParts(Date.now()).dateKey, type, ...payload };
    try {
      appendFileSync(this.eventsPath, JSON.stringify(rec) + "\n");
    } catch (e) {
      console.warn(`[journal] event write fail: ${(e as Error).message}`);
    }
  }

  recordTrade(t: TradeRecord): void {
    this.trades.push(t);
    const row = [
      t.id,
      istParts(t.entryTs).dateKey,
      new Date(t.entryTs).toISOString(),
      t.symbol,
      t.optType,
      t.strike,
      t.lots,
      t.qty,
      round2(t.entryPremium),
      round2(t.exitPremium),
      round2(t.entryIndex),
      round2(t.exitIndex),
      round2(t.indexStop),
      round2(t.indexTarget),
      round2(t.gross),
      round2(t.charges),
      round2(t.net),
      t.holdMinutes,
      t.tag,
      t.confidence,
      t.aiChoice ?? "",
      t.reason,
    ]
      .map(csvEscape)
      .join(",");
    try {
      appendFileSync(this.tradesPath, row + "\n");
    } catch (e) {
      console.warn(`[journal] trade write fail: ${(e as Error).message}`);
    }
    this.event("trade", { ...t, net: round2(t.net) });
  }

  writeDailySummary(summary: Record<string, unknown>): void {
    const row = [
      summary["date"],
      summary["trades"],
      round2(Number(summary["gross"] ?? 0)),
      round2(Number(summary["charges"] ?? 0)),
      round2(Number(summary["net"] ?? 0)),
      round2(Number(summary["equityEnd"] ?? 0)),
      summary["winRate"],
      round2(Number(summary["maxDD"] ?? 0)),
    ]
      .map(csvEscape)
      .join(",");
    try {
      appendFileSync(this.dailyPath, row + "\n");
    } catch {
      /* ignore */
    }
    this.event("daySummary", summary);
  }

  sessionSnapshot(day: string, snapshot: Record<string, unknown>): void {
    const path = resolve(this.dir, `session-${day}.json`);
    try {
      writeFileSync(path, JSON.stringify(snapshot, null, 2));
    } catch (e) {
      console.warn(`[journal] session snapshot fail: ${(e as Error).message}`);
    }
  }

  get paths(): { dir: string; events: string; trades: string; daily: string } {
    return { dir: this.dir, events: this.eventsPath, trades: this.tradesPath, daily: this.dailyPath };
  }
}

const TradeRecordHeaders =
  "id,date,entryIso,symbol,optType,strike,lots,qty,entryPremium,exitPremium,entryIndex,exitIndex,indexStop,indexTarget,gross,charges,net,holdMinutes,tag,confidence,aiChoice,reason";
