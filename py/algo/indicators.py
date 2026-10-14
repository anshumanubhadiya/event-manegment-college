"""
Indicators — pure python, no numpy. Sab functions list[float] -> list[float] hain
aur NaN-free warmup ke liye None bhar dete hain (ya pehli valid value se shuru).

Agar aap pandas/numpy use karna chahte ho to bhi theek — ye bas default, zero-dep
implementation hai jo live engine ke TS version se exactly match karta hai.
"""

from __future__ import annotations

import math
from typing import Optional, Sequence

Num = Optional[float]


def sma(values: Sequence[float], period: int) -> list[Num]:
    out: list[Num] = [None] * len(values)
    if period <= 0:
        return out
    run = 0.0
    for i, v in enumerate(values):
        run += v
        if i >= period:
            run -= values[i - period]
        if i >= period - 1:
            out[i] = run / period
    return out


def ema(values: Sequence[float], period: int) -> list[Num]:
    """Standard EMA, seeded with SMA of first `period` values (same as TA libs)."""
    out: list[Num] = [None] * len(values)
    if period <= 0 or len(values) < period:
        return out
    k = 2.0 / (period + 1)
    seed = sum(values[:period]) / period
    out[period - 1] = seed
    prev = seed
    for i in range(period, len(values)):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def rma(values: Sequence[float], period: int) -> list[Num]:
    """Wilder's smoothing (used by ATR / ADX / RSI)."""
    out: list[Num] = [None] * len(values)
    if period <= 0 or len(values) < period:
        return out
    seed = sum(values[:period]) / period
    out[period - 1] = seed
    prev = seed
    for i in range(period, len(values)):
        prev = (prev * (period - 1) + values[i]) / period
        out[i] = prev
    return out


def rsi(closes: Sequence[float], period: int = 14) -> list[Num]:
    out: list[Num] = [None] * len(closes)
    if len(closes) < period + 1:
        return out
    gains, losses = [], []
    for i in range(1, len(closes)):
        ch = closes[i] - closes[i - 1]
        gains.append(max(ch, 0.0))
        losses.append(max(-ch, 0.0))
    ag = rma(gains, period)
    al = rma(losses, period)
    for i in range(len(closes)):
        gi = i - 1
        if gi < 0 or ag[gi] is None or al[gi] is None:
            continue
        if al[gi] == 0:
            out[i] = 100.0
        else:
            rs = ag[gi] / al[gi]
            out[i] = 100 - (100 / (1 + rs))
    return out


def true_range(highs: Sequence[float], lows: Sequence[float], closes: Sequence[float]) -> list[float]:
    tr = [0.0] * len(highs)
    for i in range(len(highs)):
        if i == 0:
            tr[i] = highs[i] - lows[i]
        else:
            tr[i] = max(
                highs[i] - lows[i],
                abs(highs[i] - closes[i - 1]),
                abs(lows[i] - closes[i - 1]),
            )
    return tr


def atr(highs: Sequence[float], lows: Sequence[float], closes: Sequence[float], period: int = 14) -> list[Num]:
    return rma(true_range(highs, lows, closes), period)


def adx(
    highs: Sequence[float], lows: Sequence[float], closes: Sequence[float], period: int = 14
) -> tuple[list[Num], list[Num], list[Num]]:
    """Returns (adx, plus_di, minus_di)."""
    n = len(closes)
    plus_dm = [0.0] * n
    minus_dm = [0.0] * n
    for i in range(1, n):
        up = highs[i] - highs[i - 1]
        dn = lows[i - 1] - lows[i]
        plus_dm[i] = up if (up > dn and up > 0) else 0.0
        minus_dm[i] = dn if (dn > up and dn > 0) else 0.0
    tr = rma(true_range(highs, lows, closes), period)
    pdm = rma(plus_dm, period)
    mdm = rma(minus_dm, period)
    pdi: list[Num] = [None] * n
    mdi: list[Num] = [None] * n
    dx: list[float] = [0.0] * n
    for i in range(n):
        if tr[i] in (None, 0) or pdm[i] is None or mdm[i] is None:
            continue
        pdi[i] = 100 * pdm[i] / tr[i]
        mdi[i] = 100 * mdm[i] / tr[i]
        denom = (pdi[i] or 0) + (mdi[i] or 0)
        dx[i] = 0.0 if denom == 0 else 100 * abs((pdi[i] or 0) - (mdi[i] or 0)) / denom
    adx_out = rma(dx[period:], period)
    # realign (rma trimmed the first `period` slots)
    padded: list[Num] = [None] * n
    for i, v in enumerate(adx_out):
        padded[i + period] = v
    return padded, pdi, mdi


