"""
vwap_reversion.py — VWAP se door jaane pe fade karo (range/mean-revert days ke liye).

Logic:
  * ADX < adx_max (trend nahi hai) -> range regime maano.
  * Price VWAP se k * (rolling stdev) door chala jaye -> opposite side entry.
  * Target = VWAP. Stop = entry se atr_mult * ATR door (structure fail hone pe).
  * Pehle 15 min aur aakhri 30 min skip.

Ye trend days pe nuksan deta hai — isliye ADX/regime filter zaroori hai.
"""

from __future__ import annotations

from ..indicators import adx as adx_fn, atr as atr_fn, vwap_bands
from ..types import MarketState, Signal
from .base import Strategy


class VwapReversion(Strategy):
    name = "vwap_reversion"
    description = "VWAP mean reversion — range days me fade, target VWAP"
    timeframes = ("1m", "5m")
    default_params = {
        "k_sigma": 2.0,         # VWAP se kitne sigma door
        "stall_bars": 1,        # entry se pehle price ko stall hona chahiye (falling knife nahi pakadte)
        "sigma_period": 30,     # sigma window (bars)
        "adx_max": 22.0,        # isse zyada ADX pe trade nahi (trend chal raha hai)
        "stop_sigma": 1.0,      # stop = entry se itne sigma aage (band ke bahar)
        "min_target_points": 10.0,
        "max_trades": 3,
        "skip_first_minutes": 20,
        "skip_last_minutes": 30,
        "tf": "5m",
    }

    def warmup(self) -> int:
        return 35

    def reset_day(self) -> None:
        # trade count engine ke risk manager se aata hai (s.trades_today) — khud count nahi karte,
        # warna reject hue signals bhi ginti me aa jaate hain.
        self.day = {"last_side": 0}

    def on_state(self, s: MarketState) -> Signal:
        p = self.params
        tf = str(p["tf"])
        closes = s.closes(tf)
        highs, lows = s.highs(tf), s.lows(tf)
        if len(closes) < self.warmup() or s.vwap is None:
            return self.hold("warmup/no vwap")

        mod = self.minutes_of_day(s.ts)
        if mod < 9 * 60 + 15 + int(p["skip_first_minutes"]):
            return self.hold("open ke 20 min skip")
        if s.minutes_to_close <= int(p["skip_last_minutes"]):
            return self.hold("close ke paas entry nahi")

        a = atr_fn(highs, lows, closes, 14)[-1] or 10.0
        adx_v = adx_fn(highs, lows, closes, 14)[0][-1] or 0.0
        # VWAP bands: session bars ke around volume-weighted sigma (price levels ka stdev nahi!)
        bars_tf = s.bars.get(tf) or []
        _, sd, upper, lower = vwap_bands(bars_tf, s.vwap)
        if sd <= 0:
            sd = max(a, 1.0)
        dev = (s.ltp - s.vwap) / sd
        dist_pts = abs(s.ltp - s.vwap)

        meta = {"deviation_sigma": round(dev, 2), "adx": round(adx_v, 1), "vwap": round(s.vwap, 2),
                "sigma": round(sd, 2), "bandUpper": round(upper, 2), "bandLower": round(lower, 2)}

        # position management: VWAP touch -> exit (target mil gaya)
        if s.position and s.position.qty != 0:
            long_pos = s.position.qty > 0
            if long_pos and s.ltp >= s.vwap:
                return self.exit("VWAP touch — mean reversion done", **meta)
            if (not long_pos) and s.ltp <= s.vwap:
                return self.exit("VWAP touch — mean reversion done", **meta)

        if adx_v > float(p["adx_max"]):
            return self.hold(f"trend regime (ADX {adx_v:.0f}) — fade nahi")
        if s.trades_today >= int(p["max_trades"]):
            return self.hold("max trades")
        if dist_pts < float(p["min_target_points"]):
            return self.hold("VWAP ke bahut paas")

        k = float(p["k_sigma"])
        # "stall" confirmation: fade tabhi jab extreme pe price rukne lage
        # (warna girta knife pakad ke lagatar chhote stops khaate hain)
        stall = int(p["stall_bars"])
        if stall > 0:
            if len(closes) < stall + 1:
                return self.hold("stall data nahi")
            reversing_up = closes[-1] > closes[-1 - stall]
            reversing_dn = closes[-1] < closes[-1 - stall]
        else:
            reversing_up = reversing_dn = True

        if dev <= -k and reversing_up:  # VWAP se neeche bahut door -> long fade, target VWAP
            stop = s.ltp - float(p["stop_sigma"]) * sd
            conf = min(0.5 + (abs(dev) - k) * 0.15, 0.85)
            return self.buy(reason=f"VWAP fade long: {dev:.1f}σ below VWAP, ADX {adx_v:.0f}",
                            stop=round(stop, 2), target=round(s.vwap, 2), confidence=conf, **meta)

        if dev >= k and reversing_dn:  # upar bahut door -> short fade
            stop = s.ltp + float(p["stop_sigma"]) * sd
            conf = min(0.5 + (abs(dev) - k) * 0.15, 0.85)
            return self.sell(reason=f"VWAP fade short: {dev:.1f}σ above VWAP, ADX {adx_v:.0f}",
                             stop=round(stop, 2), target=round(s.vwap, 2), confidence=conf, **meta)

        if abs(dev) >= k:
            return self.hold(f"{dev:.1f}σ pe hai par stall/confirmation nahi")
        return self.hold(f"deviation {dev:.2f}σ — trigger {k:.1f}σ")
