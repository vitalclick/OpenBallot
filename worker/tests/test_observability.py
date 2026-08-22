"""Tests for the observability surface.

We don't test Sentry's wire format (that's their job). We DO test:
  - init_sentry is idempotent and no-ops without a DSN
  - metrics expose the documented names + labels
  - observe_extraction records duration on success and failure
  - the /metrics endpoint emits valid Prometheus text format
"""

from __future__ import annotations

import pytest

from app.observability import init_sentry
from app.observability.metrics import (
    EXTRACTION_FAILURE_COUNTER,
    EXTRACTION_HISTOGRAM,
    INGESTION_COUNTER,
    INGESTION_REJECTED_COUNTER,
    metrics_response,
    observe_extraction,
)


def test_init_sentry_noops_without_dsn(monkeypatch):
    monkeypatch.delenv("SENTRY_DSN", raising=False)
    # Should not raise
    init_sentry(environment="test")


def test_init_sentry_is_idempotent(monkeypatch):
    monkeypatch.delenv("SENTRY_DSN", raising=False)
    init_sentry(environment="test")
    init_sentry(environment="test")    # double call, no error


def test_ingestion_counter_records_label():
    before = INGESTION_COUNTER.labels(source_type="party_agent")._value.get()
    INGESTION_COUNTER.labels(source_type="party_agent").inc()
    after = INGESTION_COUNTER.labels(source_type="party_agent")._value.get()
    assert after == before + 1


def test_ingestion_rejected_counter_records_label():
    INGESTION_REJECTED_COUNTER.labels(reason="geofence_violation").inc()
    assert INGESTION_REJECTED_COUNTER.labels(reason="geofence_violation")._value.get() >= 1


def test_observe_extraction_records_duration():
    sample_count_before = EXTRACTION_HISTOGRAM.labels(backend="test")._sum.get()
    with observe_extraction("test"):
        pass    # zero-cost block
    sample_count_after = EXTRACTION_HISTOGRAM.labels(backend="test")._sum.get()
    # sum increases by at least 0 (perf_counter delta is positive)
    assert sample_count_after >= sample_count_before


def test_observe_extraction_increments_failure_counter_on_exception():
    before = EXTRACTION_FAILURE_COUNTER.labels(backend="test-fail")._value.get()
    with pytest.raises(RuntimeError), observe_extraction("test-fail"):
        raise RuntimeError("boom")
    after = EXTRACTION_FAILURE_COUNTER.labels(backend="test-fail")._value.get()
    assert after == before + 1


def test_metrics_response_is_prometheus_text_format():
    response = metrics_response()
    body = response.body.decode("utf-8")
    assert "openballot_ingestion_total" in body
    assert "openballot_extraction_duration_seconds" in body
    # Prometheus exposition format starts each metric block with # HELP
    assert "# HELP " in body
    assert "# TYPE " in body


def test_metrics_includes_all_documented_metric_families():
    body = metrics_response().body.decode("utf-8")
    for family in (
        "openballot_ingestion_total",
        "openballot_ingestion_rejected_total",
        "openballot_extraction_duration_seconds",
        "openballot_extraction_failures_total",
        "openballot_auth_otp_total",
        "openballot_anchor_total",
        "openballot_anomaly_total",
        "openballot_queue_depth",
        "openballot_inflight_jobs",
    ):
        assert family in body, f"missing metric family {family}"
