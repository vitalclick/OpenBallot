"""Statistical anomaly detection.

Three independent layers:

  sanity      - deterministic per-PU impossibility checks. Always runs
                inline on every submission immediately after extraction.
                Examples: votes > registered, turnout > accreditation.

  statistical - per-PU z-score against ward / LGA peer distribution.
                Runs as a batch job after the worker has accumulated
                enough peer data to make the population statistics
                meaningful (the mat views require n>=5 ward, n>=10 LGA).

  historical  - per-PU comparison against 2023 same-PU baseline (turnout
                shift, leader-party shift). Runs after 2023 data has
                been loaded via the IReV scraper.

Each layer emits zero or more AnomalyHit objects which the engine
inserts into the `anomalies` table. The detection rules are pure
functions; the engine wires them to the DB.
"""

from .types import AnomalyHit, AnomalyType, Severity
from .sanity import run_sanity_checks
from .statistical import run_statistical_checks
from .historical import run_historical_checks
from .engine import AnomalyEngine

__all__ = [
    "AnomalyHit",
    "AnomalyType",
    "Severity",
    "run_sanity_checks",
    "run_statistical_checks",
    "run_historical_checks",
    "AnomalyEngine",
]