def vwap_intraday(
    highs: Sequence[float],
    lows: Sequence[float],
    closes: Sequence[float],
    volumes: Sequence[float],
    session_start_idx: int = 0,
) -> list[Num]:
    """
    Session VWAP with volume weighting. `session_start_idx` se reset hota hai
    (naya din shuru hone par isko naya index dena hai).
    """
    out: list[Num] = [None] * len(closes)
    pv = 0.0
    vv = 0.0
    for i in range(session_start_idx, len(closes)):
        tp = (highs[i] + lows[i] + closes[i]) / 3.0
        vol = max(volumes[i], 1.0)
        pv += tp * vol
        vv += vol
        out[i] = pv / vv if vv else None
    return out


def stdev(values: Sequence[float], period: int) -> list[Num]:
    """Rolling population stdev (VWAP bands ke liye)."""
    out: list[Num] = [None] * len(values)
    for i in range(period - 1, len(values)):
        window = values[i - period + 1 : i + 1]
        mean = sum(window) / period
        var = sum((x - mean) ** 2 for x in window) / period
        out[i] = math.sqrt(var)
    return out


def _field(b, name: str) -> float:
    """Bar (object ya dict) se field nikalo."""
    if isinstance(b, dict):
        return float(b[name])
    return float(getattr(b, name))


def vwap_bands(bars: Sequence, vwap: Optional[float] = None) -> tuple[Optional[float], float, float, float]:
    """
    VWAP bands — VWAP ke around volume-weighted dispersion.

    Returns (vwap, sigma, upper, lower). Sigma "price levels ke stdev" se alag hai:
    trend day pe band khud fail jaata hai (fade signal kam), range day pe tight
    (mean reversion ke liye ready). Isliye VWAP fade ke liye yahi sahi measure hai.
    """
    if not bars:
        return None, 0.0, 0.0, 0.0
    tps = [(_field(b, "high") + _field(b, "low") + _field(b, "close")) / 3.0 for b in bars]
    vols = [max(_field(b, "volume"), 1.0) for b in bars]
    tot_v = sum(vols)
    if vwap is None:
        vwap = sum(tp * v for tp, v in zip(tps, vols)) / tot_v
    var = sum(v * (tp - vwap) ** 2 for tp, v in zip(tps, vols)) / tot_v
    sd = math.sqrt(var)
    return vwap, sd, vwap + sd, vwap - sd


def supertrend(
    highs: Sequence[float],
    lows: Sequence[float],
    closes: Sequence[float],
    period: int = 10,
    multiplier: float = 3.0,
) -> tuple[list[Num], list[bool]]:
    """
    Supertrend. Returns (line, uptrend_bool).
    Uptrend True = price line ke upar (long bias).
    """
    n = len(closes)
    atr_vals = atr(highs, lows, closes, period)
    line: list[Num] = [None] * n
    up: list[bool] = [False] * n
    final_upper: list[float] = [0.0] * n
    final_lower: list[float] = [0.0] * n
    prev_up = True
    for i in range(n):
        a = atr_vals[i]
        if a is None:
            continue
        mid = (highs[i] + lows[i]) / 2.0
        upper = mid + multiplier * a
        lower = mid - multiplier * a
        if i == 0 or line[i - 1] is None:
            final_upper[i], final_lower[i] = upper, lower
            prev_up = closes[i] >= mid
        else:
            final_upper[i] = min(upper, final_upper[i - 1]) if closes[i - 1] <= final_upper[i - 1] else upper
            final_lower[i] = max(lower, final_lower[i - 1]) if closes[i - 1] >= final_lower[i - 1] else lower
            if prev_up:
                prev_up = closes[i] >= final_lower[i]
            else:
                prev_up = closes[i] > final_upper[i]
        up[i] = prev_up
        line[i] = final_lower[i] if prev_up else final_upper[i]
    return line, up


def opening_range(bars: Sequence, until_ts: int) -> tuple[Optional[float], Optional[float]]:
    """Opening range high/low — sirf `until_ts` se pehle wale bars se."""
    hi, lo = None, None
    for b in bars:
        if b.ts > until_ts:
            break
        hi = b.high if hi is None else max(hi, b.high)
        lo = b.low if lo is None else min(lo, b.low)
    return hi, lo


def rolling_high(values: Sequence[float], period: int) -> list[Num]:
    out: list[Num] = [None] * len(values)
    for i in range(period - 1, len(values)):
        out[i] = max(values[i - period + 1 : i + 1])
    return out


def rolling_low(values: Sequence[float], period: int) -> list[Num]:
    out: list[Num] = [None] * len(values)
    for i in range(period - 1, len(values)):
        out[i] = min(values[i - period + 1 : i + 1])
    return out


def pct_change(a: float, b: float) -> float:
    """(a-b)/b in percent; b==0 par 0."""
    if not b:
        return 0.0
    return (a - b) / b * 100.0
