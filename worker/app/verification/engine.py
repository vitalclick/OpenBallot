"""Multi-source verification engine.

Given the set of EC8A submissions for one polling unit + election, compute
the consensus status:

    no_data         no submissions
    single_source   one source has submitted; nothing to cross-check
    consensus       >=2 distinct sources agree (within tolerance)
    discrepancy     >=2 sources disagree
    inec_confirmed  consensus matches INEC IReV
    inec_conflict   INEC IReV present and disagrees with consensus

Sources are distinct submitting entities - parties, observers, and INEC.
Two agents of the same party are NOT independent sources.

The engine is pure: it takes submissions in, returns a VerificationOutcome.
Persistence is the caller's job. This keeps the algorithm trivially testable.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Iterable
from datetime import UTC, datetime

from ..models import (
    ExtractedEC8A,
    SubmissionRecord,
    SubmissionSource,
    VerificationOutcome,
    VerificationStatus,
)


def _diff_payloads(
    a: ExtractedEC8A, b: ExtractedEC8A, tolerance_votes: int
) -> list[str]:
    """Return list of field names where `a` and `b` disagree beyond tolerance."""
    differing: list[str] = []
    for field in (
        "registered_voters",
        "accredited_voters",
        "total_valid_votes",
        "rejected_ballots",
        "total_votes_cast",
    ):
        if abs(getattr(a, field) - getattr(b, field)) > tolerance_votes:
            differing.append(field)
    parties = set(a.candidate_votes) | set(b.candidate_votes)
    for party in parties:
        if abs(a.candidate_votes.get(party, 0) - b.candidate_votes.get(party, 0)) > tolerance_votes:
            differing.append(f"candidate_votes.{party}")
    if a.presiding_officer_signed != b.presiding_officer_signed:
        differing.append("presiding_officer_signed")
    if a.official_stamp_present != b.official_stamp_present:
        differing.append("official_stamp_present")
    return differing


def _source_key(s: SubmissionRecord) -> str:
    """Identity of an independent source.

    A party agent's source is the party. Observers are independent of each
    other (different orgs), so each gets its own key. INEC IReV is itself a
    distinct source.
    """
    if s.source_type == SubmissionSource.PARTY_AGENT:
        return f"party:{s.party_code or 'unknown'}"
    if s.source_type == SubmissionSource.OBSERVER:
        return f"observer:{s.id}"
    return "inec_irev"


def _consensus_extracted(
    submissions: Iterable[SubmissionRecord],
    tolerance_votes: int,
) -> tuple[ExtractedEC8A | None, list[str]]:
    """Compute the agreed-on payload, or return (None, [differing_fields]).

    Two payloads "agree" if every numeric field is within `tolerance_votes`
    of every other payload, and every boolean field matches exactly.
    """
    payloads: list[ExtractedEC8A] = [s.extracted_data for s in submissions if s.extracted_data]
    if not payloads:
        return None, []

    if len(payloads) == 1:
        return payloads[0], []

    differing: list[str] = []

    def _within(values: list[int]) -> bool:
        return max(values) - min(values) <= tolerance_votes

    # numeric scalars
    for field in (
        "registered_voters",
        "accredited_voters",
        "total_valid_votes",
        "rejected_ballots",
        "total_votes_cast",
    ):
        values = [getattr(p, field) for p in payloads]
        if not _within(values):
            differing.append(field)

    # per-candidate votes
    all_parties = set()
    for p in payloads:
        all_parties.update(p.candidate_votes.keys())
    for party in all_parties:
        values = [p.candidate_votes.get(party, 0) for p in payloads]
        if not _within(values):
            differing.append(f"candidate_votes.{party}")

    # booleans - must match exactly
    for field in (
        "presiding_officer_signed",
        "official_stamp_present",
    ):
        values = {getattr(p, field) for p in payloads}
        if len(values) > 1:
            differing.append(field)

    if differing:
        return None, differing

    # Agreement: return the modal/first payload as the consensus value.
    # When values differ by <= tolerance we take the median for numerics.
    medians: dict[str, int] = {}
    for field in (
        "registered_voters",
        "accredited_voters",
        "total_valid_votes",
        "rejected_ballots",
        "total_votes_cast",
    ):
        sorted_vals = sorted(getattr(p, field) for p in payloads)
        medians[field] = sorted_vals[len(sorted_vals) // 2]

    candidate_medians: dict[str, int] = {}
    for party in all_parties:
        sorted_vals = sorted(p.candidate_votes.get(party, 0) for p in payloads)
        candidate_medians[party] = sorted_vals[len(sorted_vals) // 2]

    sig_count = Counter(p.agent_signatures_detected for p in payloads).most_common(1)[0][0]

    return (
        ExtractedEC8A(
            pu_code=payloads[0].pu_code,
            registered_voters=medians["registered_voters"],
            accredited_voters=medians["accredited_voters"],
            candidate_votes=candidate_medians,
            total_valid_votes=medians["total_valid_votes"],
            rejected_ballots=medians["rejected_ballots"],
            total_votes_cast=medians["total_votes_cast"],
            presiding_officer_signed=payloads[0].presiding_officer_signed,
            agent_signatures_detected=sig_count,
            official_stamp_present=payloads[0].official_stamp_present,
        ),
        [],
    )


def compute_consensus(
    submissions: list[SubmissionRecord],
    *,
    election_id: str,
    pu_code: str,
    min_sources: int = 2,
    tolerance_votes: int = 0,
) -> VerificationOutcome:
    accepted = [s for s in submissions if s.extracted_data is not None]

    if not accepted:
        return VerificationOutcome(
            election_id=election_id,
            pu_code=pu_code,
            status=VerificationStatus.NO_DATA,
            submission_count=0,
            source_count=0,
            consensus_data=None,
            computed_at=datetime.now(UTC),
        )

    by_source: dict[str, list[SubmissionRecord]] = defaultdict(list)
    for s in accepted:
        by_source[_source_key(s)].append(s)

    non_inec_sources = [k for k in by_source if not k.startswith("inec_irev")]
    inec_present = "inec_irev" in by_source

    # INEC IReV is the only source for this PU. Distinct from `single_source`
    # because INEC is the official publisher; this state is the default for
    # the 2023 historical dataset and similar concluded elections.
    if inec_present and not non_inec_sources:
        return VerificationOutcome(
            election_id=election_id,
            pu_code=pu_code,
            status=VerificationStatus.INEC_PUBLISHED,
            submission_count=len(accepted),
            source_count=len(by_source),
            consensus_data=by_source["inec_irev"][0].extracted_data,
            computed_at=datetime.now(UTC),
        )

    # Single non-INEC source (one party agent or one observer).
    if len(non_inec_sources) < min_sources and not inec_present:
        return VerificationOutcome(
            election_id=election_id,
            pu_code=pu_code,
            status=VerificationStatus.SINGLE_SOURCE,
            submission_count=len(accepted),
            source_count=len(by_source),
            consensus_data=accepted[0].extracted_data,
            computed_at=datetime.now(UTC),
        )

    # Cross-source consensus among parties + observers
    independent = [s for s in accepted if not _source_key(s).startswith("inec_irev")]
    consensus, differing = _consensus_extracted(independent, tolerance_votes)

    if consensus is None:
        return VerificationOutcome(
            election_id=election_id,
            pu_code=pu_code,
            status=VerificationStatus.DISCREPANCY,
            submission_count=len(accepted),
            source_count=len(by_source),
            consensus_data=None,
            discrepant_fields=differing,
            computed_at=datetime.now(UTC),
        )

    # Independent consensus exists. Compare to INEC if present.
    if inec_present:
        inec_payload = by_source["inec_irev"][0].extracted_data
        inec_diff = _diff_payloads(consensus, inec_payload, tolerance_votes)
        if inec_diff:
            return VerificationOutcome(
                election_id=election_id,
                pu_code=pu_code,
                status=VerificationStatus.INEC_CONFLICT,
                submission_count=len(accepted),
                source_count=len(by_source),
                consensus_data=consensus,
                discrepant_fields=inec_diff,
                computed_at=datetime.now(UTC),
            )
        return VerificationOutcome(
            election_id=election_id,
            pu_code=pu_code,
            status=VerificationStatus.INEC_CONFIRMED,
            submission_count=len(accepted),
            source_count=len(by_source),
            consensus_data=consensus,
            computed_at=datetime.now(UTC),
        )

    return VerificationOutcome(
        election_id=election_id,
        pu_code=pu_code,
        status=VerificationStatus.CONSENSUS,
        submission_count=len(accepted),
        source_count=len(by_source),
        consensus_data=consensus,
        computed_at=datetime.now(UTC),
    )


class VerificationEngine:
    """Thin wrapper for DI / testability. Exposes the pure function above."""

    def __init__(self, min_sources: int = 2, tolerance_votes: int = 0):
        self.min_sources = min_sources
        self.tolerance_votes = tolerance_votes

    def compute(
        self, submissions: list[SubmissionRecord], *, election_id: str, pu_code: str
    ) -> VerificationOutcome:
        return compute_consensus(
            submissions,
            election_id=election_id,
            pu_code=pu_code,
            min_sources=self.min_sources,
            tolerance_votes=self.tolerance_votes,
        )
