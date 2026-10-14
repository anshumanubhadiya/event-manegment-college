"""
base.py — Strategy base class.

Aapko bas `on_state()` implement karna hai: MarketState lo, Signal do.

    class MyStrategy(Strategy):
        name = "my_edge"
        default_params = {"threshold": 1.5}
        timeframes = ("5m",)

        def on_state(self, s: MarketState) -> Signal:
            if <condition>:
                return self.buy(reason="breakout", stop=s.ltp - 30, target=s.ltp + 60, confidence=0.7)
            return self.hold()

Rules:
  * `on_state` ko har naye bar pe call kiya jata hai (backtest), live me har tick/interval pe.
  * Position open hone pe bhi call hota hai — aap exit signal de sakte ho (`self.exit(...)`).
  * Day reset automatically hota hai (naya session detect karke `reset_day()` call).
  * Order placement / sizing engine karta hai — aap sirf intent + levels do.
"""

from __future__ import annotations

from typing import Any, Optional, Sequence

from ..types import MarketState, Signal


class Strategy:
    name: str = "base"
    description: str = ""
    default_params: dict[str, Any] = {}
    timeframes: tuple[str, ...] = ("5m",)

    def __init__(self, **params: Any):
        self.params: dict[str, Any] = {**self.default_params, **params}
        self._session: Optional[str] = None
        self.day: dict[str, Any] = {}
        self.state_meta: dict[str, Any] = {}

    # ------------------------------------------------------------------ API #
    def warmup(self) -> int:
        """Kitne bars chahiye signal ke liye (engine isse pehle signal nahi maangta)."""
        return 30

    def on_state(self, state: MarketState) -> Signal:  # pragma: no cover - abstract
        raise NotImplementedError

    def run(self, state: MarketState) -> Signal:
        """Engine isko call karta hai — day rollover + warmup handle karta hai."""
        session = str(state.meta.get("session") or "")
        if session and session != self._session:
            self._session = session
            self.reset_day()
        if len(state.series(self.timeframes[0])) < self.warmup():
            return self.hold("warmup")
        return self.on_state(state)

    def reset_day(self) -> None:
        """Naya session — intraday state clear (position engine ke paas hoti hai, idhar nahi)."""
        self.day = {}

    # -------------------------------------------------------------- helpers #
    def hold(self, reason: str = "") -> Signal:
        return Signal(action="hold", reason=reason, confidence=0.0, tag=self.name)

    def buy(self, reason: str, stop: Optional[float] = None, target: Optional[float] = None,
            confidence: float = 0.5, lots: Optional[int] = None, **meta: Any) -> Signal:
        return Signal(action="buy", reason=reason, stop=stop, target=target,
                      confidence=confidence, lots=lots, tag=self.name, meta=meta)

    def sell(self, reason: str, stop: Optional[float] = None, target: Optional[float] = None,
             confidence: float = 0.5, lots: Optional[int] = None, **meta: Any) -> Signal:
        return Signal(action="sell", reason=reason, stop=stop, target=target,
                      confidence=confidence, lots=lots, tag=self.name, meta=meta)

    def exit(self, reason: str, confidence: float = 0.8, **meta: Any) -> Signal:
        return Signal(action="exit", reason=reason, confidence=confidence, tag=self.name, meta=meta)

    # ------------------------------------------------------------ utilities #
    @staticmethod
    def minutes_of_day(ts_ms: int) -> int:
        from ..data.resample import minute_of_day

        return minute_of_day(ts_ms)

    @staticmethod
    def tf_minutes(tf: str) -> int:
        from ..data.resample import tf_minutes

        return tf_minutes(tf)

    def schema(self) -> dict:
        """Dashboard / API ke liye params description."""
        out = {}
        for k, v in self.default_params.items():
            out[k] = {"type": type(v).__name__, "default": v}
        return out

    def describe(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "timeframes": list(self.timeframes),
            "warmup": self.warmup(),
            "params": {**self.schema(), **{k: {"type": type(v).__name__, "default": self.default_params.get(k), "current": v} for k, v in self.params.items()}},
        }
