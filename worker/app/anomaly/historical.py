"""Historical-baseline anomaly detection.

Compares each 2027 PU's consensus result to the same PU's 2023 figure
(loaded by the IReV scraper). Two signals:

  * `turnout_shift_vs_2023`     - turnout has shifted more than
                                  `turnout_shift_threshold_pp` percentage
                                  points either way.
  * `leader_party_shift_vs_2023`- the winning party flipped AND the
                                  leader's vote share moved by more than
                                  `leader_shift_threshold_pp` points.

The shift thresholds are deliberately generous (40 / 50 pp by default)
so this layer flags only the cases where the historical baseline gives
us strong prior evidence of something being off. Demographic shifts and
genuine political change happen; we are not trying to detect them.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from .types import AnomalyHit, AnomalyType, Severity


DEFAULT_TURNOUT_SHIFT_PP = 40.0     # percentage points
DEFAULT_LEADER_SHIFT_PP = 50.0


@dataclass
class HistoricalBaseline:
    election_id: str                 # e.g. "2023-presidential"
    pu_code: str
    turnout: float                   # 0..1
    leader_party: str
    leader_share: float              # 0..1


@dataclass
class CurrentResult:
    election_id: str                 # e.g. "2027-presidential"
    pu_code: str
    turnout: float
    leader_party: str
    leader_share: float


def run_historical_checks(
    current: CurrentResult,
    baseline: HistoricalBaseline | None,
    *,
    submission_id: UUID | None = None,
    turnout_shift_threshold_pp: float = DEFAULT_TURNOUT_SHIFT_PP,
    leader_shift_threshold_pp: float = DEFAULT_LEADER_SHIFT_PP,
) -> list[AnomalyHit]:
    if baseline is None:
        return []

    hits: list[AnomalyHit] = []

    # Turnout shift (in percentage points, not relative %).
    turnout_shift = abs(current.turnout - baseline.turnout) * 100
    if turnout_shift >= turnout_shift_threshold_pp:
        sev = (
            Severity.CRITICAL if turnout_shift >= 70
            else Severity.HIGH if turnout_shift >= 50
            else Severity.MEDIUM
        )
        hits.append(
            AnomalyHit(
                pu_code=current.pu_code,
                election_id=current.election_id,
                anomaly_type=AnomalyType.TURNOUT_SHIFT_VS_2023,
                severity=sev,
                submission_id=submission_id,
                details={
                    "current_turnout": round(current.turnout, 4),
                    "baseline_turnout": round(baseline.turnout, 4),
                    "baseline_election": baseline.election_id,
                    "shift_pp": round(turnout_shift, 2),
                },
            )
        )

    # Leader-party flip + significant share shift. A party flip on its
    # own is not anomalous (real politics happens). But a flip AND a 60pp
    # leader-share swing is.
    if current.leader_party != baseline.leader_party:
        leader_share_shift = abs(current.leader_share - baseline.leader_share) * 100
        if leader_share_shift >= leader_shift_threshold_pp:
            sev = (
                Severity.CRITICAL if leader_share_shift >= 70
                else Severity.HIGH
            )
            hits.append(
                AnomalyHit(
                    pu_code=current.pu_code,
                    election_id=current.election_id,
                    anomaly_type=AnomalyType.LEADER_PARTY_SHIFT_VS_2023,
                    severity=sev,
                    submission_id=submission_id,
                    details={
                        "current_leader": current.leader_party,
                        "current_share": round(current.leader_share, 4),
                        "baseline_leader": baseline.leader_party,
                        "baseline_share": round(baseline.leader_share, 4),
                        "baseline_election": baseline.election_id,
                        "share_shift_pp": round(leader_share_shift, 2),
                    },
                )
            )

    return hits
