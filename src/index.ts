/**
 * index.ts — entry point. Yahan sab cheezein jud jaati hain:
 *
 *   clock + feed + broker + strategy + AI + risk + engine + dashboard server
 *
 * Chalao:
 *   npm run demo     — synthetic data + paper broker (ah koi bhi waqt)
 *   npm run paper    — asli broker data, orders simulate (BROKER=zerodha etc.)
 *   npm run live     — REAL orders. Yahi se paisa jaata hai, sambhal ke.
 *
 * CLI overrides:
 *   tsx src/index.ts --strategy ema_cross --ai veto --speed 120 --set target_rr=2.5
 */

import { existsSync } from "node:fs";

// ------------------------------------------------------------------ CLI parse
function parseArgs(argv: string[]): { flags: Record<string, string>; sets: Record<string, string> } {
  const flags: Record<string, string> = {};
  const sets: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "true";
    if (key === "set") {
      const [k, v] = val.split("=");
      if (k && v) sets[k] = v;
      continue;
    }
    flags[key] = val;
  }
  return { flags, sets };
}

const { flags, sets } = parseArgs(process.argv.slice(2));
const envMap: Record<string, string> = {
  mode: "MODE",
  strategy: "STRATEGY",
  broker: "BROKER",
  ai: "AI_MODE",
  symbol: "SYMBOL",
  instrument: "INSTRUMENT",
  product: "PRODUCT",
  speed: "DEMO_SPEED",
  port: "PORT",
  host: "HOST",
  capital: "CAPITAL",
  risk: "RISK_PCT",
  lots: "MAX_LOTS",
  url: "STRATEGY_URL",
  "strategy-mode": "STRATEGY_MODE",
  seed: "DEMO_SEED",
};
for (const [k, v] of Object.entries(flags)) {
  const envKey = envMap[k];
  if (envKey) process.env[envKey] = v;
  else if (k !== "help") console.warn(`[cli] unknown flag --${k} (ignored)`);
}

if (flags["help"]) {
  console.log(`
Algo India — index options algo trading (Python strategies + TS live engine)

  npm run demo | paper | live
  tsx src/index.ts --strategy orb --broker zerodha --ai veto --speed 120

Flags: --mode --strategy --broker --ai --symbol --instrument --product --speed --port
       --capital --risk --lots --url --strategy-mode --seed --set key=value
`);
  process.exit(0);
}

// ------------------------------------------------------------------ imports
const { config, validateConfig, applyOverrides } = await import("./config.ts");
const { RealClock, VirtualClock } = await import("./market/clock.ts");
const { SyntheticFeed, BrokerFeed } = await import("./market/feed.ts");
const { createBroker } = await import("./broker/index.ts");
const { StrategyRunner } = await import("./strategy/index.ts");
const { Journal } = await import("./engine/journal.ts");
const { Engine } = await import("./engine/engine.ts");
const { ApiServer } = await import("./server/server.ts");
const { istEpoch, istParts, parseHhmm } = await import("./util.ts");

applyOverrides(sets);

// ------------------------------------------------------------------ banner
function banner(lines: string[]): void {
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const top = "┌" + "─".repeat(width - 2) + "┐";
  const bottom = "└" + "─".repeat(width - 2) + "┘";
  console.log("\x1b[36m" + top);
  for (const l of lines) console.log("│ " + l.padEnd(width - 4) + " │");
  console.log(bottom + "\x1b[0m");
}

const modeLabels: Record<string, string> = {
  demo: "DEMO — synthetic data + paper broker (koi risk nahi)",
  paper: "PAPER — live data, orders simulate hote hain",
  live: "LIVE — REAL ORDERS, REAL PAISA",
};
banner([
  `Algo India — index options engine (${config.mode.toUpperCase()} mode)`,
  modeLabels[config.mode] ?? config.mode,
  `Index: ${config.market.symbol}   Instrument: ${config.market.instrument}   Product: ${config.broker.product}`,
  `Broker: ${config.broker.name}   Strategy: ${config.strategy.name} (${config.strategy.mode})   AI: ${config.ai.mode}`,
  `Capital: ₹${config.risk.capital.toLocaleString("en-IN")}   Risk/trade: ${config.risk.riskPct}%   Daily loss limit: ${config.risk.dailyLossPct}%`,
  `Dashboard: http://localhost:${config.server.port}`,
]);

