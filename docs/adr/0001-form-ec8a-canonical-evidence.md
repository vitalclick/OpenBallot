# ADR-0001: Form EC8A is the canonical evidence

- **Status**: Accepted
- **Date**: 2026-01-15
- **Deciders**: Founding consortium

## Context

Nigerian election disputes are decided on documentary evidence. The
EC8A — the polling-unit-level result sheet signed by the Presiding
Officer and party agents — is the primary exhibit in every
post-election tribunal and Supreme Court case. The IReV portal
publishes scanned EC8As, but the numbers shown alongside them on
public sites are typed-in tallies that diverge from the scans more
often than the public realises (Rivers 2023 being the documented
case).

We needed to decide whether OpenBallot is:
  (a) a numbers-first platform that displays tallies and links to
      source documents as a courtesy, or
  (b) a document-first platform where every number IS the document.

## Decision

**The form is the data. The platform never displays a number without
the EC8A it was extracted from.**

This is non-negotiable: there is no admin path that publishes a number
detached from its underlying image. Even consensus values point at
the source images they were averaged from.

## Alternatives considered

- **Trust INEC's typed totals**: rejected. The Rivers-2023 divergence
  proves typed totals are not authoritative even when they come from
  INEC. We must read the source document.
- **Show the typed totals with a link to the EC8A**: rejected.
  Citizens read the headline number and ignore the link. Putting the
  image alongside is a different design pattern; putting it BEHIND
  is the wrong incentive.
- **Build our own typed-entry workflow with two-person checking**:
  rejected. We cannot match the AI extraction's throughput; we
  introduce a manual entry surface that's itself vulnerable; and we
  lose the property that "the form is the data".

## Consequences

**Easy**: every claim on the platform has an evidence link. Audit is
straightforward.

**Hard**: storage cost (~180 GB per ballot at 1 MB/image), CDN cost,
and OCR cost (~$0.05/page through Document AI).

**Locked-in**: any future feature that wants to display aggregate
values has to provide an evidence trail. Aggregate dashboards that
hide source images are explicitly disallowed.

## References

- 2023 BBC analysis of Rivers state EC8As vs declared totals
- INEC IReV portal architecture
