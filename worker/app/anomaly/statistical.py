"""Statistical peer-outlier detection.

For each PU with a verified consensus, compute the turnout and compare
to the population mean+stddev of the parent ward (and parent LGA when
the ward sample is too small). A z-score beyond `z_threshold` is
flagged.

We need the parent population's stats, which come from the materialised
views `mv_ward_turnout_dist` and `mv_lga_turnout_dist`. The caller is
responsible for refreshing those views before running this layer.

This module is pure: it takes a "PU turnout" plus a "peer distribution"
in memory and returns hits. The DB I/O lives in `engine.py`.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from .types import AnomalyHit, AnomalyType, Severity


# Default z-threshold for "extreme outlier". 3.0 corresponds to ~0.3% of
# a normal distribution. Configurable per election via settings.
DEFAULT_Z_THRESHOLD = 3.0


@dataclass
class PeerDistribution:
    n: int
    mean: float
    stddev: float


@dataclass
class PUTurnout:
    pu_code: str
    election_id: str
    ward_code: str
    lga_code: str
    turnout: float                          # cast / registered
    leader_share: float                     # leader / valid
    consensus_data: dict


def z_score(value: float, mean: float, stddev: float) -> float:
    if stddev <= 0:
        return 0.0
    return (value - mean) / stddev


def run_statistical_checks(
    pu: PUTurnout,
    *,
    ward_dist: PeerDistribution | None,
    lga_dist: PeerDistribution | None,
    submission_id: UUID | None = None,
    z_threshold: float = DEFAULT_Z_THRESHOLD,
) -> list[AnomalyHit]:
    hits: list[AnomalyHit] = []

    def hit(t: AnomalyType, sev: Severity, **details) -> None:
        hits.append(
            AnomalyHit(
                pu_code=pu.pu_code,
                election_id=pu.election_id,
                anomaly_type=t,
                severity=sev,
                submission_id=submission_id,
                details=details,
            )
        )

    # ── Ward-level turnout outlier ───────────────────────────────────
    if ward_dist and ward_dist.n >= 5 and ward_dist.stddev > 0:
        z = z_score(pu.turnout, ward_dist.mean, ward_dist.stddev)
        if abs(z) >= z_threshold:
            sev = Severity.CRITICAL if abs(z) >= 5 else (
                Severity.HIGH if abs(z) >= 4 else Severity.MEDIUM
            )
            hit(
                AnomalyType.TURNOUT_OUTLIER_WARD,
                sev,
                z_score=round(z, 2),
                pu_turnout=round(pu.turnout, 4),
                ward_mean=round(ward_dist.mean, 4),
                ward_stddev=round(ward_dist.stddev, 4),
                ward_n=ward_dist.n,
            )

    # ── LGA-level turnout outlier (only when no ward signal already
    #    fired; avoid double-flagging the same PU for the same shape) ─
    elif lga_dist and lga_dist.n >= 10 and lga_dist.stddev > 0:
        z = z_score(pu.turnout, lga_dist.mean, lga_dist.stddev)
        if abs(z) >= z_threshold:
            sev = Severity.HIGH if abs(z) >= 4 else Severity.MEDIUM
            hit(
                AnomalyType.TURNOUT_OUTLIER_LGA,
                sev,
                z_score=round(z, 2),
                pu_turnout=round(pu.turnout, 4),
                lga_mean=round(lga_dist.mean, 4),
                lga_stddev=round(lga_dist.stddev, 4),
                lga_n=lga_dist.n,
            )

    return hits


def run_leader_share_check(
    pu: PUTurnout,
    *,
    ward_leader_shares: list[float],
    submission_id: UUID | None = None,
    z_threshold: float = DEFAULT_Z_THRESHOLD,
) -> list[AnomalyHit]:
    """Same idea for leader-share. A PU where one party gets 92% while
    every neighbour in the ward splits ~40/40/20 is suspect even when
    the absolute share isn't extreme enough to trip the sanity check."""
    if len(ward_leader_shares) < 5:
        return []
    n = len(ward_leader_shares)
    mean = sum(ward_leader_shares) / n
    variance = sum((x - mean) ** 2 for x in ward_leader_shares) / n
    stddev = variance ** 0.5
    if stddev <= 0:
        return []

    z = z_score(pu.leader_share, mean, stddev)
    if abs(z) < z_threshold:
        return []

    sev = Severity.CRITICAL if abs(z) >= 5 else (
        Severity.HIGH if abs(z) >= 4 else Severity.MEDIUM
    )
    return [
        AnomalyHit(
            pu_code=pu.pu_code,
            election_id=pu.election_id,
            anomaly_type=AnomalyType.LEADER_SHARE_OUTLIER_WARD,
            severity=sev,
            submission_id=submission_id,
            details={
                "z_score": round(z, 2),
                "pu_leader_share": round(pu.leader_share, 4),
                "ward_mean": round(mean, 4),
                "ward_stddev": round(stddev, 4),
                "ward_n": n,
            },
        )
    ]
