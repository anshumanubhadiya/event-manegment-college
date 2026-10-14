/**
 * config.ts — .env se config. Har cheez ka sane default hai, isliye
 * bina .env bhi `npm run demo` chal jaata hai.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { hhmmToMinutes, parseHhmm } from "./util.ts";

export type Mode = "demo" | "paper" | "live";
export type AiMode = "off" | "veto" | "decide";
export type StrategyMode = "auto" | "local" | "python";
export type Moneyness = "ATM" | "ITM1" | "ITM2" | "OTM1" | "OTM2";

// ---------------------------------------------------------------- .env loader
function loadDotEnv(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

function env(name: string, def = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? def : v;
}

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} number hona chahiye, mila "${v}"`);
  return n;
}

function bool(name: string, def: boolean): boolean {
  const v = env(name, "").toLowerCase();
  if (!v) return def;
  return ["1", "true", "yes", "on", "haan"].includes(v);
}

function oneOf<T extends string>(name: string, def: T, allowed: readonly T[]): T {
  const v = env(name, def) as T;
  if (!allowed.includes(v)) {
    throw new Error(`${name} = "${v}" galat hai. Allowed: ${allowed.join(" | ")}`);
  }
  return v;
}

const mode = oneOf<Mode>("MODE", "demo", ["demo", "paper", "live"]);

export const config = {
  mode,
  demo: {
    speed: num("DEMO_SPEED", 60), // virtual seconds per real second
    seed: num("DEMO_SEED", 20260211),
    startTime: env("DEMO_START", "09:15"),
  },
  market: {
    symbol: env("SYMBOL", "NIFTY").toUpperCase(),
    exchange: env("EXCHANGE", "").toUpperCase(), // khaali = symbol se decide
    instrument: oneOf<Moneyness>("INSTRUMENT", "ATM", ["ATM", "ITM1", "ITM2", "OTM1", "OTM2"]),
    strikeStepAuto: bool("STRIKE_STEP_AUTO", true),
  },
  strategy: {
    name: env("STRATEGY", "orb").toLowerCase(),
    mode: oneOf<StrategyMode>("STRATEGY_MODE", "auto", ["auto", "local", "python"]),
    url: env("STRATEGY_URL", "http://127.0.0.1:8787").replace(/\/$/, ""),
    params: {} as Record<string, number | string | boolean>,
  },
  broker: {
    name: env("BROKER", "paper").toLowerCase(),
    product: env("PRODUCT", "MIS").toUpperCase(),
    slippagePct: num("SLIPPAGE_PCT", 0.35),
  },
  ai: {
    mode: oneOf<AiMode>("AI_MODE", "off", ["off", "veto", "decide"]),
    provider: env("AI_PROVIDER", "openai").toLowerCase(),
    model: env("AI_MODEL", "gpt-4o-mini"),
    apiKey: env("AI_API_KEY", process.env.OPENAI_API_KEY ?? ""),
    baseUrl: env("AI_BASE_URL", "").replace(/\/$/, ""),
    minConfidence: num("AI_MIN_CONFIDENCE", 0.6),
    maxTokens: num("AI_MAX_TOKENS", 400),
    temperature: num("AI_TEMPERATURE", 0.2),
  },
  risk: {
    capital: num("CAPITAL", 200_000),
    riskPct: num("RISK_PCT", 1.0),
    maxLots: num("MAX_LOTS", 2),
    maxTradesPerDay: num("MAX_TRADES_PER_DAY", 3),
    dailyLossPct: num("DAILY_LOSS_PCT", 2.0),
    maxConsecLosses: num("MAX_CONSEC_LOSSES", 3),
    cooldownMinutes: num("COOLDOWN_MINUTES", 15),
    minPremium: num("MIN_PREMIUM", 40),
    premiumSlCapPct: num("PREMIUM_SL_CAP_PCT", 30),
    premiumSlFloorPct: num("PREMIUM_SL_FLOOR_PCT", 12),
    premiumSafetyPct: num("PREMIUM_SAFETY_PCT", 60),
    minOneLot: bool("MIN_ONE_LOT", true),
    maxSingleLotRiskPct: num("MAX_SINGLE_LOT_RISK_PCT", 3.0),
    noTradeBefore: env("NO_TRADE_BEFORE", "09:20"),
    entryCutoff: env("ENTRY_CUTOFF", "14:45"),
    squareOff: env("SQUARE_OFF", "15:15"),
  },
  server: {
    host: env("HOST", "0.0.0.0"),
    port: num("PORT", 8788),
    logLevel: env("LOG_LEVEL", "info"),
  },
  dataDir: env("DATA_DIR", "data"),
  killSwitchFile: env("KILL_SWITCH_FILE", "KILL"),
  holidaysFile: env("HOLIDAYS_FILE", "config/holidays.json"),
  credentials: {
    zerodha: {
      apiKey: env("ZERODHA_API_KEY"),
      apiSecret: env("ZERODHA_API_SECRET"),
      accessToken: env("ZERODHA_ACCESS_TOKEN"),
    },
    angel: {
      apiKey: env("ANGEL_API_KEY"),
      clientId: env("ANGEL_CLIENT_ID"),
      pin: env("ANGEL_PIN"),
      totpSecret: env("ANGEL_TOTP_SECRET"),
      jwtToken: env("ANGEL_JWT_TOKEN"),
    },
    fyers: {
      clientId: env("FYERS_CLIENT_ID"),
      secret: env("FYERS_SECRET"),
      accessToken: env("FYERS_ACCESS_TOKEN"),
    },
    upstox: {
      apiKey: env("UPSTOX_API_KEY"),
      apiSecret: env("UPSTOX_API_SECRET"),
      accessToken: env("UPSTOX_ACCESS_TOKEN"),
    },
    dhan: {
      clientId: env("DHAN_CLIENT_ID"),
      accessToken: env("DHAN_ACCESS_TOKEN"),
    },
  },
  indexes: {
    lotSizeOverride: {} as Record<string, number>,
  },
} as const;

export interface Config {
  readonly mode: Mode;
  readonly demo: { readonly speed: number; readonly seed: number; readonly startTime: string };
  readonly market: {
    readonly symbol: string;
    readonly exchange: string;
    readonly instrument: Moneyness;
    readonly strikeStepAuto: boolean;
  };
  readonly strategy: {
    readonly name: string;
    readonly mode: StrategyMode;
    readonly url: string;
    readonly params: Record<string, number | string | boolean>;
  };
  readonly broker: { readonly name: string; readonly product: string; readonly slippagePct: number };
  readonly ai: {
    readonly mode: AiMode;
    readonly provider: string;
    readonly model: string;
    readonly apiKey: string;
    readonly baseUrl: string;
    readonly minConfidence: number;
    readonly maxTokens: number;
    readonly temperature: number;
  };
  readonly risk: {
    readonly capital: number;
    readonly riskPct: number;
    readonly maxLots: number;
    readonly maxTradesPerDay: number;
    readonly dailyLossPct: number;
    readonly maxConsecLosses: number;
    readonly cooldownMinutes: number;
    readonly minPremium: number;
    readonly premiumSlCapPct: number;
    readonly premiumSlFloorPct: number;
    readonly premiumSafetyPct: number;
    readonly minOneLot: boolean;
    readonly maxSingleLotRiskPct: number;
    readonly noTradeBefore: string;
    readonly entryCutoff: string;
    readonly squareOff: string;
  };
  readonly server: { readonly host: string; readonly port: number; readonly logLevel: string };
  readonly dataDir: string;
  readonly killSwitchFile: string;
  readonly holidaysFile: string;
  readonly credentials: Record<string, Record<string, string>>;
  readonly indexes: { readonly lotSizeOverride: Record<string, number> };
}

/** Startup pe config validate — galti se live orders na chale jayein. */
export function validateConfig(c: Config): string[] {
  const problems: string[] = [];
  const parse = (s: string, name: string): void => {
    try {
      parseHhmm(s);
    } catch {
      problems.push(`${name} ("${s}") HH:MM format me hona chahiye`);
    }
  };
  parse(c.risk.noTradeBefore, "NO_TRADE_BEFORE");
  parse(c.risk.entryCutoff, "ENTRY_CUTOFF");
  parse(c.risk.squareOff, "SQUARE_OFF");

  if (hhmmToMinutes(c.risk.noTradeBefore) >= hhmmToMinutes(c.risk.entryCutoff)) {
    problems.push("NO_TRADE_BEFORE ENTRY_CUTOFF se pehle hona chahiye");
  }
  if (hhmmToMinutes(c.risk.entryCutoff) >= hhmmToMinutes(c.risk.squareOff)) {
    problems.push("ENTRY_CUTOFF SQUARE_OFF se pehle hona chahiye");
  }
  if (c.risk.capital <= 0) problems.push("CAPITAL > 0 hona chahiye");
  if (c.risk.riskPct <= 0 || c.risk.riskPct > 5) problems.push("RISK_PCT 0-5% ke beech rakho (0.5-1% safe hai)");
  if (c.risk.maxLots < 1) problems.push("MAX_LOTS >= 1");
  if (c.risk.minPremium < 10) problems.push("MIN_PREMIUM >= 10 rakho (charges kha jaate hain warna)");
  if (c.mode === "live" && c.broker.name === "paper") {
    problems.push("MODE=live ke saath BROKER=paper set hai — live orders ke liye asli broker chuno");
  }
  if (c.mode === "live" && c.ai.mode !== "off" && !c.ai.apiKey && c.ai.provider !== "mock") {
    problems.push("AI_MODE on hai par AI_API_KEY khaali — AI_MODE=off karo ya key do");
  }
  if (c.broker.slippagePct < 0 || c.broker.slippagePct > 5) problems.push("SLIPPAGE_PCT 0-5 ke beech");
  return problems;
}

/** Params override CLI se: --set orb.buffer=4 */
export function applyOverrides(overrides: Record<string, string>): void {
  const bag = config.strategy.params as Record<string, number | string | boolean>;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === "true" || v === "false") bag[k] = v === "true";
    else if (Number.isFinite(Number(v)) && v.trim() !== "") bag[k] = Number(v);
    else bag[k] = v;
  }
}
