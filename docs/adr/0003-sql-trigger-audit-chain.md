# ADR-0003: SQL-trigger-enforced audit chain

- **Status**: Accepted
- **Date**: 2026-01-20
- **Deciders**: Technical lead, security reviewer

## Context

The audit log must be tamper-evident: anyone with access to the
database — including an insider — must be unable to rewrite history
without breaking the chain. We considered three places to enforce the
chained-hash invariant:

  (1) Application layer: every code path writes the hash.
  (2) Database trigger: the trigger computes the hash on INSERT.
  (3) External: write through a separate service that holds the chain.

## Decision

**The hash chain is computed by a Postgres BEFORE INSERT trigger
(`fn_audit_chain_link`) on the `audit_log` table.** Application code
inserts the (event_type, entity_id, event_data) fields; the trigger
fills in `prev_hash` and `log_hash` atomically inside the same row's
INSERT.

The chain rule is:
```
log_hash = SHA256(prev_hash || event_type || entity_type ||
                  entity_id || actor || event_at || canonical_event_data)
```

UPDATE and DELETE are revoked at the role level. RLS policies deny
both. The Python verifier (`worker/app/audit/chain.py`) computes the
identical hash so the chain can be re-verified end-to-end without
trusting the database.

## Alternatives considered

- **Application-layer chaining**: rejected. Any code path that
  forgets to chain breaks the chain. A developer mistake compromises
  the trust property.
- **External chain service**: rejected. Introduces a separate
  availability target on the write path; an outage of the chain
  service either stops writes or breaks the invariant.

## Consequences

**Easy**: the chain CAN'T be skipped. Even a buggy worker insert is
chained because the trigger fires before the row lands.

**Hard**: the canonical string concatenation must match exactly
between SQL and the Python verifier. Migration 0002 documents the
byte order explicitly so the two implementations stay in sync. A
parity test (`test_audit_chain.py::test_python_matches_sql_genesis`)
catches drift.

**Locked-in**: any change to the chain rule requires a coordinated
upgrade across the trigger + the Python verifier + the
standalone-auditor script (`scripts/verify_audit_chain.py`). We will
not change the rule lightly.

## References

- `db/migrations/0002_audit_chain.sql` - the trigger
- `worker/app/audit/chain.py` - the Python verifier
- `scripts/verify_audit_chain.py` - the zero-dep standalone verifier
- `worker/tests/test_audit_chain.py` - cross-implementation tests
