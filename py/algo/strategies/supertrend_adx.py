"""
supertrend_adx.py — Supertrend flip + RSI confirmation + ADX filter.

  * Supertrend up ho jaye + RSI > rsi_bull -> CE
  * Supertrend down + RSI < rsi_bear -> PE
  * Supertrend flip against position -> exit
  * Stop = supertrend line (structure-based), target = RR x risk
"""

from __future__ import annotations

from ..indicators import adx as adx_fn, atr as atr_fn, rsi as rsi_fn, supertrend
from ..types import MarketState, Signal
from .base import Strategy


class SupertrendAdx(Strategy):
    name = "supertrend_adx"
    description = "Supertrend flip + RSI/ADX confirmation, structure (supertrend line) stop"
    timeframes = ("5m",)
    default_params = {
        "st_period": 10,
        "st_mult": 3.0,
        "rsi_period": 14,
        "rsi_bull": 54.0,
        "rsi_bear": 46.0,
        "adx_min": 15.0,
        "target_rr": 2.0,
        "atr_mult": 1.6,     # fallback SL jab supertrend line bahut door ho
        "min_sl_points": 15.0,   # itna tight SL = noise me cut + slippage me barbaad
        "max_sl_points": 60.0,
        "max_trades": 3,
    }

    def warmup(self) -> int:
        return max(int(self.params["st_period"]) * 3, 30)

    def reset_day(self) -> None:
        # trade count engine se (s.trades_today) — khud count nahi karte
        self.day = {}

    def on_state(self, s: MarketState) -> Signal:
        p = self.params
        tf = "5m"
        closes, highs, lows = s.closes(tf), s.highs(tf), s.lows(tf)
        if len(closes) < self.warmup():
            return self.hold("warmup")

        line, up = supertrend(highs, lows, closes, int(p["st_period"]), float(p["st_mult"]))
        st_line, st_up = line[-1], up[-1]
        st_up_prev = up[-2] if len(up) > 1 else st_up
        if st_line is None:
            return self.hold("supertrend warmup")

        r = rsi_fn(closes, int(p["rsi_period"]))[-1] or 50.0
        a = atr_fn(highs, lows, closes, 14)[-1] or 10.0
        adx_v = adx_fn(highs, lows, closes, 14)[0][-1] or 0.0
        meta = {"supertrend": round(st_line, 2), "st_up": st_up, "rsi": round(r, 1), "adx": round(adx_v, 1), "atr": round(a, 2)}

        # ---------------- position management: flip pe exit ---------------- #
        if s.position and s.position.qty != 0:
            long_pos = s.position.qty > 0
            flipped = (st_up != st_up_prev)
            if long_pos and (not st_up) and flipped:
                return self.exit("Supertrend flip down", **meta)
            if (not long_pos) and st_up and flipped:
                return self.exit("Supertrend flip up", **meta)

        if s.trades_today >= int(p["max_trades"]):
            return self.hold("max trades")
        if adx_v < float(p["adx_min"]):
            return self.hold(f"ADX {adx_v:.0f} < {p['adx_min']}")
        flipped = st_up != st_up_prev

        max_sl = float(p["max_sl_points"])
        min_sl = float(p["min_sl_points"])
        if st_up and flipped and r > float(p["rsi_bull"]):
            stop = min(st_line, s.ltp - float(p["atr_mult"]) * a * 0.5)
            stop = min(stop, s.ltp - min_sl)     # itna tight nahi
            stop = max(stop, s.ltp - max_sl)     # itna bada nahi
            risk = s.ltp - stop
            return self.buy(reason=f"Supertrend up flip, RSI {r:.0f}, ADX {adx_v:.0f}", stop=round(stop, 2),
                            target=round(s.ltp + float(p["target_rr"]) * risk, 2),
                            confidence=min(0.5 + (r - 50) / 100, 0.85), **meta)

        if (not st_up) and flipped and r < float(p["rsi_bear"]):
            stop = max(st_line, s.ltp + float(p["atr_mult"]) * a * 0.5)
            stop = max(stop, s.ltp + min_sl)     # itna tight nahi
            stop = min(stop, s.ltp + max_sl)     # itna bada nahi
            risk = stop - s.ltp
            return self.sell(reason=f"Supertrend down flip, RSI {r:.0f}, ADX {adx_v:.0f}", stop=round(stop, 2),
                             target=round(s.ltp - float(p["target_rr"]) * risk, 2),
                             confidence=min(0.5 + (50 - r) / 100, 0.85), **meta)

        return self.hold()