// ------------------------------------------------------------------ validate
const problems = validateConfig(config);
if (problems.length) {
  console.error("\x1b[31mConfig me problem hai:\x1b[0m");
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}
if (!existsSync(config.holidaysFile)) {
  console.warn(`[warn] ${config.holidaysFile} nahi mila — holidays skip nahi honge. ` +
    `Banao: cp config/holidays.sample.json ${config.holidaysFile} (aur dates verify karo).`);
}

// ------------------------------------------------------------------ wire up
const clock = config.mode === "demo"
  ? new VirtualClock(istEpoch(...parseHhmm(config.demo.startTime), Date.now()), config.demo.speed, true)
  : new RealClock();

const journal = new Journal();
const broker = createBroker(config.broker.name);
await broker.init();

const feed = config.mode === "demo"
  ? new SyntheticFeed(clock, config.market.symbol)
  : new BrokerFeed(broker, config.market.symbol, 1000);

const strategy = new StrategyRunner(config.strategy.name);
const serviceUp = await strategy.ping();
console.log(
  serviceUp
    ? `[strategy] python service mil gayi (${config.strategy.url}) — asli strategies Python se chalengi`
    : `[strategy] python service nahi mili — TS local fallback chalega (python3 py/run.py serve se on karo)`,
);
if (!serviceUp) {
  try {
    await import("./strategy/local.ts");
  } catch (e) {
    console.error(`\x1b[31mLocal strategy load fail: ${(e as Error).message}\x1b[0m`);
    process.exit(1);
  }
}

let engine: InstanceType<typeof Engine>;
const server = new ApiServer((engine = new Engine({
  clock,
  feed,
  broker,
  strategy,
  journal,
  emit: (type, payload) => server.onEvent(type, payload),
})));

// ------------------------------------------------------------------ live warning
if (config.mode === "live") {
  console.log("\x1b[31m\n  ⚠️  LIVE MODE — 10 second me real orders shuru ho jayenge.");
  console.log(`     Broker: ${config.broker.name}   Capital: ₹${config.risk.capital.toLocaleString("en-IN")}`);
  console.log("     Rukna ho to abhi Ctrl+C dabao.\x1b[0m");
  for (let i = 10; i > 0; i--) {
    await new Promise((r) => setTimeout(r, 1000));
    if (i <= 3) process.stdout.write(`${i}… `);
  }
  console.log("\n");
}

// ------------------------------------------------------------------ start
await server.listen();
await engine.start();

// demo loop — session khatam hone pe naya virtual din
const demoLoop = setInterval(() => {
  if (config.mode !== "demo") return;
  const now = engine.clockNow();
  const p = istParts(now);
  if (p.minuteOfDay >= 15 * 60 + 30) {
    engine.writeDaySummary();
    // agle trading din 09:15 pe jump
    const [h, m] = parseHhmm(config.demo.startTime);
    let nextTs = istEpoch(h, m, now);
    while (nextTs <= now) nextTs += 86_400_000;
    // weekend skip
    while ([0, 6].includes(istParts(nextTs).weekday)) nextTs += 86_400_000;
    const vc = clock as InstanceType<typeof VirtualClock>;
    vc.advance(nextTs - now);
    engine.beginNewDay();
    console.log(`\n[demo] naya din: ${istParts(nextTs).dateKey} ${config.demo.startTime} (virtual clock ${config.demo.speed}x)`);
  }
}, 2000);

// ------------------------------------------------------------------ shutdown
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n\x1b[33m${signal} mila — engine band kar raha hoon (position square-off ho raha hai)…\x1b[0m`);
  clearInterval(demoLoop);
  try {
    await engine.stop();
  } catch (e) {
    console.error(`[shutdown] engine stop error: ${(e as Error).message}`);
  }
  await server.close();
  console.log(`\x1b[32mShutdown clean. Journal: ${journal.paths.dir}/ (trades.csv, events.jsonl, daily.csv)\x1b[0m`);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (e) => {
  console.error(`\x1b[31mUncaught: ${e.message}\n${e.stack}\x1b[0m`);
  void shutdown("uncaughtException");
});
process.on("unhandledRejection", (e) => {
  console.error(`\x1b[31mUnhandled rejection: ${(e as Error)?.message ?? e}\x1b[0m`);
});

console.log(`\x1b[32mEngine chal raha hai.\x1b[0m Dashboard: http://localhost:${config.server.port}  (Ctrl+C = band)\n`);
