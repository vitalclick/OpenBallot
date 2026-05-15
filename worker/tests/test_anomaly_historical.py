"""Tests for the historical-baseline anomaly detector."""

from __future__ import annotations

from app.anomaly.historical import (
    CurrentResult,
    HistoricalBaseline,
    run_historical_checks,
)
from app.anomaly.types import AnomalyType, Severity


def _current(turnout=0.7, leader_party="LP", leader_share=0.5) -> CurrentResult:
    return CurrentResult(
        election_id="2027-presidential",
        pu_code="25-11-04-007",
        turnout=turnout,
        leader_party=leader_party,
        leader_share=leader_share,
    )


def _baseline(turnout=0.7, leader_party="LP", leader_share=0.5) -> HistoricalBaseline:
    return HistoricalBaseline(
        election_id="2023-presidential",
        pu_code="25-11-04-007",
        turnout=turnout,
        leader_party=leader_party,
        leader_share=leader_share,
    )


def test_no_baseline_no_hits():
    hits = run_historical_checks(_current(), baseline=None)
    assert hits == []


def test_stable_pu_no_hits():
    hits = run_historical_checks(_current(turnout=0.72), _baseline(turnout=0.70))
    assert hits == []


def test_large_turnout_shift_flagged():
    """2023: 30% turnout. 2027: 85%. Shift = 55pp → CRITICAL (>=70 actually
    HIGH; let's check the band right)."""
    hits = run_historical_checks(
        _current(turnout=0.85),
        _baseline(turnout=0.30),
    )
    assert len(hits) == 1
    assert hits[0].anomaly_type == AnomalyType.TURNOUT_SHIFT_VS_2023
    # shift = 55pp -> Severity.HIGH (>= 50, < 70)
    assert hits[0].severity == Severity.HIGH
    assert hits[0].details["shift_pp"] == 55.0


def test_extreme_turnout_shift_critical():
    hits = run_historical_checks(
        _current(turnout=0.95),
        _baseline(turnout=0.20),
    )
    assert hits[0].severity == Severity.CRITICAL


def test_party_flip_with_huge_share_swing_flagged():
    """2023 winner was LP with 65%. 2027 winner is APC with 60%.
    Party flipped AND the leader share moved 5pp - that's not enough
    by itself (the default threshold is 50pp) so no hit."""
    hits = run_historical_checks(
        _current(leader_party="APC", leader_share=0.60),
        _baseline(leader_party="LP", leader_share=0.65),
    )
    types = {h.anomaly_type for h in hits}
    assert AnomalyType.LEADER_PARTY_SHIFT_VS_2023 not in types


def test_party_flip_with_above_threshold_share_swing_flagged():
    """2023: LP got 80%. 2027: APC gets 95%. Flip + 15pp swing - still
    under threshold. Let's go bigger."""
    hits = run_historical_checks(
        _current(leader_party="APC", leader_share=0.92),
        _baseline(leader_party="LP", leader_share=0.30),
    )
    types = {h.anomaly_type for h in hits}
    assert AnomalyType.LEADER_PARTY_SHIFT_VS_2023 in types
    # share shift = 62pp → CRITICAL? (default uses 70 for CRITICAL, 50 for HIGH)
    detail = [h for h in hits if h.anomaly_type == AnomalyType.LEADER_PARTY_SHIFT_VS_2023][0]
    assert detail.severity == Severity.HIGH


def test_same_party_winning_with_huge_swing_not_flagged():
    """Same party wins both elections, just by more / less - this is
    not what the detector targets."""
    hits = run_historical_checks(
        _current(leader_party="LP", leader_share=0.95),
        _baseline(leader_party="LP", leader_share=0.30),
    )
    types = {h.anomaly_type for h in hits}
    assert AnomalyType.LEADER_PARTY_SHIFT_VS_2023 not in types
