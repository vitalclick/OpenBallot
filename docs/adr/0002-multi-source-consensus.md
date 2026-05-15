# ADR-0002: Multi-source consensus over single-source declarations

- **Status**: Accepted
- **Date**: 2026-01-15
- **Deciders**: Founding consortium + technical lead

## Context

Every published number for a polling unit must be defensible against
the question "who said?". A single-source declaration is only as
trustworthy as that one source. An adversary who compromises any
single source (the publisher's typed-entry desk, INEC's upload
process, one party's submission flow) compromises the headline result.

## Decision

**A polling unit's status is determined by agreement between at least
two independent sources.** A source is independent if its
infrastructure, identity, and reporting chain are all separate from
every other source:

- Each political party is one source. Two APC agents are NOT two
  sources - their submissions can be coordinated.
- Each accredited observer organisation is one source.
- INEC IReV is one source.

The verification engine emits six possible map states reflecting how
many independent sources have weighed in and whether they agree.

## Alternatives considered

- **Trust INEC, surface inconsistencies as commentary**: this is the
  status quo for every commercial results platform. It is what
  failed in Rivers 2023.
- **Crowdsource from citizens directly (no party / observer
  intermediary)**: rejected because we cannot verify identity at
  scale and adversarial sybil attacks become trivial.
- **Weight sources by reputation**: rejected. Reputation weighting is
  political; we cannot defend our weights in court. Every accredited
  source counts as one.

## Consequences

**Easy**: the algorithm is auditable. The map's state for any unit
is reproducible by anyone with the submissions data.

**Hard**: bootstrapping. A unit with only one source submission shows
`single_source` (or `inec_published` if INEC is that one source).
We must onboard enough parties + observers to make consensus
attainable in practice.

**Locked-in**: we will never publish a "consensus" status based on a
single source. Even if the single source is INEC.

## References

- `worker/app/verification/engine.py` - the implementation
- `worker/tests/test_verification.py` - all six map states exercised
