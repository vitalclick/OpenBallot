#!/usr/bin/env python3
"""Load the FOIA'd 2023 presidential results at LGA level (issue #73).

The missing middle rung between the national total and the per-polling-unit
baseline. With it, summing polling units into their LGA localises any
disagreement to roughly 230 units instead of 176,846.

These are **official INEC figures**, obtained under a Freedom of Information
Act request answered eight months later -- unlike the per-PU baseline, which
is a third-party reading of scanned forms. Loaded into their own reference
table (migration 0019), not into ``verified_results``.

Name matching
-------------
The source keys rows by LGA name, not code, so names must be matched to the
registry. Matching reuses ``scripts/reconcile_ward_names.normalise`` and its
``LGA_NAME_ALIASES`` map, which is the same machinery the ward-boundary
reconciliation uses -- one place to fix a name, not two.

**Every one of the 774 rows must resolve.** An unmatched row is not skipped
with a warning: the run aborts. A partial LGA table is worse than none, since
a reconciliation report built on it would show phantom shortfalls in whichever
LGAs silently failed to load, and those would look exactly like missing votes.

Four parties only
-----------------
The source carries APC, PDP, LP and NNPP. Those took 99.4% of the valid vote,
but a sum across this table is a four-party total and falls roughly 570k short
of the national valid-vote figure -- the 14 minor parties. The loader reports
that gap rather than leaving someone to rediscover it as an apparent error.

Usage::

    DATABASE_URL=postgresql://... python scripts/load_2023_lga_results.py \\
        --results data/pu-enrichment-2023/lga_results_2023.csv

    # Reconcile the per-PU baseline against these figures:
    DATABASE_URL=... python scripts/load_2023_lga_results.py \\
        --results ... --reconcile

Requires migration 0019.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from reconcile_ward_names import LGA_NAME_ALIASES, normalise  # noqa: E402

PARTIES = ("APC", "PDP", "LP", "NNPP")

DEFAULT_ELECTION_ID = "2023-presidential"
DEFAULT_SOURCE = "inec_foia_2023"

# National valid votes, all 18 parties (INEC report Annexure 2, via
# data/election-results-2023/presidential_national.json).
NATIONAL_VALID_VOTES = 24_025_940
NATIONAL_FOUR_PARTY = 8_794_726 + 6_984_520 + 6_101_533 + 1_496_687


@dataclass(frozen=True)
class LGAResult:
    state_name: str
    lga_name: str
    votes: dict[str, int]


def parse_votes(raw: str | None) -> int | None:
    text = (raw or "").strip().replace(",", "")
    if not text:
        return None
    try:
        value = int(float(text))
    except ValueError:
        return None
    return value if value >= 0 else None


def read_results(path: Path) -> tuple[list[LGAResult], list[tuple[str, str, str]]]:
    """Returns (rows, problems). A problem is (state, lga, reason)."""
    rows: list[LGAResult] = []
    problems: list[tuple[str, str, str]] = []

    with path.open(newline="") as f:
        for raw in csv.DictReader(f):
            state = (raw.get("State") or "").strip()
            lga = (raw.get("LGA") or "").strip()
            if not state or not lga:
                problems.append((state, lga, "missing_state_or_lga"))
                continue

            votes = {p: parse_votes(raw.get(p)) for p in PARTIES}
            missing = [p for p, v in votes.items() if v is None]
            if missing:
                problems.append((state, lga, f"missing_votes:{','.join(missing)}"))
                continue

            rows.append(
                LGAResult(state_name=state, lga_name=lga,
                          votes={p: v for p, v in votes.items() if v is not None})
            )

    return rows, problems


def match_lga(
    result: LGAResult,
    by_name: dict[tuple[str, str], tuple[str, str]],
) -> tuple[str, str] | None:
    """Resolve one row to (lga_code, state_code), or None.

    ``by_name`` maps (normalised state, normalised LGA) -> (lga_code,
    state_code). Tries the plain normalised name first, then the shared alias
    map, which is keyed by the two-letter state code.
    """
    state_key = normalise(result.state_name)
    lga_key = normalise(result.lga_name)

    direct = by_name.get((state_key, lga_key))
    if direct:
        return direct

    for (state_code, alias_from), alias_to in LGA_NAME_ALIASES.items():
        if alias_from != lga_key:
            continue
        candidate = by_name.get((state_key, normalise(alias_to)))
        if candidate and candidate[1] == state_code:
            return candidate

    return None


def connect(url: str):
    import psycopg2

    return psycopg2.connect(url, connect_timeout=15)


def fetch_lga_index(cur) -> dict[tuple[str, str], tuple[str, str]]:
    cur.execute(
        "SELECT l.code, l.name, l.state_code, s.name "
        "FROM lgas l JOIN states s ON s.code = l.state_code"
    )
    return {
        (normalise(state_name), normalise(lga_name)): (lga_code, state_code)
        for lga_code, lga_name, state_code, state_name in cur.fetchall()
    }


def upsert(cur, rows: list[tuple]) -> None:
    import psycopg2.extras

    psycopg2.extras.execute_batch(
        cur,
        """
        INSERT INTO presidential_2023_lga_results
            (election_id, lga_code, party_code, votes, source)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (election_id, lga_code, party_code) DO UPDATE
           SET votes = EXCLUDED.votes,
               source = EXCLUDED.source,
               loaded_at = NOW()
        """,
        rows,
        page_size=500,
    )


def reconcile(cur, election_id: str) -> None:
    """Compare the per-PU baseline against these official LGA figures.

    This is the whole point of the middle rung, so the report is the
    deliverable, not a debug aid.
    """
    print("\n" + "=" * 72)
    print("Reconciliation: per-PU baseline vs official LGA figures")
    print("=" * 72)

    cur.execute(
        """
        WITH pu_sums AS (
            SELECT pu.lga_code,
                   count(*) AS n_units,
                   sum((vr.consensus_data->'candidate_votes'->>'APC')::numeric) AS apc,
                   sum((vr.consensus_data->'candidate_votes'->>'PDP')::numeric) AS pdp,
                   sum((vr.consensus_data->'candidate_votes'->>'LP')::numeric)  AS lp,
                   sum((vr.consensus_data->'candidate_votes'->>'NNPP')::numeric) AS nnpp
              FROM verified_results vr
              JOIN polling_units pu ON pu.pu_code = vr.pu_code
             WHERE vr.election_id = %s AND vr.consensus_data IS NOT NULL
             GROUP BY pu.lga_code
        ),
        official AS (
            SELECT lga_code,
                   sum(votes) FILTER (WHERE party_code='APC')  AS apc,
                   sum(votes) FILTER (WHERE party_code='PDP')  AS pdp,
                   sum(votes) FILTER (WHERE party_code='LP')   AS lp,
                   sum(votes) FILTER (WHERE party_code='NNPP') AS nnpp
              FROM presidential_2023_lga_results
             WHERE election_id = %s
             GROUP BY lga_code
        )
        SELECT count(*) AS lgas_compared,
               sum(p.apc + p.pdp + p.lp + p.nnpp)  AS pu_total,
               sum(o.apc + o.pdp + o.lp + o.nnpp)  AS official_total,
               sum(p.n_units)                       AS units_counted
          FROM pu_sums p JOIN official o ON o.lga_code = p.lga_code
        """,
        (election_id, election_id),
    )
    row = cur.fetchone()
    lgas, pu_total, off_total, units = row
    if not lgas or pu_total is None:
        print("  no overlap to compare (load the per-PU baseline first)")
        return

    pu_total, off_total = int(pu_total), int(off_total)
    print(f"  LGAs compared:            {lgas:,}")
    print(f"  polling units summed:     {units:,}")
    print(f"  four-party votes, per-PU: {pu_total:,}")
    print(f"  four-party votes, FOIA:   {off_total:,}")
    print(
        f"  coverage:                 {pu_total / off_total:.1%} of the official"
        " four-party total"
    )
    print(
        "\n  The per-PU baseline is deliberately incomplete -- unreadable forms are\n"
        "  absent rather than zero-filled -- so a shortfall here is expected. What\n"
        "  matters is that no LGA shows an EXCESS: more votes summed from polling\n"
        "  units than INEC says the LGA cast."
    )

    cur.execute(
        """
        WITH pu_sums AS (
            SELECT pu.lga_code,
                   sum((vr.consensus_data->'candidate_votes'->>'APC')::numeric
                     + (vr.consensus_data->'candidate_votes'->>'PDP')::numeric
                     + (vr.consensus_data->'candidate_votes'->>'LP')::numeric
                     + (vr.consensus_data->'candidate_votes'->>'NNPP')::numeric) AS total
              FROM verified_results vr
              JOIN polling_units pu ON pu.pu_code = vr.pu_code
             WHERE vr.election_id = %s AND vr.consensus_data IS NOT NULL
             GROUP BY pu.lga_code
        ),
        official AS (
            SELECT lga_code, sum(votes) AS total
              FROM presidential_2023_lga_results
             WHERE election_id = %s GROUP BY lga_code
        )
        SELECT l.name, l.state_code, p.total::bigint, o.total::bigint,
               (p.total - o.total)::bigint AS excess
          FROM pu_sums p
          JOIN official o ON o.lga_code = p.lga_code
          JOIN lgas l ON l.code = p.lga_code
         WHERE p.total > o.total
         ORDER BY excess DESC
         LIMIT 10
        """,
        (election_id, election_id),
    )
    excesses = cur.fetchall()
    if not excesses:
        print("\n  No LGA exceeds its official total. ")
    else:
        print(f"\n  {len(excesses)} LGA(s) exceed their official total:")
        print(f"    {'LGA':28s} {'per-PU':>10s} {'official':>10s} {'excess':>9s}")
        for name, state_code, pu_t, off_t, excess in excesses:
            print(f"    {name[:26]:28s} {pu_t:>10,} {off_t:>10,} {excess:>9,}"
                  f"  ({state_code})")
        print(
            "\n  An excess means the polling units we can read already report more\n"
            "  votes than INEC says the whole LGA cast. That is a genuine finding:\n"
            "  either the extraction is wrong for those units, or the official\n"
            "  figure is."
        )

    minor = NATIONAL_VALID_VOTES - NATIONAL_FOUR_PARTY
    print(
        f"\n  Reminder: this table is four-party only. Nationally the other 14\n"
        f"  parties took {minor:,} votes ({minor / NATIONAL_VALID_VOTES:.1%} of valid\n"
        f"  votes), which will never appear in any sum over this table."
    )


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--results", required=True, type=Path)
    p.add_argument("--election-id", default=DEFAULT_ELECTION_ID)
    p.add_argument("--source", default=DEFAULT_SOURCE)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument(
        "--reconcile",
        action="store_true",
        help="after loading, compare the per-PU baseline against these figures",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if not args.results.is_file():
        print(f"results not found: {args.results}", file=sys.stderr)
        return 2
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL not set", file=sys.stderr)
        return 2

    print(f"Reading {args.results}")
    rows, problems = read_results(args.results)
    print(f"  {len(rows):,} LGA rows, {len(problems)} unparseable")
    for state, lga, reason in problems[:10]:
        print(f"    {state} / {lga}: {reason}", file=sys.stderr)

    conn = connect(url)
    conn.autocommit = False
    try:
        cur = conn.cursor()
        index = fetch_lga_index(cur)
        print(f"  registry holds {len(index):,} LGAs")

        resolved: list[tuple] = []
        unmatched: list[LGAResult] = []
        for r in rows:
            hit = match_lga(r, index)
            if hit is None:
                unmatched.append(r)
                continue
            lga_code, _ = hit
            for party, votes in r.votes.items():
                resolved.append(
                    (args.election_id, lga_code, party, votes, args.source)
                )

        matched_lgas = len(resolved) // len(PARTIES) if resolved else 0
        print(f"  matched {matched_lgas:,} of {len(rows):,} LGAs")

        if unmatched or problems:
            print(
                f"\nABORTING: {len(unmatched)} LGA name(s) did not resolve and"
                f" {len(problems)} row(s) were unparseable.\nEvery one of the 774"
                " rows must load: a partial LGA table would show phantom\nshortfalls"
                " in the reconciliation report, indistinguishable from missing"
                " votes.\nAdd an entry to LGA_NAME_ALIASES in"
                " scripts/reconcile_ward_names.py for each:",
                file=sys.stderr,
            )
            for r in unmatched[:20]:
                print(
                    f'  ("{r.state_name}", "{normalise(r.lga_name)}") -> ?',
                    file=sys.stderr,
                )
            return 3

        if not args.dry_run:
            upsert(cur, resolved)
        print(f"  wrote {len(resolved):,} rows ({matched_lgas:,} LGAs x {len(PARTIES)})")

        if args.reconcile:
            reconcile(cur, args.election_id)

        if args.dry_run:
            conn.rollback()
            print("\nDry run: rolled back, nothing written.")
        else:
            conn.commit()
            print("\nCommitted.")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
