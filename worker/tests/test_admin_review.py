"""Tests for the consortium review queue.

The review logic touches the DB and the verification engine, so the
tests mock asyncpg's connection. The verification engine is exercised
through a real call - we are testing the integration between review
decisions and downstream consensus recomputation.
"""

from __future__ import annotations

import json
from datetime import UTC
from uuid import uuid4

import pytest

from app.admin.review import ReviewAction, apply_review


class _FakeConn:
    def __init__(self):
        self.execute_log: list[tuple[str, tuple]] = []
        self.submission_row = None
        self.approved_submissions: list[dict] = []

    async def fetchrow(self, sql, *args):
        # First fetchrow is the FOR UPDATE pick of the submission under review.
        return self.submission_row

    async def fetch(self, sql, *args):
        return self.approved_submissions

    async def execute(self, sql, *args):
        self.execute_log.append((sql.strip().split()[0].upper(), args))


def _good_extracted_json():
    return json.dumps({
        "pu_code": "25-11-04-007",
        "registered_voters": 500,
        "accredited_voters": 450,
        "candidate_votes": {"APC": 142, "PDP": 89, "LP": 203},
        "total_valid_votes": 434,
        "rejected_ballots": 12,
        "total_votes_cast": 446,
        "presiding_officer_signed": True,
        "agent_signatures_detected": 3,
        "official_stamp_present": True,
    })


@pytest.mark.asyncio
async def test_approve_flips_status_and_recomputes_consensus():
    conn = _FakeConn()
    sid = uuid4()
    reviewer = uuid4()

    conn.submission_row = {
        "id": sid,
        "election_id": "2027-presidential",
        "pu_code": "25-11-04-007",
        "review_status": "pending_review",
    }
    # After approval the submission joins the consensus pool. We seed two
    # independent sources so the engine returns CONSENSUS.
    from datetime import datetime
    base_row = {
        "id": uuid4(),
        "source_type": "party_agent",
        "party_code": "APC",
        "image_url": "https://x/y.jpg",
        "image_sha256": "a" * 64,
        "extracted_data": _good_extracted_json(),
        "submitted_at": datetime.now(UTC),
        "confidence_score": 0.97,
        "validation_flags": {},
        "review_status": "auto_approved",
    }
    other_row = {**base_row, "id": uuid4(), "party_code": "LP"}
    conn.approved_submissions = [base_row, other_row]

    outcome = await apply_review(
        conn,
        submission_id=sid,
        action=ReviewAction.APPROVE,
        reviewer_id=reviewer,
    )

    assert outcome.new_status == "reviewed_accepted"
    assert outcome.verification_status == "consensus"

    # Side-effect log: UPDATE submission, INSERT audit_log, INSERT
    # verified_results (the UPSERT into verified_results uses execute).
    statements = [s[0] for s in conn.execute_log]
    assert "UPDATE" in statements
    assert "INSERT" in statements    # audit_log
    assert statements.count("INSERT") >= 2


@pytest.mark.asyncio
async def test_reject_requires_reason():
    conn = _FakeConn()
    with pytest.raises(ValueError, match="reason"):
        await apply_review(
            conn,
            submission_id=uuid4(),
            action=ReviewAction.REJECT,
            reviewer_id=uuid4(),
        )


@pytest.mark.asyncio
async def test_reject_marks_status_and_records_reason():
    conn = _FakeConn()
    sid = uuid4()
    conn.submission_row = {
        "id": sid,
        "election_id": "2027-presidential",
        "pu_code": "25-11-04-007",
        "review_status": "pending_review",
    }
    outcome = await apply_review(
        conn,
        submission_id=sid,
        action=ReviewAction.REJECT,
        reviewer_id=uuid4(),
        reason="image too blurred to verify candidate names",
    )
    assert outcome.new_status == "reviewed_rejected"
    # An audit event was written
    inserts = [s for s in conn.execute_log if s[0] == "INSERT"]
    assert len(inserts) >= 1
    audit_args = inserts[0][1]
    assert audit_args[0] == "submission.rejectd"


@pytest.mark.asyncio
async def test_double_decision_rejected():
    """A submission already in reviewed_accepted cannot be re-decided -
    every review action must move from pending_review."""
    conn = _FakeConn()
    conn.submission_row = {
        "id": uuid4(),
        "election_id": "2027-presidential",
        "pu_code": "25-11-04-007",
        "review_status": "reviewed_accepted",
    }
    with pytest.raises(ValueError, match="not pending_review"):
        await apply_review(
            conn,
            submission_id=uuid4(),
            action=ReviewAction.APPROVE,
            reviewer_id=uuid4(),
        )


@pytest.mark.asyncio
async def test_missing_submission_raises():
    conn = _FakeConn()
    conn.submission_row = None
    with pytest.raises(ValueError, match="not found"):
        await apply_review(
            conn,
            submission_id=uuid4(),
            action=ReviewAction.APPROVE,
            reviewer_id=uuid4(),
        )
