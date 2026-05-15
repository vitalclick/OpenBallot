"""Common types for the anomaly module."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any
from uuid import UUID


class AnomalyType(str, Enum):
    VOTES_EXCEED_REGISTERED = "votes_exceed_registered"
    TURNOUT_EXCEEDS_ACCREDITATION = "turnout_exceeds_accreditation"
    REJECTED_EXCEEDS_CAST = "rejected_exceeds_cast"
    LEADER_EXTREME_SHARE = "leader_extreme_share"
    ZERO_REGISTERED_VOTERS = "zero_registered_voters"
    CAST_ZERO_BUT_VOTES_RECORDED = "cast_zero_but_votes_recorded"

    TURNOUT_OUTLIER_WARD = "turnout_outlier_ward"
    TURNOUT_OUTLIER_LGA = "turnout_outlier_lga"
    LEADER_SHARE_OUTLIER_WARD = "leader_share_outlier_ward"

    TURNOUT_SHIFT_VS_2023 = "turnout_shift_vs_2023"
    LEADER_PARTY_SHIFT_VS_2023 = "leader_party_shift_vs_2023"


class Severity(int, Enum):
    """1 (curiosity) to 5 (almost-certainly fraudulent).

    The severity influences:
      * map overlay weight (5 always renders)
      * escalation cadence (4+ pages the on-call rota)
      * publish priority on the anomaly register
    """
    INFO       = 1
    LOW        = 2
    MEDIUM     = 3
    HIGH       = 4
    CRITICAL   = 5


@dataclass
class AnomalyHit:
    """One detected anomaly. Multiple hits per submission are normal."""

    pu_code: str
    election_id: str
    anomaly_type: AnomalyType
    severity: Severity
    details: dict[str, Any] = field(default_factory=dict)
    submission_id: UUID | None = None

    def as_db_row(self) -> dict[str, Any]:
        return {
            "pu_code": self.pu_code,
            "election_id": self.election_id,
            "anomaly_type": self.anomaly_type.value,
            "severity": int(self.severity),
            "details": self.details,
            "submission_id": self.submission_id,
        }
