#!/usr/bin/env python3
"""Load the extracted 2023 official results into Postgres (migration 0015).

Reads the files produced by ``scripts/extract_2023_results.py`` from
``data/election-results-2023/`` and upserts them into the official-results
tables:

    presidential_national.json -> presidential_2023_results + _summary
    declared_winners.csv       -> declared_winners_2023
    state_registration.csv     -> state_registration_2023

All writes are idempotent (``ON CONFLICT ... DO UPDATE``), so re-runs are safe.

Because ``declared_winners_2023.state_code`` and ``state_registration_2023``
reference ``states(code)``, the geography must already be loaded
(``scripts/load_polling_units.py``). On a partial DB (e.g. the 4-state dev
seed) rows for absent states are skipped with a warning rather than aborting.

Usage::

    DATABASE_URL=postgresql://... python scripts/load_2023_results.py
    DATABASE_URL=... python scripts/load_2023_results.py --data path/to/dir
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras


def _int_or_none(v: str | int | None):
    if v is None or v == "":
        return None
    return int(v)


def load_presidential(cur, data_dir: Path) -> tuple[int, int]:
    payload = json.loads((data_dir / "presidential_national.json").read_text())
    eid = payload["election_id"]

    rows = [
        (eid, c["party_code"], c["candidate_name"], c["votes"],
         bool(c["elected"]), c["display_order"])
        for c in payload["candidates"]
    ]
    psycopg2.extras.execute_values(
        cur,
        """
        INSERT INTO presidential_2023_results
          (election_id, party_code, candidate_name, votes, elected, display_order)
        VALUES %s
        ON CONFLICT (election_id, party_code) DO UPDATE SET
          candidate_name = EXCLUDED.candidate_name,
          votes          = EXCLUDED.votes,
          elected        = EXCLUDED.elected,
          display_order  = EXCLUDED.display_order
        """,
        rows,
    )

    s = payload["summary"]
    cur.execute(
        """
        INSERT INTO presidential_2023_summary
          (election_id, registered_voters, collected_pvcs, accredited_voters,
           votes_cast, valid_votes, rejected_votes, turnout_pct)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (election_id) DO UPDATE SET
          registered_voters = EXCLUDED.registered_voters,
          collected_pvcs    = EXCLUDED.collected_pvcs,
          accredited_voters = EXCLUDED.accredited_voters,
          votes_cast        = EXCLUDED.votes_cast,
          valid_votes       = EXCLUDED.valid_votes,
          rejected_votes    = EXCLUDED.rejected_votes,
          turnout_pct       = EXCLUDED.turnout_pct
        """,
        (eid, s["registered_voters"], s["collected_pvcs"], s["accredited_voters"],
         s["votes_cast"], s["valid_votes"], s["rejected_votes"], s["turnout_pct"]),
    )
    return len(rows), 1


def load_declared_winners(cur, data_dir: Path, known_states: set[str]) -> tuple[int, int]:
    rows, skipped = [], 0
    with (data_dir / "declared_winners.csv").open() as fh:
        for r in csv.DictReader(fh):
            if r["state_code"] not in known_states:
                skipped += 1
                continue
            rows.append((
                r["election_id"], r["race"], int(r["seq"]),
                r["constituency_code"], r["constituency_name"] or None,
                r["state_code"],
                _int_or_none(r["n_lgas"]), _int_or_none(r["n_ras"]),
                _int_or_none(r["n_pus"]),
                r["party_code"] or None, r["candidate_name"] or None,
            ))
    psycopg2.extras.execute_values(
        cur,
        """
        INSERT INTO declared_winners_2023
          (election_id, race, seq, constituency_code, constituency_name,
           state_code, n_lgas, n_ras, n_pus, party_code, candidate_name)
        VALUES %s
        ON CONFLICT (election_id, seq) DO UPDATE SET
          race              = EXCLUDED.race,
          constituency_code = EXCLUDED.constituency_code,
          constituency_name = EXCLUDED.constituency_name,
          state_code        = EXCLUDED.state_code,
          n_lgas            = EXCLUDED.n_lgas,
          n_ras             = EXCLUDED.n_ras,
          n_pus             = EXCLUDED.n_pus,
          party_code        = EXCLUDED.party_code,
          candidate_name    = EXCLUDED.candidate_name
        """,
        rows,
    )
    return len(rows), skipped


def load_registration(cur, data_dir: Path, known_states: set[str]) -> tuple[int, int]:
    rows, skipped = [], 0
    with (data_dir / "state_registration.csv").open() as fh:
        for r in csv.DictReader(fh):
            if r["state_code"] not in known_states:
                skipped += 1
                continue
            rows.append((r["state_code"], int(r["male"]), int(r["female"]),
                         int(r["total"])))
    psycopg2.extras.execute_values(
        cur,
        """
        INSERT INTO state_registration_2023 (state_code, male, female, total)
        VALUES %s
        ON CONFLICT (state_code) DO UPDATE SET
          male = EXCLUDED.male, female = EXCLUDED.female, total = EXCLUDED.total
        """,
        rows,
    )
    return len(rows), skipped


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", default="data/election-results-2023")
    args = ap.parse_args()

    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL not set", file=sys.stderr)
        return 2

    data_dir = Path(args.data)
    if not data_dir.is_dir():
        print(f"data dir not found: {data_dir} "
              "(run scripts/extract_2023_results.py first)", file=sys.stderr)
        return 2

    conn = psycopg2.connect(
        url, keepalives=1, keepalives_idle=30, keepalives_interval=10,
        keepalives_count=5, connect_timeout=15,
    )
    conn.autocommit = False
    try:
        cur = conn.cursor()
        cur.execute("SELECT code FROM states")
        known_states = {row[0] for row in cur.fetchall()}
        if len(known_states) < 37:
            print(f"warning: only {len(known_states)} states in DB; rows for "
                  "absent states will be skipped (load geography first for the "
                  "full dataset).", file=sys.stderr)

        pres_n, summ_n = load_presidential(cur, data_dir)
        win_n, win_skip = load_declared_winners(cur, data_dir, known_states)
        reg_n, reg_skip = load_registration(cur, data_dir, known_states)

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    print("Loaded 2023 official results:")
    print(f"  presidential_2023_results  : {pres_n} parties")
    print(f"  presidential_2023_summary  : {summ_n} row")
    print(f"  declared_winners_2023      : {win_n} winners"
          + (f" ({win_skip} skipped: state not in DB)" if win_skip else ""))
    print(f"  state_registration_2023    : {reg_n} states"
          + (f" ({reg_skip} skipped: state not in DB)" if reg_skip else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
