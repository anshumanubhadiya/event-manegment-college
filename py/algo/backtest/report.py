"""report.py — backtest result ko console + files me report karo."""

from __future__ import annotations

import json
import os
from datetime import datetime
from typing import Optional

from ..data.loader import save_trades_csv
from ..types import Trade, to_jsonable
from .metrics import Metrics


def _inr(x: float) -> str:
    sign = "-" if x < 0 else ""
    return f"{sign}₹{abs(x):,.0f}"


def console(m: Metrics, title: str = "BACKTEST RESULT", extra: Optional[dict] = None) -> str:
    W = 62
    lines: list[str] = []
    lines.append("┌" + "─" * W + "┐")
    lines.append("│ " + title.center(W - 1) + "│")
    lines.append("├" + "─" * W + "┤")

    def row(k: str, v: str, flag: str = "") -> None:
        lines.append("│ " + f"{k:<26}{v:>{W - 29}}{(' ' + flag) if flag else '  '}" + "│")

    row("Trades", f"{m.trades}")
    row("Win rate", f"{m.win_rate:.1f}%  ({m.wins}W / {m.losses}L)")
    row("Gross PnL", _inr(m.gross))
    row("Charges", "-" + _inr(m.charges))
    row("Net PnL", _inr(m.net), "💰" if m.net > 0 else "🔻")
    row("Return on capital", f"{m.return_pct:.2f}%")
    lines.append("│" + " " * (W + 1) + "│")
    row("Avg win / Avg loss", f"{_inr(m.avg_win)} / {_inr(m.avg_loss)}")
    row("Expectancy / trade", _inr(m.expectancy))
    row("Profit factor", f"{m.profit_factor:.2f}")
    row("Best / Worst trade", f"{_inr(m.best_trade)} / {_inr(m.worst_trade)}")
    row("Max drawdown", f"{_inr(m.max_drawdown)} ({m.max_drawdown_pct:.1f}%)")
    row("Sharpe / Sortino", f"{m.sharpe:.2f} / {m.sortino:.2f}")
    lines.append("│" + " " * (W + 1) + "│")
    row("Trading days", f"{m.trading_days}  ({m.days_green}G / {m.days_red}R)")
    row("Trades per day", f"{m.trades_per_day:.2f}")
    row("Best / Worst day", f"{_inr(m.best_day)} / {_inr(m.worst_day)}")
    row("Max consec W / L", f"{m.max_consec_wins} / {m.max_consec_losses}")
    row("Charges as % of gross", f"{m.avg_charges_pct_of_gross:.1f}%")
    if extra:
        lines.append("├" + "─" * W + "┤")
        for k, v in extra.items():
            row(str(k), str(v))
    if m.notes:
        lines.append("├" + "─" * W + "┤")
        for n in m.notes:
            for i in range(0, len(n), W - 4):
                lines.append("│ ⚠ " + n[i : i + W - 4].ljust(W - 3) + "│")
    lines.append("└" + "─" * W + "┘")
    out = "\n".join(lines)
    print(out)
    return out


def markdown(m: Metrics, cfg: Optional[dict] = None, trades: Optional[list[Trade]] = None) -> str:
    lines = ["# Backtest Report", "", f"_Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}_", ""]
    if cfg:
        lines += ["## Config", "", "```json", json.dumps(cfg, indent=2, default=str), "```", ""]
    lines += [
        "## Summary",
        "",
        "| Metric | Value |",
        "|---|---|",
        f"| Trades | {m.trades} |",
        f"| Win rate | {m.win_rate:.1f}% ({m.wins}W / {m.losses}L) |",
        f"| Gross PnL | {_inr(m.gross)} |",
        f"| Charges | {_inr(m.charges)} |",
        f"| **Net PnL** | **{_inr(m.net)}** |",
        f"| Return | {m.return_pct:.2f}% |",
        f"| Expectancy/trade | {_inr(m.expectancy)} |",
        f"| Profit factor | {m.profit_factor:.2f} |",
        f"| Max drawdown | {_inr(m.max_drawdown)} ({m.max_drawdown_pct:.1f}%) |",
        f"| Sharpe / Sortino | {m.sharpe:.2f} / {m.sortino:.2f} |",
        f"| Trades/day | {m.trades_per_day:.2f} |",
        f"| Charging drag | {m.avg_charges_pct_of_gross:.1f}% of gross |",
        "",
    ]
    if m.notes:
        lines += ["## Warnings", ""] + [f"- {n}" for n in m.notes] + [""]
    if m.daily:
        lines += ["## Daily PnL", "", "| Day | Net | Trades | Wins |", "|---|---|---|---|"]
        for d in m.daily[-30:]:
            lines.append(f"| {d['day']} | {_inr(d['net'])} | {d['trades']} | {d.get('wins', '')} |")
        lines.append("")
    if trades:
        lines += ["## Last 10 trades", "", "| Entry | Opt | Entry ₹ | Exit ₹ | Qty | Net | Reason |",
                  "|---|---|---|---|---|---|---|"]
        for t in trades[-10:]:
            opt = (t.meta or {}).get("optType", "")
            strike = (t.meta or {}).get("strike", "")
            lines.append(
                f"| {datetime.fromtimestamp(t.entry_ts / 1000).strftime('%d %b %H:%M')} | {strike}{opt} | {t.entry:.1f} | {t.exit:.1f} | {t.qty} | {_inr(t.net)} | {t.reason} |"
            )
        lines.append("")
    return "\n".join(lines)


def write_all(bt, m: Metrics, outdir: str = "out", cfg: Optional[dict] = None) -> dict:
    """summary.json + trades.csv + equity.csv + report.md"""
    os.makedirs(outdir, exist_ok=True)
    paths: dict[str, str] = {}

    p = os.path.join(outdir, "summary.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump({"config": cfg or {}, "metrics": m.to_dict(), "equity": [to_jsonable(x) for x in bt.equity_curve]}, f, indent=2)
    paths["summary"] = p

    p = os.path.join(outdir, "trades.csv")
    save_trades_csv([t.to_row() for t in bt.trades], p)
    paths["trades"] = p

    p = os.path.join(outdir, "equity.csv")
    with open(p, "w", encoding="utf-8") as f:
        f.write("day,equity,realized,trades\n")
        for e in bt.equity_curve:
            f.write(f"{e['day']},{e['equity']},{e['realized']},{e['trades']}\n")
    paths["equity"] = p

    p = os.path.join(outdir, "report.md")
    with open(p, "w", encoding="utf-8") as f:
        f.write(markdown(m, cfg, bt.trades))
    paths["report"] = p

    if bt.events:
        p = os.path.join(outdir, "events.jsonl")
        with open(p, "w", encoding="utf-8") as f:
            for e in bt.events:
                f.write(json.dumps(to_jsonable(e)) + "\n")
        paths["events"] = p

    return paths
