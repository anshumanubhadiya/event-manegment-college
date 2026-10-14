/**
 * util.ts — chhote helpers: IST time, formatting, random, HTTP.
 */

// ---------------------------------------------------------------- IST time
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const IST_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
  hour12: false,
});

export interface IstParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0=Sunday
  dateKey: string; // "2026-02-11"
  minuteOfDay: number; // 9:15 → 555
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function istParts(ts: number): IstParts {
  const p: Record<string, string> = {};
  for (const part of IST_PARTS.formatToParts(new Date(ts))) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  const hour = Number(p.hour) % 24;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour,
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WD.indexOf(p.weekday ?? "Sun"),
    dateKey: `${p.year}-${p.month}-${p.day}`,
    minuteOfDay: hour * 60 + Number(p.minute),
  };
}

/** IST wall-clock (h:m) → epoch ms. Aaj ki date default. */
export function istEpoch(hour: number, minute: number, base: number = Date.now()): number {
  const p = istParts(base);
  const utcMidnightOfIstDay = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0) - IST_OFFSET_MS;
  return utcMidnightOfIstDay + (hour * 60 + minute) * 60_000;
}

/** "HH:MM" parse → [hour, minute]. */
export function parseHhmm(s: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`HH:MM expected, mila "${s}"`);
  return [Number(m[1]), Number(m[2])];
}

export function hhmmToMinutes(s: string): number {
  const [h, m] = parseHhmm(s);
  return h * 60 + m;
}

export function istTimeString(ts: number, withSeconds = true): string {
  const p = istParts(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(p.hour)}:${pad(p.minute)}${withSeconds ? ":" + pad(p.second) : ""}`;
}

export function istDateTimeString(ts: number): string {
  const p = istParts(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.dateKey} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

// ---------------------------------------------------------------- numbers
export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function round(x: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/** ₹ format — Indian grouping (1,23,456). */
export function inr(x: number, dp = 0): string {
  const neg = x < 0;
  const s = Math.abs(x).toFixed(dp);
  const [intPart = "0", dec] = s.split(".");
  const last3 = intPart.slice(-3);
  const rest = intPart.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3 : last3;
  return `${neg ? "-" : ""}₹${grouped}${dec ? "." + dec : ""}`;
}

export function pct(a: number, b: number): number {
  return b === 0 ? 0 : ((a - b) / b) * 100;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

// ---------------------------------------------------------------- random
/** Deterministic PRNG (same seed = same demo session). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(rnd: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------- misc
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function isFinitePositive(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}

/** fetch + JSON, timeout ke saath (hang na ho). */
export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  } finally {
    clearTimeout(timer);
  }
}

export function safeJsonParse<T>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}
