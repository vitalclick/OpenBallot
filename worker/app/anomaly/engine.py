"""Anomaly engine.

Glues the three pure-function detectors to the database. Persists hits
to the `anomalies` table with upsert semantics so re-running the engine
on the same PU does not create duplicates (the table has a unique index
on (election_id, pu_code, anomaly_type, submission_id)).
"""

from __future__ import annotations

import json
import logging
from uuid import UUID

import asyncpg

from ..db import pool
from ..models import ExtractedEC8A
from .historical import CurrentResult, HistoricalBaseline, run_historical_checks
from .sanity import run_sanity_checks
from .statistical import PUTurnout, PeerDistribution, run_statistical_checks
from .types import AnomalyHit

log = logging.getLogger(__name__)


class AnomalyEngine:
    """Orchestrates the three detection layers."""

    def __init__(self, baseline_election_id: str = "2023-presidential"):
        self.baseline_election_id = baseline_election_id

    # ─── Layer 1: sanity (called inline from /v1/ingest) ─────────────────

    async def run_inline_sanity(
        self,
        *,
        extracted: ExtractedEC8A,
        election_id: str,
        submission_id: UUID,
    ) -> list[AnomalyHit]:
        hits = run_sanity_checks(
            extracted, election_id=election_id, submission_id=submission_id
        )
        await self._persist(hits)
        return hits

    # ─── Layer 2: statistical (batch sweep over verified_results) ────────

    async def run_statistical_sweep(self, election_id: str) -> int:
        """Run the statistical detector across every verified PU in the
        election. Returns the count of anomaly rows inserted (excludes
        duplicates that were already on file)."""
        async with pool().acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT vr.pu_code, pu.ward_code, pu.lga_code,
                       vr.consensus_data
                  FROM verified_results vr
                  JOIN polling_units pu ON pu.pu_code = vr.pu_code
                 WHERE vr.election_id = $1
                   AND vr.status IN ('consensus','inec_confirmed','inec_published')
                """,
                election_id,
            )
            ward_dists = await self._load_ward_dists(conn, election_id)
            lga_dists = await self._load_lga_dists(conn, election_id)

            hits: list[AnomalyHit] = []
            for r in rows:
                pu_turnout = _build_pu_turnout(election_id, r)
                if pu_turnout is None:
                    continue
                hits.extend(
                    run_statistical_checks(
                        pu_turnout,
                        ward_dist=ward_dists.get(r["ward_code"]),
                        lga_dist=lga_dists.get(r["lga_code"]),
                    )
                )

            return await self._persist(hits)

    async def _load_ward_dists(
        self, conn: asyncpg.Connection, election_id: str
    ) -> dict[str, PeerDistribution]:
        rows = await conn.fetch(
            "SELECT ward_code, n_units, mean_turnout, stddev_turnout "
            "FROM mv_ward_turnout_dist WHERE election_id = $1",
            election_id,
        )
        return {
            r["ward_code"]: PeerDistribution(
                n=r["n_units"],
                mean=float(r["mean_turnout"] or 0),
                stddev=float(r["stddev_turnout"] or 0),
            )
            for r in rows
        }

    async def _load_lga_dists(
        self, conn: asyncpg.Connection, election_id: str
    ) -> dict[str, PeerDistribution]:
        rows = await conn.fetch(
            "SELECT lga_code, n_units, mean_turnout, stddev_turnout "
            "FROM mv_lga_turnout_dist WHERE election_id = $1",
            election_id,
        )
        return {
            r["lga_code"]: PeerDistribution(
                n=r["n_units"],
                mean=float(r["mean_turnout"] or 0),
                stddev=float(r["stddev_turnout"] or 0),
            )
            for r in rows
        }

    # ─── Layer 3: historical (batch sweep against 2023) ──────────────────

    async def run_historical_sweep(self, election_id: str) -> int:
        async with pool().acquire() as conn:
            # Pull current + matching 2023 baseline in one join.
            rows = await conn.fetch(
                """
                SELECT cur.pu_code,
                       cur.consensus_data AS current_data,
                       base.consensus_data AS baseline_data
                  FROM verified_results cur
                  LEFT JOIN verified_results base
                    ON base.pu_code = cur.pu_code AND base.election_id = $2
                 WHERE cur.election_id = $1
                   AND cur.status IN ('consensus','inec_confirmed')
                   AND base.consensus_data IS NOT NULL
                """,
                election_id,
                self.baseline_election_id,
            )

            hits: list[AnomalyHit] = []
            for r in rows:
                cur_payload = r["current_data"]
                base_payload = r["baseline_data"]
                cur_result = _to_current_result(election_id, r["pu_code"], cur_payload)
                base_result = _to_historical(
                    self.baseline_election_id, r["pu_code"], base_payload
                )
                if cur_result is None or base_result is None:
                    continue
                hits.extend(run_historical_checks(cur_result, base_result))

            return await self._persist(hits)

    # ─── Persistence ────────────────────────────────────────────────────

    async def _persist(self, hits: list[AnomalyHit]) -> int:
        if not hits:
            return 0
        inserted = 0
        async with pool().acquire() as conn:
            for h in hits:
                result = await conn.fetchval(
                    """
                    INSERT INTO anomalies (
                      election_id, pu_code, submission_id,
                      anomaly_type, severity, details
                    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
                    ON CONFLICT (election_id, pu_code, anomaly_type, submission_id)
                      DO NOTHING
                    RETURNING id
                    """,
                    h.election_id,
                    h.pu_code,
                    h.submission_id,
                    h.anomaly_type.value,
                    int(h.severity),
                    json.dumps(h.details),
                )
                if result is not None:
                    inserted += 1
        log.info(
            "anomaly.persist",
            extra={"emitted": len(hits), "inserted": inserted},
        )
        return inserted


# ─── Local helpers ──────────────────────────────────────────────────────────


def _consensus_dict(payload) -> dict | None:
    if isinstance(payload, dict):
        return payload
    if isinstance(payload, str):
        try:
            return json.loads(payload)
        except json.JSONDecodeError:
            return None
    return None


def _build_pu_turnout(election_id: str, row) -> PUTurnout | None:
    data = _consensus_dict(row["consensus_data"])
    if not data:
        return None
    registered = int(data.get("registered_voters") or 0)
    cast = int(data.get("total_votes_cast") or 0)
    valid = int(data.get("total_valid_votes") or 0)
    candidate_votes = data.get("candidate_votes") or {}
    if registered == 0 or not candidate_votes:
        return None
    leader_votes = max(candidate_votes.values()) if candidate_votes else 0
    return PUTurnout(
        pu_code=row["pu_code"],
        election_id=election_id,
        ward_code=row["ward_code"],
        lga_code=row["lga_code"],
        turnout=cast / registered if registered else 0.0,
        leader_share=leader_votes / valid if valid else 0.0,
        consensus_data=data,
    )


def _to_current_result(election_id: str, pu_code: str, payload) -> CurrentResult | None:
    d = _consensus_dict(payload)
    if not d:
        return None
    registered = int(d.get("registered_voters") or 0)
    cast = int(d.get("total_votes_cast") or 0)
    valid = int(d.get("total_valid_votes") or 0)
    votes = d.get("candidate_votes") or {}
    if not votes or registered == 0:
        return None
    leader_party = max(votes, key=lambda k: votes[k])
    return CurrentResult(
        election_id=election_id,
        pu_code=pu_code,
        turnout=cast / registered,
        leader_party=leader_party,
        leader_share=(votes[leader_party] / valid) if valid else 0.0,
    )


def _to_historical(
    election_id: str, pu_code: str, payload
) -> HistoricalBaseline | None:
    d = _consensus_dict(payload)
    if not d:
        return None
    registered = int(d.get("registered_voters") or 0)
    cast = int(d.get("total_votes_cast") or 0)
    valid = int(d.get("total_valid_votes") or 0)
    votes = d.get("candidate_votes") or {}
    if not votes or registered == 0:
        return None
    leader_party = max(votes, key=lambda k: votes[k])
    return HistoricalBaseline(
        election_id=election_id,
        pu_code=pu_code,
        turnout=cast / registered,
        leader_party=leader_party,
        leader_share=(votes[leader_party] / valid) if valid else 0.0,
    )
