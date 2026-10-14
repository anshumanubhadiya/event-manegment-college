"""backtest — engine, metrics, report."""

from .engine import Backtest, BacktestConfig, run_backtest
from .metrics import Metrics, compute as compute_metrics
from .report import console, markdown, write_all

__all__ = ["Backtest", "BacktestConfig", "run_backtest", "Metrics", "compute_metrics", "console", "markdown", "write_all"]
