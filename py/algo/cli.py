"""
cli.py — command line interface.

    python py/run.py list                            # strategies list
    python py/run.py backtest --strategy orb --days 60
    python py/run.py backtest --strategy vwap_reversion --data data/NIFTY_1m.csv --out out/vwap
    python py/run.py compare --days 60               # saari strategies compare
    python py/run.py serve --port 8787               # strategy service (live engine isse use karta hai)
    python py/run.py gen-data --days 90 --symbol NIFTY --out data/NIFTY_1m.csv
    python py/run.py demo                            # charges + indicators + sizing demo
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Optional

from .backtest import BacktestConfig, run_backtest
from .backtest.report import console, write_all
from .data import generate_history, load_csv, load_dir, save_csv
from .instruments import summary as instruments_summary
from .risk import RiskConfig
from .strategies import create, describe_all, names


def _parse_kv(pairs: list[str]) -> dict:
    out: dict = {}
    for kv in pairs or []:
        if "=" not in kv:
            continue
        k, v = kv.split("=", 1)
        lv = v.lower()
        if lv in ("true", "false"):
            out[k] = lv == "true"
        else:
            try:
                out[k] = int(v)
            except ValueError:
                try:
                    out[k] = float(v)
                except ValueError:
                    out[k] = v
    return out


def _load_bars(args) -> list:
    if args.data:
        bars = load_dir(args.data) if any(c in args.data for c in "*?[") else load_csv(args.data)
        print(f"→ {len(bars)} bars loaded from {args.data}")
        return bars
    bars = generate_history(
        symbol=args.symbol, days=args.days, seed=args.seed,
        start_price=args.start_price, annual_vol=args.vol,
    )
    print(f"→ synthetic data: {len(bars)} bars, {args.days} sessions, {args.symbol} (seed {args.seed})")
    print("  ⚠ SYNTHETIC DATA — ye sirf engine validation hai. Real edge jaanne ke liye --data <csv> do.")
    return bars


def cmd_list(args) -> int:
    print("\nSTRATEGIES\n" + "=" * 78)
    for d in describe_all():
        print(f"\n  {d['name']:<18} {d['description']}")
        print(f"  {'':<18} timeframes: {', '.join(d['timeframes'])}   warmup: {d['warmup']} bars")
        params = ", ".join(f"{k}={v['default']}" for k, v in d["params"].items())
        print(f"  {'':<18} params: {params}")
    print("\n" + instruments_summary())
    print("\nChalane ke liye:  python py/run.py backtest --strategy <name> --days 60\n")
    return 0


def cmd_backtest(args) -> int:
    bars = _load_bars(args)
    params = _parse_kv(args.param)
    rcfg = RiskConfig(
        capital=args.capital,
        risk_pct=args.risk_pct,
        max_lots=args.max_lots,
        max_trades_per_day=args.max_trades,
        daily_loss_limit_pct=args.daily_loss_limit,
        moneyness=args.moneyness,
    )
    cfg = BacktestConfig(
        symbol=args.symbol,
        strategy=args.strategy,
        params=params,
        capital=args.capital,
        risk=rcfg,
        broker=args.broker,
        use_options=not args.index_mode,
        moneyness=args.moneyness,
        iv=args.iv,
        slippage_pct=args.slippage,
        seed=args.seed,
        trail_after_r=args.trail_r,
        max_hold_minutes=args.max_hold,
        start=args.start,
        end=args.end,
    )
    m, bt = run_backtest(bars, cfg, verbose=args.verbose)
    if not args.data:
        m.notes.insert(0, "SYNTHETIC DATA: numbers sirf engine check ke liye — real data (--data) se dobara chalao")
    extra = {
        "Strategy": f"{args.strategy} {params if params else ''}",
        "Symbol": args.symbol,
        "Broker (charges)": args.broker,
        "Mode": "index points" if args.index_mode else f"options {args.moneyness}, IV {args.iv:.0%}",
        "Capital": f"₹{args.capital:,.0f} @ {args.risk_pct}% risk",
    }
    console(m, f"BACKTEST — {args.strategy.upper()} / {args.symbol}", extra)
    paths = write_all(bt, m, outdir=args.out, cfg={**cfg.__dict__, "risk": rcfg.__dict__, "params": params} if args.save_config else None)
    print("\nFiles:")
    for k, v in paths.items():
        print(f"  {k:<8} {v}")
    if args.json:
        print("\n" + json.dumps(m.to_dict(), indent=2))
    return 0


def cmd_compare(args) -> int:
    bars = _load_bars(args)
    rows = []
    print(f"\n{'strategy':<18}{'trades':>7}{'win%':>7}{'gross':>11}{'charges':>10}{'net':>11}{'ret%':>8}{'PF':>6}{'maxDD':>10}")
    print("-" * 95)
    for name in names():
        cfg = BacktestConfig(
            symbol=args.symbol, strategy=name, capital=args.capital,
            risk=RiskConfig(capital=args.capital, risk_pct=args.risk_pct, max_lots=args.max_lots),
            broker=args.broker, seed=args.seed, iv=args.iv,
        )
        m, _ = run_backtest(bars, cfg)
        rows.append((name, m))
        print(
            f"{name:<18}{m.trades:>7}{m.win_rate:>7.1f}{m.gross:>11,.0f}{-m.charges:>10,.0f}"
            f"{m.net:>11,.0f}{m.return_pct:>8.2f}{m.profit_factor:>6.2f}{m.max_drawdown:>10,.0f}"
        )
    print("-" * 95)
    best = max(rows, key=lambda r: r[1].net) if rows else None
    if best:
        print(f"best net: {best[0]} ({best[1].net:,.0f})   |   note: charges ke baad ka net hi sach hai")
    return 0


def cmd_serve(args) -> int:
    from .service.app import serve

    serve(port=args.port, host=args.host)
    return 0


def cmd_gen_data(args) -> int:
    bars = generate_history(symbol=args.symbol, days=args.days, seed=args.seed,
                            start_price=args.start_price, annual_vol=args.vol)
    save_csv(bars, args.out)
    days = len({b.ts // 86_400_000 for b in bars})
    print(f"✔ {len(bars)} bars → {args.out}  ({args.symbol}, ~{days} sessions)")
    print("  NOTE: ye synthetic data hai — real backtest ke liye broker/NSE ka CSV daalo "
          "(format: ts,open,high,low,close,volume)")
    return 0


def cmd_demo(args) -> int:
    from .charges import _demo as charges_demo
    from .options import demo as options_demo
    from .risk import RiskConfig as RC, RiskManager

    print("=" * 70)
    print("1) OPTION PRICING / GREEKS")
    print("=" * 70)
    options_demo()
    print("\n" + "=" * 70)
    print("2) CHARGES (round trip)")
    print("=" * 70)
    charges_demo()
    print("\n" + "=" * 70)
    print("3) POSITION SIZING")
    print("=" * 70)
    rm = RiskManager(RC(capital=200_000, risk_pct=1.0))
    for prem, sl_pts, delta in ((120, 40, 0.5), (300, 30, 0.6), (60, 50, 0.45)):
        lots = rm.size_lots(prem, 75, sl_pts, delta)
        print(f"  premium ₹{prem:<5} SL {sl_pts}pts delta {delta} -> {lots} lots "
              f"({lots * 75} qty, ₹{lots * 75 * prem:,.0f} premium, risk ₹{lots * 75 * sl_pts * delta:,.0f})")
    print("\n" + "=" * 70)
    print("4) STRATEGIES")
    print("=" * 70)
    for d in describe_all():
        print(f"  {d['name']:<18} {d['description']}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="py/run.py", description="Indian market algo — strategies & backtest")
    sub = p.add_subparsers(dest="cmd")

    def add_common(sp, symbol_default="NIFTY"):
        sp.add_argument("--symbol", default=symbol_default)
        sp.add_argument("--days", type=int, default=60)
        sp.add_argument("--data", default=None, help="CSV path ya glob (e.g. data/*.csv)")
        sp.add_argument("--seed", type=int, default=42)
        sp.add_argument("--start-price", type=float, default=25000.0, dest="start_price")
        sp.add_argument("--vol", type=float, default=0.14, help="annualised vol (synthetic data)")

    sp = sub.add_parser("list", help="strategies + instruments")
    sp.set_defaults(func=cmd_list)

    sp = sub.add_parser("backtest", help="ek strategy ka backtest")
    add_common(sp)
    sp.add_argument("--strategy", default="orb")
    sp.add_argument("--param", action="append", default=[], help="strategy param: key=value (repeatable)")
    sp.add_argument("--capital", type=float, default=200_000)
    sp.add_argument("--risk-pct", type=float, default=1.0, dest="risk_pct")
    sp.add_argument("--max-lots", type=int, default=3, dest="max_lots")
    sp.add_argument("--max-trades", type=int, default=5, dest="max_trades")
    sp.add_argument("--daily-loss-limit", type=float, default=2.0, dest="daily_loss_limit")
    sp.add_argument("--broker", default="zerodha", help="zerodha|angelone|fyers|upstox|dhan|paper")
    sp.add_argument("--moneyness", default="ATM", help="ATM|OTM1|OTM2|ITM1")
    sp.add_argument("--iv", type=float, default=0.13)
    sp.add_argument("--slippage", type=float, default=0.35, help="premium ka % slippage")
    sp.add_argument("--trail-r", type=float, default=0.0, dest="trail_r", help="1.0 = 1R pe breakeven")
    sp.add_argument("--max-hold", type=int, default=0, dest="max_hold", help="minutes")
    sp.add_argument("--index-mode", action="store_true", dest="index_mode", help="options ke bajaye index points PnL")
    sp.add_argument("--start", default=None)
    sp.add_argument("--end", default=None)
    sp.add_argument("--out", default="out")
    sp.add_argument("--verbose", action="store_true")
    sp.add_argument("--json", action="store_true")
    sp.add_argument("--save-config", action="store_true", dest="save_config")
    sp.set_defaults(func=cmd_backtest)

    sp = sub.add_parser("compare", help="saari strategies compare")
    add_common(sp)
    sp.add_argument("--capital", type=float, default=200_000)
    sp.add_argument("--risk-pct", type=float, default=1.0, dest="risk_pct")
    sp.add_argument("--max-lots", type=int, default=3, dest="max_lots")
    sp.add_argument("--broker", default="zerodha")
    sp.add_argument("--iv", type=float, default=0.13)
    sp.set_defaults(func=cmd_compare)

    sp = sub.add_parser("serve", help="strategy HTTP service")
    sp.add_argument("--port", type=int, default=8787)
    sp.add_argument("--host", default="0.0.0.0")
    sp.set_defaults(func=cmd_serve)

    sp = sub.add_parser("gen-data", help="synthetic data CSV banao")
    sp.add_argument("--symbol", default="NIFTY")
    sp.add_argument("--days", type=int, default=90)
    sp.add_argument("--seed", type=int, default=42)
    sp.add_argument("--start-price", type=float, default=25000.0, dest="start_price")
    sp.add_argument("--vol", type=float, default=0.14)
    sp.add_argument("--out", default="data/NIFTY_1m.csv")
    sp.set_defaults(func=cmd_gen_data)

    sp = sub.add_parser("demo", help="pricing/charges/sizing demo")
    sp.set_defaults(func=cmd_demo)
    return p


def main(argv: Optional[list[str]] = None) -> int:
    p = build_parser()
    args = p.parse_args(argv)
    if not getattr(args, "cmd", None):
        p.print_help()
        return 0
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
