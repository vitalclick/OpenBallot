"""Tests for the deterministic anomaly sanity checks."""

from __future__ import annotations

from app.anomaly.sanity import run_sanity_checks
from app.anomaly.types import AnomalyType, Severity
from app.models import ExtractedEC8A


def _ec8a(**overrides) -> ExtractedEC8A:
    base = {
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
    }
    base.update(overrides)
    return ExtractedEC8A(**base)


def test_clean_form_produces_no_hits():
    hits = run_sanity_checks(_ec8a(), election_id="2027-presidential")
    assert hits == []


def test_votes_exceed_registered_critical():
    hits = run_sanity_checks(
        _ec8a(
            registered_voters=400,
            accredited_voters=600,
            total_valid_votes=580,
            total_votes_cast=590,
        ),
        election_id="2027-presidential",
    )
    types = {h.anomaly_type for h in hits}
    assert AnomalyType.VOTES_EXCEED_REGISTERED in types
    severities = [h.severity for h in hits if h.anomaly_type == AnomalyType.VOTES_EXCEED_REGISTERED]
    assert severities == [Severity.CRITICAL]
    # Details carry the excess delta
    detail = next(h.details for h in hits if h.anomaly_type == AnomalyType.VOTES_EXCEED_REGISTERED)
    assert detail["excess"] == 190


def test_turnout_exceeds_accreditation_critical():
    hits = run_sanity_checks(
        _ec8a(accredited_voters=200, total_votes_cast=250),
        election_id="2027-presidential",
    )
    assert AnomalyType.TURNOUT_EXCEEDS_ACCREDITATION in {h.anomaly_type for h in hits}


def test_rejected_exceeds_cast_critical():
    hits = run_sanity_checks(
        _ec8a(rejected_ballots=500, total_votes_cast=400),
        election_id="2027-presidential",
    )
    assert AnomalyType.REJECTED_EXCEEDS_CAST in {h.anomaly_type for h in hits}


def test_cast_zero_with_votes_recorded_critical():
    hits = run_sanity_checks(
        _ec8a(total_votes_cast=0, total_valid_votes=100),
        election_id="2027-presidential",
    )
    assert AnomalyType.CAST_ZERO_BUT_VOTES_RECORDED in {h.anomaly_type for h in hits}


def test_zero_registered_voters_flagged_high():
    hits = run_sanity_checks(
        _ec8a(registered_voters=0, accredited_voters=0, total_votes_cast=0, total_valid_votes=0, rejected_ballots=0),
        election_id="2027-presidential",
    )
    types = {h.anomaly_type for h in hits}
    assert AnomalyType.ZERO_REGISTERED_VOTERS in types


def test_leader_extreme_share_above_97pct():
    # 432/434 = 99.5% for LP
    hits = run_sanity_checks(
        _ec8a(
            candidate_votes={"APC": 1, "PDP": 1, "LP": 432},
            total_valid_votes=434,
        ),
        election_id="2027-presidential",
    )
    types = {h.anomaly_type for h in hits}
    assert AnomalyType.LEADER_EXTREME_SHARE in types
    detail = next(h.details for h in hits if h.anomaly_type == AnomalyType.LEADER_EXTREME_SHARE)
    assert detail["leader"] == "LP"
    assert detail["share"] >= 0.97


def test_leader_extreme_share_below_threshold_no_hit():
    # 200/434 = 46% - not extreme
    hits = run_sanity_checks(
        _ec8a(),
        election_id="2027-presidential",
    )
    types = {h.anomaly_type for h in hits}
    assert AnomalyType.LEADER_EXTREME_SHARE not in types


def test_leader_extreme_share_ignored_for_small_pus():
    # 28/30 = 93.3% but in a very small PU - statistical signal too weak.
    hits = run_sanity_checks(
        _ec8a(
            candidate_votes={"APC": 1, "LP": 28},
            total_valid_votes=30,    # below the 30-vote noise floor (>30 required)
            total_votes_cast=30,
            rejected_ballots=0,
        ),
        election_id="2027-presidential",
    )
    types = {h.anomaly_type for h in hits}
    assert AnomalyType.LEADER_EXTREME_SHARE not in types


def test_multiple_anomalies_in_one_form():
    """A truly bad form should produce several hits."""
    hits = run_sanity_checks(
        _ec8a(
            registered_voters=100,
            accredited_voters=80,
            total_votes_cast=500,        # way over both registered & accredited
            total_valid_votes=480,
            rejected_ballots=20,
            candidate_votes={"APC": 480, "PDP": 0, "LP": 0},   # 100% leader
        ),
        election_id="2027-presidential",
    )
    types = {h.anomaly_type for h in hits}
    assert AnomalyType.VOTES_EXCEED_REGISTERED in types
    assert AnomalyType.TURNOUT_EXCEEDS_ACCREDITATION in types
    assert AnomalyType.LEADER_EXTREME_SHARE in types


# ─── Votes against zero accreditation (issue #67) ─────────────────────────


def test_votes_with_zero_accreditation_flagged():
    """The signal the CCIJ 2023 investigation was built on: BVAS synced
    accreditation reads zero while votes were recorded."""
    hits = run_sanity_checks(
        _ec8a(
            registered_voters=800,
            accredited_voters=0,
            total_votes_cast=126,
            total_valid_votes=126,
            rejected_ballots=0,
            candidate_votes={"APC": 40, "PDP": 44, "LP": 42},
        ),
        election_id="2023-presidential",
    )
    by_type = {h.anomaly_type: h for h in hits}
    assert AnomalyType.VOTES_WITHOUT_ACCREDITATION in by_type

    hit = by_type[AnomalyType.VOTES_WITHOUT_ACCREDITATION]
    assert hit.details["cast"] == 126
    # HIGH rather than CRITICAL: a zero can mean a BVAS sync failure over a
    # poor network, not only unaccredited voting. The note travels with the
    # hit so a reviewer sees the ambiguity, not just the severity.
    assert hit.severity == Severity.HIGH
    assert "BVAS" in hit.details["note"]


def test_zero_accreditation_does_not_also_fire_over_voting():
    """The two checks are mutually exclusive by construction.

    turnout_exceeds_accreditation compares two positive numbers and admits no
    innocent reading; double-flagging would overstate a case the data cannot
    settle on its own."""
    hits = run_sanity_checks(
        _ec8a(accredited_voters=0, total_votes_cast=126, total_valid_votes=126,
              rejected_ballots=0, candidate_votes={"APC": 60, "PDP": 66}),
        election_id="2023-presidential",
    )
    types = {h.anomaly_type for h in hits}
    assert AnomalyType.VOTES_WITHOUT_ACCREDITATION in types
    assert AnomalyType.TURNOUT_EXCEEDS_ACCREDITATION not in types


def test_zero_accreditation_and_zero_votes_is_not_an_anomaly():
    """A polling unit where nothing happened is not suspicious."""
    hits = run_sanity_checks(
        _ec8a(accredited_voters=0, total_votes_cast=0, total_valid_votes=0,
              rejected_ballots=0, candidate_votes={"APC": 0, "PDP": 0}),
        election_id="2023-presidential",
    )
    types = {h.anomaly_type for h in hits}
    assert AnomalyType.VOTES_WITHOUT_ACCREDITATION not in types
