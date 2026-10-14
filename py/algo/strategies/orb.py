"""
orb.py — Opening Range Breakout (index options ka sabse popular intraday setup).

Logic:
  1. 09:15 - 09:30 (configurable) ka high/low = opening range.
  2. Us range ke bahar close/break + buffer -> entry usi direction me.
  3. Stop = range ka doosra side (ya ATR-based, jo bhi tight ho), target = RR x risk.
  4. Ek din me max `max_trades` entries; 15:00 ke baad naya entry nahi.

Options me: bullish breakout -> CE kharido, bearish -> PE.
Engine yahi signal lega aur option leg banayega.
"""

from __future__ import annotations

from ..types import MarketState, Signal
from .base import Strategy


class ORB(Strategy):
    name = "orb"
    description = "Opening Range Breakout (09:15-09:30 range) — index CE/PE"
    timeframes = ("1m", "5m")
    default_params = {
        "or_minutes": 15,          # opening range length
        "buffer_points": 3.0,      # breakout ke liye range se itne points bahar
        "sl_mode": "atr",          # range | atr  (atr = tighter, better RR)
        "atr_mult": 1.0,           # sl_mode=atr ke liye
        "min_sl_points": 15.0,     # SL itna tight nahi hona chahiye
        "max_sl_points": 60.0,     # ...aur itna bada bhi nahi
        "target_rr": 1.6,          # risk : reward
        "max_trades": 2,           # ek din me kitne ORB trades
        "entry_cutoff": "13:30",   # iske baad naya entry nahi
        "retest_required": False,  # True = breakout ke baad pullback ka wait
        "one_side_only": False,    # True = sirf pehli direction me trade
    }

    def warmup(self) -> int:
        return 5  # OR khud 5m bars se banega

    def reset_day(self) -> None:
        self.day = {"or_high": None, "or_low": None, "done": False, "first_side": None, "broke": None}

    def on_state(self, s: MarketState) -> Signal:
        bars5 = s.series("5m")
        bars1 = s.series("1m")
        or_min = int(self.params["or_minutes"])
        buf = float(self.params["buffer_points"])
        cutoff = self.params["entry_cutoff"]

        # ---- 1. opening range banao ------------------------------------- #
        if self.day["or_high"] is None:
            or_end = 9 * 60 + 15 + or_min  # 09:30
            # pehle poora opening window nikalna zaroori hai — warna adhoori range se
            # jaldi breakout signal aa jata hai (aur whipsaw me SL lagta hai)
            if self.minutes_of_day(s.ts) < or_end:
                return self.hold(f"opening range ban rahi hai ({or_end - self.minutes_of_day(s.ts)}m baaki)")
            rng = [b for b in bars1 if 9 * 60 + 15 <= self.minutes_of_day(b.ts) < or_end]
            if len(rng) < max(3, or_min // 2):
                return self.hold("opening range ke bars nahi mile")
            self.day["or_high"] = max(b.high for b in rng)
            self.day["or_low"] = min(b.low for b in rng)
            self.day["or_size"] = self.day["or_high"] - self.day["or_low"]
            return self.hold(f"OR set {self.day['or_low']:.0f}-{self.day['or_high']:.0f}")

        # ---- 2. guards -------------------------------------------------- #
        if self.day["done"]:
            return self.hold("ORB done for today")
        if s.trades_today >= int(self.params["max_trades"]):
            return self.hold("max ORB trades reached")
        hh, mm = (int(x) for x in str(cutoff).split(":"))
        if self.minutes_of_day(s.ts) > hh * 60 + mm:
            return self.hold("past entry cutoff")

        orh, orl = self.day["or_high"], self.day["or_low"]

        # ---- 3. breakout + retest --------------------------------------- #
        long_trig = orh + buf
        short_trig = orl - buf
        up = s.ltp >= long_trig
        down = s.ltp <= short_trig

        if self.params["retest_required"]:
            if self.day["broke"] is None:
                if up:
                    self.day["broke"] = "up"
                elif down:
                    self.day["broke"] = "down"
                else:
                    return self.hold("breakout ka wait")
                return self.hold(f"{self.day['broke']} breakout hua, retest ka wait")
            if self.day["broke"] == "up":
                up = s.ltp <= orh + buf and s.ltp >= orh - buf   # pullback to breakout level
                down = False
            else:
                down = s.ltp >= orl - buf and s.ltp <= orl + buf
                up = False

        if not (up or down):
            return self.hold()

        # ---- 4. risk levels --------------------------------------------- #
        atr = s.atr or ((orh - orl) * 0.35)
        min_sl = float(self.params["min_sl_points"])
        max_sl = float(self.params["max_sl_points"])
        if up:
            entry = s.ltp
            stop = orl if self.params["sl_mode"] == "range" else entry - float(self.params["atr_mult"]) * atr
            stop = min(stop, entry - min_sl)   # itna tight nahi
            stop = max(stop, entry - max_sl)   # itna bada nahi
            risk = entry - stop
            target = entry + float(self.params["target_rr"]) * risk
            self.day["first_side"] = self.day["first_side"] or "up"
            self.day["done"] = self.params["one_side_only"] or (s.trades_today + 1) >= int(self.params["max_trades"])
            conf = 0.6 + (0.15 if s.ltp > orh + 2 * buf else 0.0)
            return self.buy(
                reason=f"ORB long: {s.ltp:.0f} > ORH {orh:.0f} + {buf:.0f}",
                stop=round(stop, 2), target=round(target, 2), confidence=min(conf, 0.9),
                or_high=round(orh, 2), or_low=round(orl, 2), risk_points=round(risk, 2),
            )

        entry = s.ltp
        stop = orh if self.params["sl_mode"] == "range" else entry + float(self.params["atr_mult"]) * atr
        stop = max(stop, entry + min_sl)
        stop = min(stop, entry + max_sl)
        risk = stop - entry
        target = entry - float(self.params["target_rr"]) * risk
        self.day["first_side"] = self.day["first_side"] or "down"
        self.day["done"] = self.params["one_side_only"] or (s.trades_today + 1) >= int(self.params["max_trades"])
        conf = 0.6 + (0.15 if s.ltp < orl - 2 * buf else 0.0)
        return self.sell(
            reason=f"ORB short: {s.ltp:.0f} < ORL {orl:.0f} - {buf:.0f}",
            stop=round(stop, 2), target=round(target, 2), confidence=min(conf, 0.9),
            or_high=round(orh, 2), or_low=round(orl, 2), risk_points=round(risk, 2),
        )
