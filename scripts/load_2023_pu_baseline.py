#!/usr/bin/env python3
"""Load the 2023 per-polling-unit presidential baseline (issue #67).

``worker/app/anomaly/historical.py`` compares each polling unit's result to
the same unit's 2023 figure. That baseline has never existed:

  * INEC's IReV API does not serve the 2023 presidential election -- zero
    presidential rows, and the presidential ObjectId returns ``data:[]``
    (``scrapers/irev-results/README.md``).
  * The INEC report carries the presidential tally at **national level only**
    (``data/election-results-2023/SOURCES.md``).

So ``run_historical_sweep()`` has returned 0 on every call since it was
written. This loader supplies the missing baseline from third-party
extractions of the EC8A scans.

What gets loaded, and what does not
-----------------------------------
Only polling units with a **complete** reading: registered voters, accredited
voters, a figure for each of the four major parties, and a total. Everything
else is left absent.

That exclusion is the most important behaviour in this script. ``historical.py``
computes::

    turnout_shift = abs(current.turnout - baseline.turnout) * 100

and raises an anomaly at 40 percentage points. A baseline row with zeroes
standing in for "we could not read this form" claims a 2023 turnout of 0%, so
any polling unit that later reports 40% turnout or more registers as a
catastrophic *swing* and fires an anomaly.

Measured against this data: 46,342 of 176,846 rows are incomplete, and 27.8%
of the polling units we can read had 2023 turnout at or above 40%. Zero-filling
would therefore manufacture on the order of **13,000 false anomalies** at
comparable turnout -- on election night, drowning the real signal.

A missing baseline correctly produces no comparison at all:
``run_historical_checks`` returns ``[]`` when the baseline is None.

So: no zero-filling, no interpolation, no "best guess". Absent means absent.

Honesty about what this is
--------------------------
Rows are written with ``status = 'third_party_extraction'`` and a ``source``
label. They are never ``inec_published``: INEC did not publish these. The
source's own measured accuracy is recorded in ``extraction_confidence`` --
for the CCIJ 2023 data that is ~0.85 at document level, which is sound for
baselining and unsound for presentation as a result.

Usage::

    DATABASE_URL=postgresql://... python scripts/load_2023_pu_baseline.py \\
        --results data/pu-enrichment-2023/pu_results_2023.csv

    # See what would load, and the anomaly counts, without writing:
    DATABASE_URL=... python scripts/load_2023_pu_baseline.py \\
        --results ... --dry-run

Requires migration 0018, and the polling-unit registry (0017 /
``scripts/load_pu_enrichment.py``).
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Parties this source carries. The 2023 presidential ballot had 18; these four
# took 23,377,466 of 24,025,940 valid votes (97.3%). The other 14 parties'
# 648,474 votes are not in the source, so every total here is a four-party
# total and is documented as such.
MAJOR_PARTIES = ("APC", "PDP", "LP", "NNPP")

DEFAULT_ELECTION_ID = "2023-presidential"
DEFAULT_SOURCE = "ccij_2023"

# CCIJ's measured document-level accuracy: 8,841 of 10,000 sampled documents
# passed their three validation methods, of which 247 were later found wrong
# against crowdsourced ground truth.
DEFAULT_CONFIDENCE = 0.85


@dataclass
class BaselineRow:
    pu_code: str
    registered: int
    accredited: int
    votes: dict[str, int]
    total: int

    def consensus_data(self) -> dict:
        """Shape matches ``ExtractedEC8A`` / ``ec8a_submissions.extracted_data``,
        which is what ``historical.py`` and the turnout views read.

        Fields this source cannot supply are stated as unknown rather than
        invented. ``rejected_ballots`` is not in the data: the four-party total
        is a valid-vote total, so a zero here would assert that no ballot was
        rejected anywhere in Nigeria.
        """
        return {
            "pu_code": self.pu_code,
            "registered_voters": self.registered,
            "accredited_voters": self.accredited,
            "candidate_votes": self.votes,
            "total_valid_votes": self.total,
            "total_votes_cast": self.total,
            "rejected_ballots": None,
            "presiding_officer_signed": None,
            "agent_signatures_detected": None,
            "official_stamp_present": None,
            "_source_note": (
                "Four major parties only; minor-party votes are not in this "
                "source, so total_valid_votes is a four-party total."
            ),
        }


@dataclass
class Skipped:
    """Polling units deliberately left out of the baseline, by reason."""

    counts: dict[str, int] = field(default_factory=dict)
    examples: dict[str, str] = field(default_factory=dict)

    def add(self, reason: str, pu_code: str) -> None:
        self.counts[reason] = self.counts.get(reason, 0) + 1
        self.examples.setdefault(reason, pu_code)

    def total(self) -> int:
        return sum(self.counts.values())


def parse_int(raw: str | None) -> int | None:
    """Parse a count written as a float string. None when absent or unusable.

    None is the whole point of this function: it propagates into a skip, not
    into a zero.
    """
    text = (raw or "").strip()
    if not text:
        return None
    try:
        value = float(text)
    except ValueError:
        return None
    if value != value or value < 0:  # NaN or negative
        return None
    return int(value)


def read_baseline(path: Path) -> tuple[list[BaselineRow], Skipped]:
    """Read the results CSV, keeping only complete rows."""
    rows: list[BaselineRow] = []
    skipped = Skipped()

    with path.open(newline="") as f:
        for raw in csv.DictReader(f):
            pu_code = (raw.get("polling_unit_code") or "").strip().replace("/", "-")
            if not pu_code:
                skipped.add("missing_pu_code", "?")
                continue

            registered = parse_int(raw.get("Registered_num"))
            accredited = parse_int(raw.get("Accredited_num"))
            total = parse_int(raw.get("total_use"))
            votes = {p: parse_int(raw.get(p)) for p in MAJOR_PARTIES}

            if registered is None:
                skipped.add("no_registered_voters", pu_code)
                continue
            if accredited is None:
                skipped.add("no_accreditation_figure", pu_code)
                continue
            if any(v is None for v in votes.values()):
                skipped.add("incomplete_party_votes", pu_code)
                continue
            if total is None:
                skipped.add("no_total", pu_code)
                continue
            if registered == 0:
                # A zero register makes turnout undefined; historical.py
                # guards on it anyway, so the row would be inert.
                skipped.add("zero_registered_voters", pu_code)
                continue

            rows.append(
                BaselineRow(
                    pu_code=pu_code,
                    registered=registered,
                    accredited=accredited,
                    votes={p: v for p, v in votes.items() if v is not None},
                    total=total,
                )
            )

    return rows, skipped


def summarise_signals(rows: list[BaselineRow]) -> dict[str, int]:
    """Count the sanity signals this baseline carries, for the run report.

    These are the same conditions ``app/anomaly/sanity.py`` tests. Reporting
    them here means an operator can see what the baseline is about to assert
    before any sweep runs.
    """
    out = {
        "votes_exceed_registered": 0,
        "turnout_exceeds_accreditation": 0,
        "votes_without_accreditation": 0,
    }
    for r in rows:
        if r.total > r.registered:
            out["votes_exceed_registered"] += 1
        if r.accredited == 0 and r.total > 0:
            out["votes_without_accreditation"] += 1
        elif r.total > r.accredited:
            out["turnout_exceeds_accreditation"] += 1
    return out


def connect(url: str):
    import psycopg2

    return psycopg2.connect(
        url,
        keepalives=1,
        keepalives_idle=30,
        keepalives_interval=10,
        keepalives_count=5,
        connect_timeout=15,
    )


def known_pu_codes(cur) -> set[str]:
    cur.execute("SELECT pu_code FROM polling_units")
    return {r[0] for r in cur.fetchall()}


def upsert_baseline(cur, rows: list[tuple]) -> None:
    """rows: (election_id, pu_code, consensus_json, source, confidence)."""
    import psycopg2.extras

    psycopg2.extras.execute_batch(
        cur,
        """
        INSERT INTO verified_results (
            election_id, pu_code, status, consensus_data,
            submission_count, source_count, source, extraction_confidence
        ) VALUES (%s, %s, 'third_party_extraction', %s::jsonb, 1, 1, %s, %s)
        ON CONFLICT (election_id, pu_code) DO UPDATE SET
            status                = EXCLUDED.status,
            consensus_data        = EXCLUDED.consensus_data,
            source                = EXCLUDED.source,
            extraction_confidence = EXCLUDED.extraction_confidence,
            computed_at           = NOW()
        """,
        rows,
        page_size=500,
    )


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--results", required=True, type=Path, help="per-PU results CSV")
    p.add_argument("--election-id", default=DEFAULT_ELECTION_ID)
    p.add_argument("--source", default=DEFAULT_SOURCE)
    p.add_argument("--confidence", type=float, default=DEFAULT_CONFIDENCE)
    p.add_argument("--dry-run", action="store_true", help="report only; write nothing")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if not args.results.is_file():
        print(f"results file not found: {args.results}", file=sys.stderr)
        return 2

    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL not set", file=sys.stderr)
        return 2

    print(f"Reading {args.results}")
    rows, skipped = read_baseline(args.results)
    total_seen = len(rows) + skipped.total()
    print(f"  {total_seen:,} rows; {len(rows):,} complete ({len(rows) / total_seen:.1%})")
    print(f"  {skipped.total():,} left out of the baseline:")
    for reason in sorted(skipped.counts):
        print(f"    {reason:28s} {skipped.counts[reason]:>7,}  e.g. {skipped.examples[reason]}")
    print(
        "  These are ABSENT, not zero-filled. A zeroed baseline would read as a\n"
        "  total turnout collapse and fire a false anomaly for every one of them."
    )

    signals = summarise_signals(rows)
    print("\nSanity signals carried by this baseline:")
    for name in sorted(signals):
        print(f"  {name:32s} {signals[name]:>7,}")

    conn = connect(url)
    conn.autocommit = False
    try:
        cur = conn.cursor()

        cur.execute("SELECT 1 FROM elections WHERE id = %s", (args.election_id,))
        if cur.fetchone() is None:
            print(
                f"\nABORTING: election {args.election_id!r} is not in the registry."
                " Apply db/migrations/0005_2023_elections_registry.sql first.",
                file=sys.stderr,
            )
            return 3

        known = known_pu_codes(cur)
        print(f"\nRegistry holds {len(known):,} polling units")

        loadable = [r for r in rows if r.pu_code in known]
        unknown = len(rows) - len(loadable)
        if unknown:
            print(
                f"  {unknown:,} complete rows skipped: polling unit not in the"
                " registry (run scripts/load_pu_enrichment.py first)"
            )

        batch = [
            (
                args.election_id,
                r.pu_code,
                json.dumps(r.consensus_data()),
                args.source,
                args.confidence,
            )
            for r in loadable
        ]

        if not args.dry_run:
            for i in range(0, len(batch), 5_000):
                upsert_baseline(cur, batch[i : i + 5_000])

        print(f"Baseline rows: {len(batch):,} for election {args.election_id}")
        print(
            f"  status=third_party_extraction  source={args.source}"
            f"  confidence={args.confidence}"
        )

        if args.dry_run:
            conn.rollback()
            print("\nDry run: rolled back, nothing written.")
        else:
            conn.commit()
            print("\nCommitted.")
            print(
                "Refresh the turnout views before running the statistical sweep:\n"
                "  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_ward_turnout_dist;\n"
                "  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_lga_turnout_dist;"
            )
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
