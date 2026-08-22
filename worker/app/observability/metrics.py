"""Prometheus metrics.

The full set of operational dimensions we expose on /metrics:

  Counters
    openballot_ingestion_total{source_type}              accepted submissions
    openballot_ingestion_rejected_total{reason}          rejected at /v1/ingest
    openballot_extraction_failures_total{backend}        OCR call failed
    openballot_auth_otp_total{outcome}                   sent/verified/failed
    openballot_anchor_total{outcome}                     anchor submit / success / failure
    openballot_anomaly_total{type, severity}             per anomaly type detected

  Histograms
    openballot_extraction_duration_seconds{backend}      OCR call latency
    openballot_extraction_confidence{backend}            confidence distribution

  Gauges
    openballot_queue_depth                               LLEN of the ingestion queue
    openballot_inflight_jobs                             count of claimed-but-not-acked jobs
    openballot_audit_log_seq                             latest audit_log seq

Configured once at process startup; metric objects are module-level so
any code path can record without dependency injection.
"""

from __future__ import annotations

from contextlib import contextmanager
from time import perf_counter

from fastapi.responses import Response
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)

# ─── Counters ───────────────────────────────────────────────────────────────


INGESTION_COUNTER = Counter(
    "openballot_ingestion_total",
    "Accepted submissions reaching /v1/ingest",
    labelnames=("source_type",),
)

INGESTION_REJECTED_COUNTER = Counter(
    "openballot_ingestion_rejected_total",
    "Submissions rejected at /v1/ingest before queueing",
    labelnames=("reason",),
)

EXTRACTION_FAILURE_COUNTER = Counter(
    "openballot_extraction_failures_total",
    "Extraction attempts that raised an exception",
    labelnames=("backend",),
)

AUTH_OTP_COUNTER = Counter(
    "openballot_auth_otp_total",
    "OTP request + verification outcomes",
    labelnames=("outcome",),    # requested | verified | failed | throttled
)

ANCHOR_COUNTER = Counter(
    "openballot_anchor_total",
    "Audit log Ethereum anchor outcomes",
    labelnames=("outcome",),    # submitted | confirmed | failed | gas_too_high
)

ANOMALY_COUNTER = Counter(
    "openballot_anomaly_total",
    "Anomalies detected, by type and severity",
    labelnames=("type", "severity"),
)


# ─── Histograms ─────────────────────────────────────────────────────────────


EXTRACTION_HISTOGRAM = Histogram(
    "openballot_extraction_duration_seconds",
    "Wall-clock time spent in the extractor",
    labelnames=("backend",),
    buckets=(0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0),
)

EXTRACTION_CONFIDENCE_HISTOGRAM = Histogram(
    "openballot_extraction_confidence",
    "Aggregate per-submission confidence scores",
    labelnames=("backend",),
    buckets=(0.0, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99, 1.0),
)


# ─── Gauges ─────────────────────────────────────────────────────────────────


QUEUE_DEPTH_GAUGE = Gauge(
    "openballot_queue_depth",
    "Number of jobs waiting in the ingestion queue",
)

INFLIGHT_GAUGE = Gauge(
    "openballot_inflight_jobs",
    "Number of jobs claimed by a worker but not yet acked",
)

AUDIT_LOG_SEQ_GAUGE = Gauge(
    "openballot_audit_log_seq",
    "Latest audit_log seq number (monotonic)",
)


# ─── Helpers ────────────────────────────────────────────────────────────────


@contextmanager
def observe_extraction(backend: str):
    """Context manager that records extraction latency + failure count.

    Use:
        with observe_extraction("document_ai"):
            result = await extractor.extract(...)
    """
    start = perf_counter()
    try:
        yield
    except Exception:
        EXTRACTION_FAILURE_COUNTER.labels(backend=backend).inc()
        raise
    finally:
        EXTRACTION_HISTOGRAM.labels(backend=backend).observe(perf_counter() - start)


def metrics_response() -> Response:
    """The handler for GET /metrics."""
    payload = generate_latest()
    return Response(payload, media_type=CONTENT_TYPE_LATEST)
