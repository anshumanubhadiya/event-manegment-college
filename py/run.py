#!/usr/bin/env python3
"""
run.py — py side ka entry point.

    python py/run.py list
    python py/run.py backtest --strategy orb --days 60
    python py/run.py compare --days 90
    python py/run.py serve --port 8787
    python py/run.py gen-data --days 90
    python py/run.py demo
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from algo.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
