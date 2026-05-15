"""Tests for the ingestion job handler.

The handler does real DB writes - we mock the asyncpg pool with the
same `_FakePool / _FakeConn` shape used in test_anchor_cron / test_admin_review.
"""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest

from app.extraction.engine import StubExtractor, ExtractionEngine
from app.jobs.ingest import IngestionJobHandler
from app.jobs.queue import IngestionJob


class _FakeConn:
    def __init__(self):
        self.executed: list[tuple] = []
        self.submissions_for_pu: list[dict] = []
        self.fetchval_returns: dict = {}

    async def fetch(self, sql, *args):
        if "ec8a_submissions" in sql:
            return self.submissions_for_pu
        return []

    async def fetchval(self, sql, *args):
        return self.fetchval_returns.get("default")

    async def fetchrow(self, sql, *args):
        return None

    async def execute(self, sql, *args):
        # Capture the first token (UPDATE/INSERT) for inspection.
        self.executed.append((sql.strip().split()[0].upper(), args))


class _FakePool:
    def __init__(self, conn):
        self.conn = conn

    def acquire(self):
        return _Acquire(self.conn)


class _Acquire:
    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, *a):
        return False


def _stub_extractor():
    # Stub returns deterministic, arithmetically-consistent output.
    primary = StubExtractor(name="stub-primary", confidence=0.97)
    # Override extract() to return arithmetic-consistent payload so
    # the handler doesn't go down the fallback path.
    original_extract = primary.extract

    async def consistent(image_url, pu_code):
        result = await original_extract(image_url, pu_code)
        # Force the result's payload to consistent numbers.
        result.extracted.registered_voters = 500
        result.extracted.accredited_voters = 450
        result.extracted.candidate_votes = {"APC": 142, "PDP": 89, "LP": 203}
        result.extracted.total_valid_votes = 434
        result.extracted.rejected_ballots = 12
        result.extracted.total_votes_cast = 446
        # Re-run arithmetic since we mutated.
        from app.extraction.arithmetic import arithmetic_consistent as ar
        result.arithmetic = ar(result.extracted)
        return result

    primary.extract = consistent
    return ExtractionEngine(primary=primary, secondary=primary, confidence_floor=0.85)


def _job() -> IngestionJob:
    return IngestionJob(
        submission_id=str(uuid4()),
        election_id="2027-presidential",
        pu_code="25-11-04-007",
        image_url="https://x/y.jpg",
        image_sha256="a" * 64,
        enqueued_at=datetime.now(timezone.utc).isoformat(),
    )


@pytest.mark.asyncio
async def test_happy_path_marks_extracted_and_publishes():
    conn = _FakeConn()
    pub = MagicMock()
    pub.submission_extracted = AsyncMock()
    pub.verified_result = AsyncMock()
    pub.submission_failed = AsyncMock()

    handler = IngestionJobHandler(publisher=pub, extractor=_stub_extractor())

    with patch("app.jobs.ingest.pool", return_value=_FakePool(conn)), \
         patch("app.anomaly.engine.pool", return_value=_FakePool(conn)):
        await handler.run(_job())

    statements = [s[0] for s in conn.executed]
    # First UPDATE: mark processing. Second UPDATE: mark extracted.
    assert statements.count("UPDATE") >= 2
    # An INSERT for audit_log and one for verified_results.
    assert "INSERT" in statements
    pub.submission_extracted.assert_awaited_once()
    pub.verified_result.assert_awaited_once()
    pub.submission_failed.assert_not_awaited()


@pytest.mark.asyncio
async def test_extractor_failure_marks_failed_and_publishes():
    conn = _FakeConn()
    pub = MagicMock()
    pub.submission_extracted = AsyncMock()
    pub.submission_failed = AsyncMock()
    pub.verified_result = AsyncMock()

    class FailingExtractor:
        async def run(self, image_url, pu_code):
            raise RuntimeError("OCR provider 503")

    handler = IngestionJobHandler(publisher=pub, extractor=FailingExtractor())

    with patch("app.jobs.ingest.pool", return_value=_FakePool(conn)):
        with pytest.raises(RuntimeError, match="503"):
            await handler.run(_job())

    statements = [s[0] for s in conn.executed]
    # UPDATE to processing, then UPDATE to failed.
    assert statements.count("UPDATE") >= 2
    pub.submission_failed.assert_awaited_once()
    pub.submission_extracted.assert_not_awaited()
