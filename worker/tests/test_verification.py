"""Tests for the multi-source verification engine.

These tests exercise the core consensus / discrepancy logic that drives the
public map's colour states. They are intentionally not coupled to the
database - the engine is pure.
"""

from datetime import UTC, datetime
from uuid import uuid4

from app.models import (
    ExtractedEC8A,
    SubmissionRecord,
    SubmissionSource,
    VerificationStatus,
)
from app.verification import compute_consensus


def _sub(
    source: SubmissionSource,
    party: str | None,
    votes: dict[str, int],
    *,
    valid: int | None = None,
    accredited: int = 287,
    registered: int = 412,
    rejected: int = 12,
    cast: int | None = None,
) -> SubmissionRecord:
    total_valid = valid if valid is not None else sum(votes.values())
    total_cast = cast if cast is not None else total_valid + rejected
    return SubmissionRecord(
        id=uuid4(),
        election_id="2027-presidential",
        pu_code="25-11-04-007",
        source_type=source,
        party_code=party,
        image_url="https://x/y.jpg",
        image_sha256="a" * 64,
        gps=None,
        submitted_at=datetime.now(UTC),
        confidence_score=0.97,
        extracted_data=ExtractedEC8A(
            pu_code="25-11-04-007",
            registered_voters=registered,
            accredited_voters=accredited,
            candidate_votes=votes,
            total_valid_votes=total_valid,
            rejected_ballots=rejected,
            total_votes_cast=total_cast,
            presiding_officer_signed=True,
            agent_signatures_detected=3,
            official_stamp_present=True,
        ),
        validation_flags={},
        review_status="auto_approved",
    )


def test_no_data():
    out = compute_consensus([], election_id="2027-presidential", pu_code="25-11-04-007")
    assert out.status == VerificationStatus.NO_DATA
    assert out.submission_count == 0


def test_single_source():
    apc = _sub(SubmissionSource.PARTY_AGENT, "APC", {"APC": 142, "PDP": 89, "LP": 203})
    out = compute_consensus([apc], election_id="2027-presidential", pu_code="25-11-04-007")
    assert out.status == VerificationStatus.SINGLE_SOURCE
    assert out.consensus_data is not None


def test_consensus_when_two_parties_agree():
    votes = {"APC": 142, "PDP": 89, "LP": 203}
    out = compute_consensus(
        [
            _sub(SubmissionSource.PARTY_AGENT, "APC", votes),
            _sub(SubmissionSource.PARTY_AGENT, "LP", votes),
        ],
        election_id="2027-presidential",
        pu_code="25-11-04-007",
    )
    assert out.status == VerificationStatus.CONSENSUS
    assert out.consensus_data.candidate_votes == votes


def test_discrepancy_when_parties_disagree():
    out = compute_consensus(
        [
            _sub(SubmissionSource.PARTY_AGENT, "APC", {"APC": 142, "PDP": 89, "LP": 203}),
            _sub(SubmissionSource.PARTY_AGENT, "LP", {"APC": 142, "PDP": 89, "LP": 280}),
        ],
        election_id="2027-presidential",
        pu_code="25-11-04-007",
    )
    assert out.status == VerificationStatus.DISCREPANCY
    assert "candidate_votes.LP" in out.discrepant_fields


def test_two_agents_same_party_is_not_consensus():
    """Two APC agents are not independent sources. This guards against
    a party stuffing its own submission count to fake consensus."""
    votes = {"APC": 142, "PDP": 89, "LP": 203}
    out = compute_consensus(
        [
            _sub(SubmissionSource.PARTY_AGENT, "APC", votes),
            _sub(SubmissionSource.PARTY_AGENT, "APC", votes),
        ],
        election_id="2027-presidential",
        pu_code="25-11-04-007",
    )
    assert out.status == VerificationStatus.SINGLE_SOURCE


def test_observer_counts_as_independent_source():
    votes = {"APC": 142, "PDP": 89, "LP": 203}
    out = compute_consensus(
        [
            _sub(SubmissionSource.PARTY_AGENT, "APC", votes),
            _sub(SubmissionSource.OBSERVER, None, votes),
        ],
        election_id="2027-presidential",
        pu_code="25-11-04-007",
    )
    assert out.status == VerificationStatus.CONSENSUS


def test_inec_only_is_inec_published_not_single_source():
    """The 2023 historical dataset has INEC IReV as the only source. That
    must render as `inec_published`, not `single_source` (which means a
    single party/observer with no INEC presence)."""
    votes = {"APC": 142, "PDP": 89, "LP": 203}
    out = compute_consensus(
        [_sub(SubmissionSource.INEC_IREV, None, votes)],
        election_id="2023-presidential",
        pu_code="25-11-04-007",
    )
    assert out.status == VerificationStatus.INEC_PUBLISHED
    assert out.consensus_data.candidate_votes == votes


def test_inec_confirmed():
    votes = {"APC": 142, "PDP": 89, "LP": 203}
    out = compute_consensus(
        [
            _sub(SubmissionSource.PARTY_AGENT, "APC", votes),
            _sub(SubmissionSource.PARTY_AGENT, "LP", votes),
            _sub(SubmissionSource.INEC_IREV, None, votes),
        ],
        election_id="2027-presidential",
        pu_code="25-11-04-007",
    )
    assert out.status == VerificationStatus.INEC_CONFIRMED


def test_inec_conflict_is_the_red_flag():
    """The most important state on the map: multi-party consensus says one
    thing, INEC's official upload says another. This is the Rivers-2023
    scenario the platform is designed to catch."""
    consensus_votes = {"APC": 142, "PDP": 89, "LP": 203}
    inec_votes = {"APC": 142, "PDP": 80239, "LP": 203}  # fabricated at collation
    out = compute_consensus(
        [
            _sub(SubmissionSource.PARTY_AGENT, "APC", consensus_votes),
            _sub(SubmissionSource.PARTY_AGENT, "LP", consensus_votes),
            _sub(SubmissionSource.INEC_IREV, None, inec_votes, valid=80584, cast=80596),
        ],
        election_id="2027-presidential",
        pu_code="25-11-04-007",
    )
    assert out.status == VerificationStatus.INEC_CONFLICT
    assert out.consensus_data.candidate_votes == consensus_votes
