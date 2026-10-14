"""
ema_cross.py — EMA crossover with trend filter (ADX) + ATR based SL/target.

Classic trend-following:
  * 9 EMA 5m 5m pe 21 EMA ko upar cross kare + ADX > adx_min + price > VWAP  -> LONG
  * ulta ho to SHORT
  * Stop = entry - atr_mult * ATR, target = target_rr x risk
  * Reverse cross ya VWAP loss pe exit
"""

from __future__ import annotations

from ..indicators import adx as adx_fn, atr as atr_fn, ema
from ..types import MarketState, Signal
from .base import Strategy


class EmaCross(Strategy):
    name = "ema_cross"
    description = "9/21 EMA cross + ADX trend filter + ATR stops"
    timeframes = ("5m",)
    default_params = {
        "fast": 9,
        "slow": 21,
        "adx_min": 18.0,        # filter: sirf trending market me
        "atr_period": 14,
        "atr_mult": 1.5,
        "min_sl_points": 15.0,
        "max_sl_points": 70.0,
        "target_rr": 2.0,
        "use_vwap_filter": True,
        "trend_ema": 50,        # higher-timeframe bias (optional, 0 = off)
        "max_trades": 3,
    }

    def warmup(self) -> int:
        return max(int(self.params["slow"]) + 5, int(self.params["trend_ema"]) + 2, 30)

    def reset_day(self) -> None:
        self.day = {"prev_fast": None, "prev_slow": None, "last_dir": 0}

    def on_state(self, s: MarketState) -> Signal:
        p = self.params
        tf = "5m"
        closes = s.closes(tf)
        highs, lows = s.highs(tf), s.lows(tf)
        if len(closes) < self.warmup():
            return self.hold("warmup")

        fast_s = ema(closes, int(p["fast"]))
        slow_s = ema(closes, int(p["slow"]))
        f, sl = fast_s[-1], slow_s[-1]
        pf, psl = fast_s[-2], slow_s[-2]
        if None in (f, sl, pf, psl):
            return self.hold("ema warmup")

        a = atr_fn(highs, lows, closes, int(p["atr_period"]))[-1] or (max(highs[-10:]) - min(lows[-10:])) / 10
        adx_v = adx_fn(highs, lows, closes, 14)[0][-1] or 0.0

        cross_up = pf <= psl and f > sl
        cross_dn = pf >= psl and f < sl
        trend_ok = adx_v >= float(p["adx_min"])
        vwap_ok_long = (not p["use_vwap_filter"]) or (s.vwap is not None and s.ltp > s.vwap)
        vwap_ok_short = (not p["use_vwap_filter"]) or (s.vwap is not None and s.ltp < s.vwap)

        bias = 0
        te = int(p["trend_ema"] or 0)
        if te:
            t = ema(closes, te)[-1]
            if t is not None:
                bias = 1 if closes[-1] > t else -1

        meta = {"ema_fast": round(f, 2), "ema_slow": round(sl, 2), "adx": round(adx_v, 1), "atr": round(a, 2), "bias": bias}

        if s.trades_today >= int(p["max_trades"]):
            return self.hold("max trades")

        min_sl, max_sl = float(p["min_sl_points"]), float(p["max_sl_points"])
        if cross_up and trend_ok and vwap_ok_long and bias >= 0:
            stop = min(s.ltp - float(p["atr_mult"]) * a, s.ltp - min_sl)
            stop = max(stop, s.ltp - max_sl)
            risk = s.ltp - stop
            self.day["last_dir"] = 1
            return self.buy(reason=f"EMA cross up ({f:.0f}>{sl:.0f}) ADX {adx_v:.0f}", stop=round(stop, 2),
                            target=round(s.ltp + float(p["target_rr"]) * risk, 2),
                            confidence=min(0.55 + adx_v / 100 + 0.1, 0.9), **meta)

        if cross_dn and trend_ok and vwap_ok_short and bias <= 0:
            stop = max(s.ltp + float(p["atr_mult"]) * a, s.ltp + min_sl)
            stop = min(stop, s.ltp + max_sl)
            risk = stop - s.ltp
            self.day["last_dir"] = -1
            return self.sell(reason=f"EMA cross down ({f:.0f}<{sl:.0f}) ADX {adx_v:.0f}", stop=round(stop, 2),
                             target=round(s.ltp - float(p["target_rr"]) * risk, 2),
                             confidence=min(0.55 + adx_v / 100 + 0.1, 0.9), **meta)

        # ---- open position management: trend toota to exit --------------- #
        if s.position and s.position.qty != 0:
            long_pos = s.position.qty > 0
            if long_pos and f < sl and adx_v < float(p["adx_min"]):
                return self.exit("trend weak (EMA cross down)", **meta)
            if (not long_pos) and f > sl and adx_v < float(p["adx_min"]):
                return self.exit("trend weak (EMA cross up)", **meta)
        return self.hold()
