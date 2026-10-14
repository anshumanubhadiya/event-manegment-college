"""
algo — Indian market algo trading toolkit (strategies + backtest engine).

Ye package Python side handle karta hai:
  * indicators            — EMA / RSI / ATR / VWAP / ADX / Supertrend / ORB
  * charges               — Indian broker charges (Zerodha / Angel / Fyers / Upstox / Dhan)
  * options               — Black-Scholes greeks, strike selection, synthetic option chain
  * instruments           — index lot sizes, strike steps, weekly expiry rules
  * strategies            — strategy implementations aap likh sakte ho
  * backtest              — historical replay engine + metrics + report
  * service               — HTTP service jo live TS engine signals deta hai (zero deps, stdlib)

Zero third-party dependencies: sab standard library pe chalta hai.
"""

__version__ = "0.1.0"

from .types import Bar, MarketState, Position, Signal, Trade, Order  # noqa: F401

__all__ = ["Bar", "MarketState", "Position", "Signal", "Trade", "Order", "__version__"]
