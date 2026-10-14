"""
risk.py — position sizing, risk limits, kill switch. Backtest aur live dono use karte hain.

Rules:
  * Per trade risk = capital ka `risk_pct` (default 1%)
  * SL distance (index points) -> option premium move (delta ke through)
  * lots = floor(risk_rupees / (lot_size * premium_SL_distance))
  * Daily loss limit hit -> trading band
  * Max trades/day, max consecutive losses, cooldown
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class RiskConfig:
    capital: float = 200_000.0        # working capital (₹)
    risk_pct: float = 1.0             # per trade risk, % of capital
    max_lots: int = 3                 # hard cap per trade
    max_trades_per_day: int = 5
    daily_loss_limit_pct: float = 2.0      # capital ka % — hit hone pe stop
    daily_profit_target_pct: float = 0.0   # 0 = off
    max_consecutive_losses: int = 3
    cooldown_after_loss_min: int = 15      # loss ke baad itna wait
    max_open_positions: int = 1
    # option side selection
    moneyness: str = "ATM"            # ATM / OTM1 / OTM2 / ITM1
    # premium-based SL: index SL ko delta se premium me convert karte hain,
    # phir premium ka max/min % cap lagate hain (0DTE options me index SL bahut bada ho jata hai)
    premium_sl_cap_pct: float = 30.0   # premium ka max % jo ek trade me risk ho
    premium_sl_floor_pct: float = 12.0 # kam se kam % (noise se SL hit na ho)
    # chhote account me 1 lot ka risk risk_pct se zyada ho jata hai — usko allow karo
    # agar wo hard cap ke andar hai (retail reality), warna trade skip
    min_one_lot: bool = True
    max_single_lot_risk_pct: float = 3.0
    # disaster stop: index stop ke ilawa premium bhi itna % gir jaye to nikal jao
    # (IV crush / gap-down ke liye; normal exit index level se hota hai)
    premium_safety_pct: float = 60.0
    option_type_mode: str = "auto"    # auto = buy ke liye CE, sell ke liye PE
    premium_stop_pct: float = 30.0    # premium ka % SL (fallback agar index SL na ho)
    min_premium: float = 40.0         # isse sasta option skip (charges kha jaate hain)
    min_lots_value: float = 0.0
    # time guards (IST)
    no_entry_before: str = "09:20"
    no_entry_after: str = "14:45"
    square_off_at: str = "15:14"
    min_minutes_to_close: int = 20    # itne min se kam bache to entry nahi


@dataclass
class RiskState:
    capital: float
    day: str = ""
    day_start_equity: float = 0.0
    realized_today: float = 0.0
    trades_today: int = 0
    consecutive_losses: int = 0
    last_loss_ts: float = 0.0
    halted: bool = False
    halt_reason: str = ""
    peak_equity: float = 0.0
    max_drawdown: float = 0.0

    def equity(self) -> float:
        return self.capital + self.realized_today


class RiskManager:
    """Hamesha ek hi instance — backtest me bhi, live me bhi."""

    def __init__(self, cfg: Optional[RiskConfig] = None):
        self.cfg = cfg or RiskConfig()
        self.state = RiskState(capital=self.cfg.capital, day_start_equity=self.cfg.capital, peak_equity=self.cfg.capital)

    # ------------------------------------------------------------------ day #
    def roll_day(self, day: str, equity: float) -> None:
        if self.state.day == day:
            return
        self.state.day = day
        self.state.day_start_equity = equity
        self.state.realized_today = 0.0
        self.state.trades_today = 0
        self.state.consecutive_losses = 0
        self.state.halted = False
        self.state.halt_reason = ""

    # ---------------------------------------------------------------- sizing #
    def size_lots(
        self,
        premium: float,
        lot_size: int,
        index_stop_distance: Optional[float],
        delta: Optional[float] = None,
    ) -> int:
        """
        Risk-based lots. index_stop_distance = entry se SL tak index points.
        delta na ho to 0.5 maan lete hain (ATM ka typical).
        """
        if premium <= 0 or lot_size <= 0:
            return 0
        risk_rupees = self.state.equity() * self.cfg.risk_pct / 100.0
        if index_stop_distance and index_stop_distance > 0:
            d = abs(delta if delta else 0.5)
            premium_move = max(index_stop_distance * d, premium * 0.05)
        else:
            premium_move = premium * self.cfg.premium_stop_pct / 100.0
        per_lot_risk = premium_move * lot_size
        if per_lot_risk <= 0:
            return 0
        lots = int(risk_rupees // per_lot_risk)
        # stop bhi to hai, par ek lot ka premium bhi capital ke andar hona chahiye
        max_affordable = int((self.state.equity() * 0.5) // (premium * lot_size))
        lots = min(lots, self.cfg.max_lots, max(max_affordable, 0))
        return max(lots, 0)

    def premium_move(self, premium: float, index_stop_distance: Optional[float], delta: Optional[float]) -> float:
        """Index SL -> premium SL (delta ke through), % caps ke saath."""
        if premium <= 0:
            return 0.0
        if index_stop_distance and index_stop_distance > 0:
            d = abs(delta if delta else 0.5)
            move = index_stop_distance * d
        else:
            move = premium * self.cfg.premium_sl_cap_pct / 100.0
        cap = premium * self.cfg.premium_sl_cap_pct / 100.0
        floor = premium * self.cfg.premium_sl_floor_pct / 100.0
        return max(min(move, cap), floor)

    def size_lots_for_premium(self, premium_entry: float, premium_stop: float, lot_size: int) -> tuple[int, str]:
        """
        Premium SL se exact sizing: risk/lot = (entry - stop) x lot_size.
        Returns (lots, note).
        """
        if premium_entry <= 0 or lot_size <= 0:
            return 0, "invalid premium/lot"
        per_lot = max(premium_entry - premium_stop, 0.05) * lot_size
        risk_rupees = self.state.equity() * self.cfg.risk_pct / 100.0
        affordable = int((self.state.equity() * 0.5) // max(premium_entry * lot_size, 1))
        lots = int(risk_rupees // per_lot)
        lots = min(lots, self.cfg.max_lots, max(affordable, 0))
        note = "ok"
        if lots == 0:
            hard = self.state.equity() * self.cfg.max_single_lot_risk_pct / 100.0
            if self.cfg.min_one_lot and affordable >= 1 and per_lot <= hard:
                lots = 1
                note = f"min 1 lot (per-lot risk ₹{per_lot:,.0f} > {self.cfg.risk_pct:.1f}% but within {self.cfg.max_single_lot_risk_pct:.1f}% cap)"
            else:
                return 0, (f"risk sizing 0 lots: per-lot risk ₹{per_lot:,.0f} vs ₹{risk_rupees:,.0f} budget "
                           f"(premium ₹{premium_entry:.0f}, SL ₹{premium_stop:.0f}, lot {lot_size})")
        return lots, note

    # ---------------------------------------------------------------- checks #
    def can_enter(self, now_ts: float, minutes_to_close: int, has_open: bool, premium: float = 0.0) -> tuple[bool, str]:
        s, c = self.state, self.cfg
        if s.halted:
            return False, s.halt_reason or "halted"
        if has_open and c.max_open_positions <= 1:
            return False, "position already open"
        if s.trades_today >= c.max_trades_per_day:
            return False, f"max trades/day ({c.max_trades_per_day}) reached"
        loss_cap = -abs(s.day_start_equity * c.daily_loss_limit_pct / 100.0)
        if s.day_start_equity > 0 and s.realized_today <= loss_cap:
            s.halted = True
            s.halt_reason = f"daily loss limit hit ({s.realized_today:.0f} <= {loss_cap:.0f})"
            return False, s.halt_reason
        if c.daily_profit_target_pct > 0:
            target = s.day_start_equity * c.daily_profit_target_pct / 100.0
            if s.realized_today >= target:
                s.halted = True
                s.halt_reason = f"daily profit target hit (+{s.realized_today:.0f})"
                return False, s.halt_reason
        if s.consecutive_losses >= c.max_consecutive_losses:
            s.halted = True
            s.halt_reason = f"{s.consecutive_losses} consecutive losses"
            return False, s.halt_reason
        if s.last_loss_ts and c.cooldown_after_loss_min > 0:
            waited_min = (now_ts - s.last_loss_ts) / 60.0
            if waited_min < c.cooldown_after_loss_min:
                return False, f"cooldown {c.cooldown_after_loss_min - waited_min:.0f}m after loss"
        if minutes_to_close < c.min_minutes_to_close:
            return False, f"only {minutes_to_close}m to close"
        if premium and premium < c.min_premium:
            return False, f"premium {premium:.1f} < min {c.min_premium:.0f} (charges kha jayenge)"
        return True, "ok"

    # ------------------------------------------------------------- recording #
    def record_fill(self, pnl: float, now_ts: float, day_start_equity: Optional[float] = None) -> None:
        s = self.state
        if day_start_equity is not None:
            s.day_start_equity = day_start_equity
        s.realized_today += pnl
        s.trades_today += 1
        if pnl < 0:
            s.consecutive_losses += 1
            s.last_loss_ts = now_ts
        else:
            s.consecutive_losses = 0
        eq = s.equity()
        s.peak_equity = max(s.peak_equity, eq)
        s.max_drawdown = max(s.max_drawdown, s.peak_equity - eq)

    def summary(self) -> dict:
        s = self.state
        return {
            "capital": round(s.capital, 2),
            "equity": round(s.equity(), 2),
            "dayStartEquity": round(s.day_start_equity, 2),
            "realizedToday": round(s.realized_today, 2),
            "tradesToday": s.trades_today,
            "consecutiveLosses": s.consecutive_losses,
            "halted": s.halted,
            "haltReason": s.halt_reason,
            "maxDrawdown": round(s.max_drawdown, 2),
        }


def parse_hhmm(s: str) -> tuple[int, int]:
    h, m = s.split(":")
    return int(h), int(m)


def within_entry_window(minute_of_day: int, cfg: RiskConfig) -> bool:
    """9:20 se pehle aur 14:45 ke baad naya entry nahi."""
    bh, bm = parse_hhmm(cfg.no_entry_before)
    ah, am = parse_hhmm(cfg.no_entry_after)
    return (bh * 60 + bm) <= minute_of_day <= (ah * 60 + am)


def should_square_off(minute_of_day: int, cfg: RiskConfig) -> bool:
    h, m = parse_hhmm(cfg.square_off_at)
    return minute_of_day >= h * 60 + m


def kill_switch_active(path: str = "KILL") -> bool:
    """Ek file ho to poora bot band — emergency brake."""
    import os

    return os.path.exists(path)


if __name__ == "__main__":
    rm = RiskManager(RiskConfig(capital=200_000, risk_pct=1.0))
    print("lots (ATM premium ₹120, index SL 40 pts, delta 0.5):",
          rm.size_lots(premium=120, lot_size=75, index_stop_distance=40, delta=0.5))
    print("lots (premium ₹300, SL 30 pts, delta 0.6):",
          rm.size_lots(premium=300, lot_size=75, index_stop_distance=30, delta=0.6))
    print(rm.summary())
