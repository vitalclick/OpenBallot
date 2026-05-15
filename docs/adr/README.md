# Architecture Decision Records

These are the consequential decisions in the OpenBallot Nigeria
platform. Each ADR records the choice, the alternatives we
considered, and the reasoning. They are immutable - if a decision is
later reversed, a new ADR supersedes the old one rather than editing
history.

Numbering is by date order, not by importance. Cross-references in
text are by ADR number (e.g. "see ADR-0004").

| # | Title | Status |
|---|---|---|
| 0001 | Form EC8A is the canonical evidence | Accepted |
| 0002 | Multi-source consensus over single-source declarations | Accepted |
| 0003 | SQL-trigger-enforced audit chain | Accepted |
| 0004 | Ethereum mainnet for anchor publication | Accepted |
| 0005 | Async ingestion via Redis-backed job queue | Accepted |
| 0006 | Presigned direct-to-storage uploads (no proxying) | Accepted |
| 0007 | Document AI primary + GPT-4o Vision fallback | Accepted |
| 0008 | Three-layer anomaly detection | Accepted |
| 0009 | AGPL-3.0 licence | Accepted |
| 0010 | Per-install device fingerprinting for agent JWTs | Accepted |

## How to add an ADR

Copy `_template.md` to `NNNN-short-slug.md`, fill it in, add the row
to the table above in the same PR. ADRs are never edited after
acceptance except to mark Status = Superseded with a link to the
replacement.
