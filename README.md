# Algo India — index options algo trading system

Indian market (NIFTY / BANKNIFTY / SENSEX) index options ke liye algotrading system —
[jev-trader](https://github.com/jarrodwatts/jev-trader) jaisi functionality, par India ke
brokers aur F&O segment ke liye.

**Hybrid stack:**

| Layer | Tech | Kaam |
|---|---|---|
| Strategy + backtest | **Python** (zero deps, pure stdlib) | strategies likhna, backtest, metrics |
| Live engine + dashboard | **TypeScript** (Node 22, zero runtime deps) | tick loop, risk, orders, journal, SSE dashboard |
| AI layer | TS (OpenAI / Anthropic / Google / OpenAI-compatible) | signal validate ya decide karna |
| Brokers | TS adapters | Zerodha, Angel One, Fyers, Upstox, Dhan + Paper |

---

## Quick start

```bash
npm install                # dev deps (tsx + typescript) — runtime me kuch nahi chahiye

npm run demo               # synthetic data + paper broker — sabse pehle yahi chalao
# → http://localhost:8788  pe dashboard khul jayega (SSE live)
# demo me 1 real second = 1 virtual minute, din khatam hone pe agla din apne aap
```

Doosre modes:

```bash
npm run paper              # asli broker ka live data, orders simulate (BROKER=zerodha ...)
npm run live               # REAL orders — paisa lagta hai, sambhal ke
npm test                   # TS engine self-tests (49 tests)
npm run py:test            # Python strategies + backtest tests (36 tests)
```

Speed/strategy badalni ho:

```bash
tsx src/index.ts --mode demo --speed 300 --strategy ema_cross --ai veto
tsx src/index.ts --help    # saare flags
```

### Python side (strategies + backtest)

```bash
python3 py/run.py list                                   # kaunsi strategies hain
python3 py/run.py backtest --strategy orb --days 60      # synthetic pe backtest
python3 py/run.py backtest --strategy orb --data my.csv  # apna data (real edge ke liye yahi)
python3 py/run.py compare --days 60                      # saari strategies compare
python3 py/run.py serve --port 8787                      # live engine isse signals maangta hai
```

> ⚠️ **Synthetic data pe jo PnL dikhta hai wo edge nahi hai.** Wo sirf engine validate
> karne ke liye hai (fills, charges, exits, risk sahi chal rahe ya nahi). Real edge
> jaanne ke liye apna CSV do (`--data`) — CSV me columns:
> `ts,open,high,low,close,volume` (1-minute bars, IST).

---

## Architecture

```
                      ┌──────────────── Python (strategies + backtest) ───────────────┐
                      │  py/algo/strategies/*.py   ← aap yahan strategy likho        │
                      │  py/algo/backtest/         ← 60 din ka backtest, metrics     │
                      │  py/algo/service/app.py    ← POST /signal (HTTP, JSON)       │
                      └───────────────────────▲──────────────────────────────────────┘
                                              │ MarketState JSON
┌───────────────────────────────── TypeScript live engine ──┴──────────────────────────┐
│  feed ─► candles ─► StrategyRunner ─► AI gate ─► RiskManager ─► order ─► journal      │
│  (synthetic / broker REST)              (off|veto|decide)      (paper / real broker)  │
│  ApiServer ─► dashboard (SSE)      Engine ─► exits (index SL/target, premium stop)    │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**Ek jagah strategy likho, dono jagah chale:** live engine pehle Python service se signal
maangta hai (`STRATEGY_MODE=auto`). Service band ho to wahi strategy ka TS port chalta hai —
engine rukta nahi. Dashboard pe `strategySource: python | local` dikhta hai.

### Strategy likhna (Python)

```python
# py/algo/strategies/base.py dekho — bas on_state() implement karo
class MyEdge(Strategy):
    name = "my_edge"
    default_params = {"threshold": 1.5}
    timeframes = ("5m",)

    def on_state(self, s: MarketState) -> Signal:
        if <condition>:
            return self.buy(reason="breakout", stop=s.ltp - 30, target=s.ltp + 60, confidence=0.7)
        return self.hold()
```

Rules: **order placement / sizing aap nahi karte** — engine karta hai. Aap sirf
intent (buy/sell/hold/exit) + index levels do. TS me same strategy likhni ho to
`src/strategy/local.ts` mirror hai.

Built-in strategies: `orb`, `ema_cross`, `vwap_reversion`, `supertrend_adx`.

### AI layer — teen modes (`AI_MODE`)

| Mode | Kya karta hai |
|---|---|
| `off` | sirf rules (koi AI call nahi) |
| `veto` | strategy ka signal AI ko jaata hai — `take`/`skip` (aur confidence >= `AI_MIN_CONFIDENCE`) |
| `decide` | AI final decision leta hai (`buy`/`sell`/`hold`) — jev-trader style |

Exits kabhi gate nahi hote (position safe rakhna pehle). API key na ho / call fail ho to
**MockModel** chalta hai (deterministic heuristic) — engine rukta nahi, aur dashboard pe
"mock" dikhta hai. Providers: `AI_PROVIDER=openai|anthropic|google|openai-compatible`
(OpenRouter / Groq / Ollama ke liye `AI_BASE_URL`).

### Brokers

| Broker | Adapter | Live orders |
|---|---|---|
| `paper` | built-in | simulate (realistic fills, slippage, charges) |
| `zerodha` | Kite Connect v3 | ✅ |
| `angel` | Angel One SmartAPI (+TOTP) | ✅ |
| `fyers` | Fyers API v3 | ✅ |
| `upstox` | Upstox v2 | ✅ |
| `dhan` | Dhan HQ v2 | ✅ |

Sab Indian retail brokers same order API shape use karte hain (`placeOrder`, `cancelOrder`,
`orders`, `positions`), isliye broker badalna = `.env` me `BROKER=` badalna.

---

## Risk rules (defaults, `.env` se badal sakte ho)

- Capital ₹2,00,000 · **1% risk/trade** · max 2 lots · max 3 trades/day
- Daily loss limit **2%** → din band · 3 lagatar loss → halt · loss ke baad 15 min cooldown
- Entry window **09:20–14:45** IST, **15:15 square-off** (MIS), close ke 20 min pehle new entry nahi
- ATM option (CE for buy signal, PE for sell), min premium ₹40
- Index SL distance → premium SL (delta ke through), premium ka 30% cap / 12% floor
- Premium disaster stop 60% (IV crush / gap ke liye) + broker pe **SL-M** safety order
- **KILL** file banao to engine turant square-off karke ruk jaata hai

## Journal / data

`data/` me sab likha jata hai (`DATA_DIR`):
`events.jsonl` (har event), `trades.csv` (closed trades, charges ke saath),
`daily.csv` (din ka summary), `session-<date>.json`.

## Config

`.env.example` copy karo → `.env`. Sab knobs (broker creds, risk, strategy, AI, time
guards) usme documented hain. CLI flags bhi hain:

```bash
tsx src/index.ts --strategy ema_cross --ai veto --speed 120 --set target_rr=2.5
tsx src/index.ts --help
```

## Disclaimers

1. **Synthetic/backtest PnL ≠ real edge.** Real data pe validate karo.
2. Broker adapters type-check hote hain par live API se verify nahi hue — pehla live order
   chhote qty se test karo.
3. Options trading me loss capital se zyada bhi ho sakta hai (gap). Ye software "as-is" hai,
   apne risk pe chalao.
4. NSE holidays `config/holidays.json` me hain — apne broker calendar se verify karo.
