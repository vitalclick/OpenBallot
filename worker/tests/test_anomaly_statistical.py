"""Tests for the statistical peer-outlier detector."""

from __future__ import annotations

from app.anomaly.statistical import (
    PUTurnout,
    PeerDistribution,
    run_leader_share_check,
    run_statistical_checks,
    z_score,
)
from app.anomaly.types import AnomalyType, Severity


def _pu(turnout=0.7, leader_share=0.5, pu_code="X") -> PUTurnout:
    return PUTurnout(
        pu_code=pu_code,
        election_id="2027-presidential",
        ward_code="W1",
        lga_code="L1",
        turnout=turnout,
        leader_share=leader_share,
        consensus_data={},
    )


def test_z_score_zero_stddev_returns_zero():
    assert z_score(5, 5, 0) == 0


def test_z_score_normal_calc():
    assert z_score(10, 5, 2.5) == 2.0


def test_normal_turnout_no_hit():
    pu = _pu(turnout=0.65)
    ward = PeerDistribution(n=20, mean=0.7, stddev=0.05)
    hits = run_statistical_checks(pu, ward_dist=ward, lga_dist=None)
    assert hits == []


def test_extreme_turnout_outlier_ward_critical():
    """A PU at 99% turnout in a ward where the mean is 60% and stddev
    is 0.05 - z = (0.99 - 0.6) / 0.05 = 7.8 → CRITICAL"""
    pu = _pu(turnout=0.99)
    ward = PeerDistribution(n=30, mean=0.60, stddev=0.05)
    hits = run_statistical_checks(pu, ward_dist=ward, lga_dist=None)
    assert len(hits) == 1
    assert hits[0].anomaly_type == AnomalyType.TURNOUT_OUTLIER_WARD
    assert hits[0].severity == Severity.CRITICAL
    assert hits[0].details["z_score"] >= 5.0


def test_moderate_outlier_high_severity():
    # stddev tuned so z falls in the HIGH band (4 <= z < 5):
    # (0.88 - 0.60) / 0.07 ≈ 4.0
    pu = _pu(turnout=0.88)
    ward = PeerDistribution(n=30, mean=0.60, stddev=0.07)
    hits = run_statistical_checks(pu, ward_dist=ward, lga_dist=None)
    assert hits[0].severity == Severity.HIGH


def test_falls_back_to_lga_when_ward_dist_missing():
    pu = _pu(turnout=0.92)
    lga = PeerDistribution(n=120, mean=0.65, stddev=0.04)
    hits = run_statistical_checks(pu, ward_dist=None, lga_dist=lga)
    assert len(hits) == 1
    assert hits[0].anomaly_type == AnomalyType.TURNOUT_OUTLIER_LGA


def test_lga_ignored_when_ward_present_to_avoid_double_flag():
    pu = _pu(turnout=0.92)
    ward = PeerDistribution(n=30, mean=0.65, stddev=0.04)
    lga = PeerDistribution(n=300, mean=0.65, stddev=0.05)
    hits = run_statistical_checks(pu, ward_dist=ward, lga_dist=lga)
    types = {h.anomaly_type for h in hits}
    assert AnomalyType.TURNOUT_OUTLIER_WARD in types
    assert AnomalyType.TURNOUT_OUTLIER_LGA not in types


def test_small_ward_sample_skipped():
    """A 3-PU ward is too small to make any z-test meaningful."""
    pu = _pu(turnout=0.99)
    ward = PeerDistribution(n=3, mean=0.6, stddev=0.05)
    hits = run_statistical_checks(pu, ward_dist=ward, lga_dist=None)
    assert hits == []


def test_zero_stddev_ward_skipped():
    """A ward where every PU produced exactly the same turnout has 0
    stddev and cannot z-test anything."""
    pu = _pu(turnout=0.99)
    ward = PeerDistribution(n=20, mean=0.6, stddev=0.0)
    hits = run_statistical_checks(pu, ward_dist=ward, lga_dist=None)
    assert hits == []


def test_leader_share_check_flags_extreme_outlier():
    """All neighbours split ~40/40/20 (leader share ~0.4); this PU
    reports leader share 0.92 — clear outlier."""
    pu = _pu(leader_share=0.92)
    peers = [0.40, 0.42, 0.38, 0.41, 0.39, 0.43, 0.40]
    hits = run_leader_share_check(pu, ward_leader_shares=peers)
    assert len(hits) == 1
    assert hits[0].anomaly_type == AnomalyType.LEADER_SHARE_OUTLIER_WARD


def test_leader_share_check_small_ward_skipped():
    pu = _pu(leader_share=0.92)
    peers = [0.40, 0.42]   # only 2 peers
    hits = run_leader_share_check(pu, ward_leader_shares=peers)
    assert hits == []
