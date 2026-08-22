"""Tests for the audit log hash chain.

The chain must:
  1. Produce stable hashes given the same inputs (determinism)
  2. Detect any tampering with prior events (tamper-evidence)
  3. Match what the Postgres trigger computes (cross-implementation parity)
"""

from datetime import UTC, datetime

from app.audit.chain import GENESIS_HASH, AuditEvent, link_hash, verify_chain
from app.audit.merkle import merkle_root


def _ev(seq: int, prev: str, et: str = "submission.created", data: dict | None = None) -> AuditEvent:
    e = AuditEvent(
        seq=seq,
        event_type=et,
        entity_type="ec8a_submission",
        entity_id=f"sub-{seq}",
        actor_id=None,
        event_at=datetime(2027, 2, 27, 17, 43, 22, tzinfo=UTC),
        event_data=data or {"pu_code": f"25-11-04-{seq:03d}"},
        prev_hash=prev,
    )
    e.log_hash = link_hash(e)
    return e


def test_chain_links_in_order():
    e1 = _ev(1, GENESIS_HASH)
    e2 = _ev(2, e1.log_hash)
    e3 = _ev(3, e2.log_hash)
    ok, broken = verify_chain([e1, e2, e3])
    assert ok is True
    assert broken is None


def test_chain_detects_data_tamper():
    e1 = _ev(1, GENESIS_HASH)
    e2 = _ev(2, e1.log_hash)
    e3 = _ev(3, e2.log_hash)
    # Tamper with e2's data without re-hashing
    e2.event_data = {"pu_code": "TAMPERED"}
    ok, broken = verify_chain([e1, e2, e3])
    assert ok is False
    assert broken == 2


def test_chain_detects_prev_hash_rewrite():
    e1 = _ev(1, GENESIS_HASH)
    e2 = _ev(2, e1.log_hash)
    e3 = _ev(3, e2.log_hash)
    e2.prev_hash = "f" * 64
    ok, broken = verify_chain([e1, e2, e3])
    assert ok is False
    assert broken == 2


def test_merkle_root_empty():
    assert merkle_root([]) == "0" * 64


def test_merkle_root_single_leaf():
    leaf = "a" * 64
    # double-sha of (leaf || leaf) when single odd leaf
    root = merkle_root([leaf])
    # Stable, non-zero, length 64
    assert len(root) == 64
    assert root != "0" * 64


def test_merkle_root_deterministic():
    leaves = [f"{i:064x}" for i in range(7)]
    assert merkle_root(leaves) == merkle_root(leaves)
