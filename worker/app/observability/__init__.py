"""Operational observability.

Three independent surfaces:

  * Sentry - unhandled exception capture in the FastAPI app, the job
    worker, and the cron entry points. Configured via SENTRY_DSN.
  * Prometheus - counters / histograms / gauges describing every
    operationally-interesting event. Exposed on /metrics for the
    Prometheus scraper.
  * structlog - JSON structured logs with consistent field naming so
    Loki / Grafana queries are stable.

All three are no-ops when their respective configuration is absent, so
local dev and CI environments don't require any monitoring stack.
"""

from .logging_config import configure_logging
from .metrics import (
    ANCHOR_COUNTER,
    ANOMALY_COUNTER,
    AUDIT_LOG_SEQ_GAUGE,
    AUTH_OTP_COUNTER,
    EXTRACTION_CONFIDENCE_HISTOGRAM,
    EXTRACTION_FAILURE_COUNTER,
    EXTRACTION_HISTOGRAM,
    INFLIGHT_GAUGE,
    INGESTION_COUNTER,
    INGESTION_REJECTED_COUNTER,
    QUEUE_DEPTH_GAUGE,
    metrics_response,
    observe_extraction,
)
from .sentry import capture_exception, init_sentry

__all__ = [
    "ANCHOR_COUNTER",
    "ANOMALY_COUNTER",
    "AUDIT_LOG_SEQ_GAUGE",
    "AUTH_OTP_COUNTER",
    "EXTRACTION_CONFIDENCE_HISTOGRAM",
    "EXTRACTION_FAILURE_COUNTER",
    "EXTRACTION_HISTOGRAM",
    "INFLIGHT_GAUGE",
    "INGESTION_COUNTER",
    "INGESTION_REJECTED_COUNTER",
    "QUEUE_DEPTH_GAUGE",
    "capture_exception",
    "configure_logging",
    "init_sentry",
    "metrics_response",
    "observe_extraction",
]
