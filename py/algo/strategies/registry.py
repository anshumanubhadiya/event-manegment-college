"""
registry.py — strategy lookup + factory.

Apni strategy add karni ho:
  1. `py/algo/strategies/my_strategy.py` banao (Strategy subclass).
  2. Neeche REGISTRY dict me add kar do.
  3. Backtest chalao:  python py/run.py backtest --strategy my_strategy
Live engine automatically service se ye strategy maangta hai (STRATEGY=my_strategy).
"""

from __future__ import annotations

from typing import Any, Type

from .base import Strategy
from .ema_cross import EmaCross
from .orb import ORB
from .supertrend_adx import SupertrendAdx
from .vwap_reversion import VwapReversion

REGISTRY: dict[str, Type[Strategy]] = {
    ORB.name: ORB,
    EmaCross.name: EmaCross,
    VwapReversion.name: VwapReversion,
    SupertrendAdx.name: SupertrendAdx,
}


def create(name: str, **params: Any) -> Strategy:
    key = (name or "orb").strip().lower()
    if key not in REGISTRY:
        raise KeyError(f"strategy '{name}' nahi mili. Available: {', '.join(REGISTRY)}")
    return REGISTRY[key](**params)


def names() -> list[str]:
    return sorted(REGISTRY)


def describe_all() -> list[dict]:
    return [cls().describe() for cls in REGISTRY.values()]


def timeframes_for(name: str) -> tuple[str, ...]:
    cls = REGISTRY.get((name or "").strip().lower())
    return cls.timeframes if cls else ("5m",)
