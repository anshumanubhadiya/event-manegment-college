"""metrics.py — trades + daily PnL se performance statistics."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional

from ..types import Trade


@dataclass
class Metrics:
    trades: int = 0
    wins: int = 0
    losses: int = 0
    win_rate: float = 0.0
    gross: float = 0.0
    charges: float = 0.0
    net: float = 0.0
    avg_win: float = 0.0
    avg_loss: float = 0.0
    avg_trade: float = 0.0
    expectancy: float = 0.0
    profit_factor: float = 0.0
    max_drawdown: float = 0.0
    max_drawdown_pct: float = 0.0
    sharpe: float = 0.0
    sortino: float = 0.0
    best_trade: float = 0.0
    worst_trade: float = 0.0
    best_day: float = 0.0
    worst_day: float = 0.0
    max_consec_wins: int = 0
    max_consec_losses: int = 0
    trading_days: int = 0
    days_green: int = 0
    days_red: int = 0
    trades_per_day: float = 0.0
    avg_charges_pct_of_gross: float = 0.0
    equity_end: float = 0.0
    return_pct: float = 0.0
    daily: list[dict] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = {k: v for k, v in self.__dict__.items() if k != "daily"}
        d["daily"] = self.daily[-60:]  # last 60 days (chart ke liye kaafi)
        return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in d.items()}


def _consec(values: list[bool], want: bool) -> int:
    best = cur = 0
    for v in values:
        if v == want:
            cur += 1
            best = max(best, cur)
        else:
            cur = 0
    return best


def compute(trades: list[Trade], capital: float, daily: Optional[list[dict]] = None) -> Metrics:
    """`daily` = [{"day": "YYYY-MM-DD", "net": float}, ...] (optional)."""
    m = Metrics()
    if not trades:
        m.equity_end = capital
        return m

    nets = [t.net for t in trades]
    wins = [n for n in nets if n > 0]
    losses = [n for n in nets if n <= 0]

    m.trades = len(trades)
    m.wins = len(wins)
    m.losses = len(losses)
    m.win_rate = len(wins) / len(trades) * 100
    m.gross = sum(t.gross for t in trades)
    m.charges = sum(t.charges for t in trades)
    m.net = sum(nets)
    m.avg_win = sum(wins) / len(wins) if wins else 0.0
    m.avg_loss = sum(losses) / len(losses) if losses else 0.0
    m.avg_trade = m.net / m.trades
    m.expectancy = m.win_rate / 100 * m.avg_win + (1 - m.win_rate / 100) * m.avg_loss
    gross_win = sum(wins)
    gross_loss = abs(sum(losses))
    m.profit_factor = (gross_win / gross_loss) if gross_loss > 0 else (999.0 if gross_win > 0 else 0.0)
    m.best_trade = max(nets)
    m.worst_trade = min(nets)
    m.max_consec_wins = _consec([n > 0 for n in nets], True)
    m.max_consec_losses = _consec([n > 0 for n in nets], False)
    m.avg_charges_pct_of_gross = (m.charges / abs(m.gross) * 100) if m.gross else 0.0

    # equity curve se drawdown
    eq = capital
    peak = capital
    dd = 0.0
    dd_pct = 0.0
    for n in nets:
        eq += n
        peak = max(peak, eq)
        dd = max(dd, peak - eq)
        dd_pct = max(dd_pct, (peak - eq) / peak * 100 if peak else 0.0)
    m.max_drawdown = dd
    m.max_drawdown_pct = dd_pct
    m.equity_end = eq
    m.return_pct = (eq - capital) / capital * 100 if capital else 0.0

    # daily stats
    if not daily:
        daily = _daily_from_trades(trades)
    m.daily = daily
    m.trading_days = len(daily)
    m.days_green = sum(1 for d in daily if d["net"] > 0)
    m.days_red = sum(1 for d in daily if d["net"] < 0)
    m.trades_per_day = m.trades / m.trading_days if m.trading_days else 0.0
    if daily:
        day_nets = [d["net"] for d in daily]
        m.best_day = max(day_nets)
        m.worst_day = min(day_nets)
        rets = [n / capital for n in day_nets]
        m.sharpe = _sharpe(rets)
        m.sortino = _sortino(rets)

    if m.charges > abs(m.gross) and m.gross > 0:
        m.notes.append(f"charges (₹{m.charges:,.0f}) gross profit ka {m.charges / m.gross * 100:.0f}% kha gaye — chhota SL / chhota premium mat rakho")
    if abs(m.net) < m.charges:
        m.notes.append("net PnL charges ke barabar hai — edge charges cover karne layak nahi hai")
    if m.trading_days and m.trades_per_day > 5:
        m.notes.append(f"{m.trades_per_day:.1f} trades/day — brokerage aur STT bahut lag raha hai")
    return m


def _daily_from_trades(trades: list[Trade]) -> list[dict]:
    from ..data.resample import session_key

    by_day: dict[str, dict] = {}
    for t in trades:
        day = session_key(t.exit_ts or t.entry_ts)
        d = by_day.setdefault(day, {"day": day, "net": 0.0, "gross": 0.0, "charges": 0.0, "trades": 0, "wins": 0})
        d["net"] += t.net
        d["gross"] += t.gross
        d["charges"] += t.charges
        d["trades"] += 1
        d["wins"] += 1 if t.win else 0
    out = []
    for d in sorted(by_day.values(), key=lambda x: x["day"]):
        d["net"] = round(d["net"], 2)
        d["gross"] = round(d["gross"], 2)
        d["charges"] = round(d["charges"], 2)
        out.append(d)
    return out


def _sharpe(returns: list[float]) -> float:
    if len(returns) < 2:
        return 0.0
    mean = sum(returns) / len(returns)
    var = sum((r - mean) ** 2 for r in returns) / (len(returns) - 1)
    sd = math.sqrt(var)
    if sd == 0:
        return 0.0
    return mean / sd * math.sqrt(252)


def _sortino(returns: list[float]) -> float:
    if len(returns) < 2:
        return 0.0
    mean = sum(returns) / len(returns)
    downside = [r for r in returns if r < 0]
    if not downside:
        return 999.0 if mean > 0 else 0.0
    dd = math.sqrt(sum(r * r for r in downside) / len(downside))
    return mean / dd * math.sqrt(252) if dd else 0.0
