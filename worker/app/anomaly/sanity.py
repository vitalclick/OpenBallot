"""Per-PU sanity (impossibility) checks.

These run inline on every accepted submission. The checks are
deterministic and need only the submission's own extracted data - no
peer distribution, no historical baseline.

Each check returns at most one AnomalyHit. The function returns the
combined list. Callers persist the hits to the `anomalies` table.

The thresholds are deliberately conservative so they fire ONLY on
clearly-implausible figures. The intent is high precision (very few
false positives) rather than high recall - statistical and historical
detectors handle the subtler signals.
"""

from __future__ import annotations

from uuid import UUID

from ..models import ExtractedEC8A
from .types import AnomalyHit, AnomalyType, Severity


# Threshold for the "single party dominates" check. The 2023 Rivers
# Eleme/Andoni election tribunal record shows several PUs with 99.6%+
# for one party; that's the bar we want to flag.
LEADER_EXTREME_SHARE_THRESHOLD = 0.97


def run_sanity_checks(
    extracted: ExtractedEC8A,
    *,
    election_id: str,
    submission_id: UUID | None = None,
) -> list[AnomalyHit]:
    hits: list[AnomalyHit] = []

    def hit(t: AnomalyType, sev: Severity, **details) -> None:
        hits.append(
            AnomalyHit(
                pu_code=extracted.pu_code,
                election_id=election_id,
                anomaly_type=t,
                severity=sev,
                submission_id=submission_id,
                details=details,
            )
        )

    # ── Impossibility checks (severity 5 - the form claims something
    #    that physically cannot be true) ───────────────────────────────
    cast = extracted.total_votes_cast
    valid = extracted.total_valid_votes
    rejected = extracted.rejected_ballots
    registered = extracted.registered_voters
    accredited = extracted.accredited_voters

    if registered > 0 and cast > registered:
        hit(
            AnomalyType.VOTES_EXCEED_REGISTERED,
            Severity.CRITICAL,
            registered=registered,
            cast=cast,
            excess=cast - registered,
        )

    if accredited > 0 and cast > accredited:
        hit(
            AnomalyType.TURNOUT_EXCEEDS_ACCREDITATION,
            Severity.CRITICAL,
            accredited=accredited,
            cast=cast,
            excess=cast - accredited,
        )

    if rejected > cast and cast > 0:
        hit(
            AnomalyType.REJECTED_EXCEEDS_CAST,
            Severity.CRITICAL,
            cast=cast,
            rejected=rejected,
        )

    if cast == 0 and valid > 0:
        hit(
            AnomalyType.CAST_ZERO_BUT_VOTES_RECORDED,
            Severity.CRITICAL,
            valid=valid,
        )

    # ── Data-quality flag ────────────────────────────────────────────
    if registered == 0:
        # Zero-registered PUs are a data-entry error on the EC8A; the
        # platform should flag rather than silently ingest.
        hit(
            AnomalyType.ZERO_REGISTERED_VOTERS,
            Severity.HIGH,
        )

    # ── Extreme leader share ─────────────────────────────────────────
    if valid > 30 and extracted.candidate_votes:
        leader_votes = max(extracted.candidate_votes.values())
        share = leader_votes / valid
        if share >= LEADER_EXTREME_SHARE_THRESHOLD:
            leader_party = max(
                extracted.candidate_votes,
                key=lambda p: extracted.candidate_votes[p],
            )
            hit(
                AnomalyType.LEADER_EXTREME_SHARE,
                Severity.HIGH,
                leader=leader_party,
                share=round(share, 4),
                leader_votes=leader_votes,
                total_valid=valid,
            )

    return hits
