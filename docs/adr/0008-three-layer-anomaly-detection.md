# ADR-0008: Three-layer anomaly detection

- **Status**: Accepted
- **Date**: 2026-04-08
- **Deciders**: Worker lead, security reviewer

## Context

Multi-source consensus (ADR-0002) catches disagreement. It does not
catch the case where every source agrees but the agreed-on numbers
are themselves implausible — votes exceed registered voters, a single
party gets 99.5% in a ward where every neighbour splits evenly,
turnout in 2027 is 4× the same PU's 2023 figure. These are the
documented Rivers-2023 fabrications BEFORE party agents corroborate.

## Decision

**Three independent detection layers, each with a different failure
mode it catches:**

  1. **Sanity** — deterministic per-PU impossibility checks. Runs
     INLINE on every accepted submission. Six checks:
     `votes_exceed_registered`, `turnout_exceeds_accreditation`,
     `rejected_exceeds_cast`, `leader_extreme_share` (≥97%),
     `zero_registered_voters`, `cast_zero_but_votes_recorded`.
  2. **Statistical** — per-PU z-score against ward (fallback LGA)
     turnout distribution. Runs as a batch sweep so peer
     distributions can be pooled.
  3. **Historical** — per-PU comparison against 2023 baseline. Two
     signals: turnout shift ≥40pp, leader-party flip with ≥50pp
     share swing.

Each layer emits anomaly rows independently. A single PU can be
flagged by any combination.

## Alternatives considered

- **Single composite anomaly score**: rejected because the three
  signals catch genuinely different failure modes. A single score
  conflates them and hides which one triggered.
- **ML-based outlier detection**: rejected as the first line. The
  deterministic + z-score layers are explainable; an ML model is
  not. We are open to ML detection as a fourth layer later.
- **Hide anomalies until reviewed**: rejected. The whole platform
  is built around publishing evidence, not curating it.

## Consequences

**Easy**: the algorithm is explainable. A journalist looking at a
red `inec_conflict` PU can see exactly which checks fired and why.

**Hard**: false positives. A genuinely uncontested rural PU may
trigger `leader_extreme_share`; a genuinely high-turnout outlier may
trigger `turnout_outlier_ward`. We accept these because the cost of
a false positive (one extra row in the anomaly register) is much
lower than the cost of a false negative (a fabrication that escapes
the platform).

**Locked-in**: the anomaly enum. Adding a new anomaly type is a
migration; removing one requires a separate migration and a
deprecation note.

## References

- `worker/app/anomaly/sanity.py`
- `worker/app/anomaly/statistical.py`
- `worker/app/anomaly/historical.py`
- `worker/tests/test_anomaly_*.py` - 28 unit tests across the layers
- `db/migrations/0008_anomaly_detection.sql`
