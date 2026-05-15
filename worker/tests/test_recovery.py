"""Tests for crashed-worker recovery.

The recovery logic touches the DB and the Redis queue. We mock both
with the same FakeRedis used in test_jobs_queue + the _FakePool /
_FakeConn shape used elsewhere.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from uuid import uuid4

import pytest

from app.jobs.queue import JobQueue
from app.jobs.recovery import (
    DEFAULT_GIVE_UP_SECONDS,
    recover_one,
    run_recovery,
)


class FakeRedis:
    def __init__(self):
        self.lists: dict[str, list[str]] = {}
        self.hashes: dict[str, dict[str, str]] = {}

    async def lpush(self, key, value):
        self.lists.setdefault(key, []).insert(0, value)

    async def llen(self, key):
        return len(self.lists.get(key, []))

    async def hset(self, key, field, value):
        self.hashes.setdefault(key, {})[field] = value

    async def hdel(self, key, field):
        self.hashes.get(key, {}).pop(field, None)

    async def brpop(self, *a, **k):
        return None

    async def hlen(self, key):
        return len(self.hashes.get(key, {}))

    async def aclose(self):
        pass


@pytest.fixture
def queue():
    return JobQueue(FakeRedis())


class _FakeConn:
    def __init__(self):
        self.executed = []
        self.stale_rows = []
        self.update_returns = "UPDATE 1"

    async def fetch(self, sql, *args):
        if "processing_status = 'processing'" in sql:
            return self.stale_rows
        return []

    async def execute(self, sql, *args):
        self.executed.append((sql.strip().split()[0].upper(), args))
        return self.update_returns


class _FakePool:
    def __init__(self, conn):
        self.conn = conn

    def acquire(self):
        return _Ctx(self.conn)


class _Ctx:
    def __init__(self, c):
        self.c = c

    async def __aenter__(self):
        return self.c

    async def __aexit__(self, *a):
        return False


def _stale_row(seconds_ago: int) -> dict:
    return {
        "id": uuid4(),
        "election_id": "2027-presidential",
        "pu_code": "25-11-04-007",
        "image_url": "https://x/y.jpg",
        "image_sha256": "a" * 64,
        "extraction_started_at": datetime.now(timezone.utc) - timedelta(seconds=seconds_ago),
        "queued_at": datetime.now(timezone.utc) - timedelta(seconds=seconds_ago + 30),
    }


@pytest.mark.asyncio
async def test_recover_one_requeues_when_below_giveup_threshold(queue):
    conn = _FakeConn()
    row = _stale_row(60 * 35)   # 35 minutes - stale but not give-up

    with patch("app.jobs.recovery.pool", return_value=_FakePool(conn)):
        outcome = await recover_one(queue, row=row)

    assert outcome == "requeued"
    assert await queue.depth() == 1
    # Audit + status update both fired
    assert any("UPDATE" == s[0] for s in conn.executed)
    assert any("INSERT" == s[0] for s in conn.executed)


@pytest.mark.asyncio
async def test_recover_one_gives_up_after_threshold(queue):
    conn = _FakeConn()
    row = _stale_row(DEFAULT_GIVE_UP_SECONDS + 60)

    with patch("app.jobs.recovery.pool", return_value=_FakePool(conn)):
        outcome = await recover_one(queue, row=row)

    assert outcome == "gave_up"
    assert await queue.depth() == 0   # NOT re-queued
    # status went to 'failed'
    update_args = [a for op, a in conn.executed if op == "UPDATE"]
    assert any("recovery_giveup" in str(a) for a in update_args)


@pytest.mark.asyncio
async def test_recover_one_skips_when_row_already_claimed(queue):
    """If two recovery ticks race, only one should win the re-queue.
    The second sees UPDATE 0 (because the WHERE clause has the status
    filter) and returns 'skipped' without enqueuing a duplicate job."""
    conn = _FakeConn()
    conn.update_returns = "UPDATE 0"
    row = _stale_row(60 * 35)

    with patch("app.jobs.recovery.pool", return_value=_FakePool(conn)):
        outcome = await recover_one(queue, row=row)

    assert outcome == "skipped"
    assert await queue.depth() == 0


@pytest.mark.asyncio
async def test_recover_one_skips_when_started_at_is_null(queue):
    row = _stale_row(60 * 35)
    row["extraction_started_at"] = None

    conn = _FakeConn()
    with patch("app.jobs.recovery.pool", return_value=_FakePool(conn)):
        outcome = await recover_one(queue, row=row)

    assert outcome == "skipped"


@pytest.mark.asyncio
async def test_run_recovery_processes_multiple_rows(queue):
    conn = _FakeConn()
    conn.stale_rows = [
        _stale_row(60 * 35),
        _stale_row(60 * 35),
        _stale_row(DEFAULT_GIVE_UP_SECONDS + 60),
    ]
    with patch("app.jobs.recovery.pool", return_value=_FakePool(conn)):
        counts = await run_recovery(queue)
    assert counts == {"requeued": 2, "gave_up": 1, "skipped": 0}
