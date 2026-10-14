/**
 * calendar.ts — NSE/BSE session timing, holidays, market status.
 *
 * Session: 09:15 - 15:30 IST (index F&O). Pre-open 09:00-09:08 equity ke liye hota
 * hai, F&O me relevant nahi. MIS square-off 15:15 pe karte hain (broker ke auto
 * square-off se pehle).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.ts";
import { hhmmToMinutes, istParts } from "../util.ts";

export const SESSION = {
  open: 9 * 60 + 15, // 09:15
  close: 15 * 60 + 30, // 15:30
  sessionMinutes: 375,
} as const;

// ---------------------------------------------------------------- holidays
interface HolidaysFile {
  note?: string;
  dates: string[]; // ["2026-01-26", ...]
}

let holidays: Set<string> | null = null;

export function loadHolidays(path = config.holidaysFile): Set<string> {
  if (holidays) return holidays;
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) {
    holidays = new Set();
    return holidays;
  }
  try {
    const raw = JSON.parse(readFileSync(full, "utf8")) as HolidaysFile;
    holidays = new Set(Array.isArray(raw.dates) ? raw.dates : []);
  } catch (e) {
    console.warn(`[calendar] holidays file padh nahi paya (${path}): ${(e as Error).message}`);
    holidays = new Set();
  }
  return holidays;
}

export function isHoliday(dateKey: string): boolean {
  return loadHolidays().has(dateKey);
}

export function isTradingDay(ts: number): boolean {
  const p = istParts(ts);
  if (p.weekday === 0 || p.weekday === 6) return false;
  return !isHoliday(p.dateKey);
}

// ---------------------------------------------------------------- status
export type SessionPhase = "pre" | "open" | "closing" | "post" | "closed";

export interface MarketStatus {
  open: boolean;
  phase: SessionPhase;
  tradingDay: boolean;
  weekend: boolean;
  holiday: boolean;
  minutesToClose: number;
  minuteOfDay: number;
  dateKey: string;
}

export function marketStatus(ts: number): MarketStatus {
  const p = istParts(ts);
  const weekend = p.weekday === 0 || p.weekday === 6;
  const holiday = isHoliday(p.dateKey);
  const tradingDay = !weekend && !holiday;
  const mod = p.minuteOfDay;
  const pre = mod < SESSION.open;
  const post = mod >= SESSION.close; // 15:30 se band (ya uske baad)
  const open = tradingDay && !pre && !post;

  let phase: SessionPhase = "closed";
  if (!tradingDay) phase = "closed";
  else if (pre) phase = "pre";
  else if (post) phase = "post";
  else if (mod >= SESSION.close - 20) phase = "closing";
  else phase = "open";

  return {
    open,
    phase,
    tradingDay,
    weekend,
    holiday,
    minutesToClose: Math.max(0, SESSION.close - mod),
    minuteOfDay: mod,
    dateKey: p.dateKey,
  };
}

/** Ek din ke bars kitne hain (1-min). */
export function sessionMinutes(): number {
  return SESSION.sessionMinutes;
}

/** Entry allowed? (window + cutoff) */
export function withinEntryWindow(ts: number): { ok: boolean; reason: string } {
  const p = istParts(ts);
  const mod = p.minuteOfDay;
  const start = hhmmToMinutes(config.risk.noTradeBefore);
  const cutoff = hhmmToMinutes(config.risk.entryCutoff);
  if (mod < start) return { ok: false, reason: `${config.risk.noTradeBefore} se pehle entry nahi (opening noise)` };
  if (mod > cutoff) return { ok: false, reason: `${config.risk.entryCutoff} ke baad naya entry nahi` };
  return { ok: true, reason: "ok" };
}

export function shouldSquareOff(ts: number): boolean {
  return istParts(ts).minuteOfDay >= hhmmToMinutes(config.risk.squareOff);
}

/** Expiry day? (weekly/monthly — instruments.ts se aata hai) */
export function isSameIstDay(a: number, b: number): boolean {
  return istParts(a).dateKey === istParts(b).dateKey;
}
