"""2023 per-PU baseline loader - completeness rules (issue #67).

Pulled in from repo `scripts/` via a sys.path tweak, matching
test_ward_reconciliation.py and test_pu_enrichment.py.

Almost every test here exists to pin one rule: an unreadable form must be
ABSENT from the baseline, never zero-filled. `historical.py` raises an anomaly
at a 40pp turnout shift, so a zeroed baseline asserts 0% turnout in 2023 and
turns every later polling unit above 40% into a false alarm. Measured against
the real data that is on the order of 13,000 fabricated anomalies.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from load_2023_pu_baseline import (
    MAJOR_PARTIES,
    parse_int,
    read_baseline,
    summarise_signals,
)

HEADER = (
    "polling_unit_code,status,Registered_num,Accredited_num,"
    "APC,PDP,LP,NNPP,total_use\n"
)


def _csv(tmp_path: Path, *lines: str) -> Path:
    p = tmp_path / "results.csv"
    p.write_text(HEADER + "".join(line + "\n" for line in lines))
    return p


COMPLETE = "01/01/01/001,ok,968.0,85.0,0.0,2.0,118.0,0.0,126.0"


# ─── Parsing ──────────────────────────────────────────────────────────────


def test_counts_parse_from_float_strings():
    assert parse_int("968.0") == 968
    assert parse_int("0.0") == 0


def test_unreadable_counts_are_none_never_zero():
    # The distinction this whole module rests on: absent must not become 0.
    for bad in ["", None, "   ", "n/a", "nan", "-3"]:
        assert parse_int(bad) is None


# ─── Completeness ─────────────────────────────────────────────────────────


def test_complete_row_is_loaded(tmp_path):
    rows, skipped = read_baseline(_csv(tmp_path, COMPLETE))
    assert len(rows) == 1
    assert skipped.total() == 0

    r = rows[0]
    assert r.pu_code == "01-01-01-001"       # normalised to delim form
    assert r.registered == 968
    assert r.accredited == 85
    assert r.total == 126
    assert r.votes == {"APC": 0, "PDP": 2, "LP": 118, "NNPP": 0}


def test_row_missing_one_party_is_skipped_not_zero_filled(tmp_path):
    # 33,387 rows in the real data look like this. Filling the blank with 0
    # would silently invent a vote count.
    rows, skipped = read_baseline(
        _csv(tmp_path, "01/01/01/002,ok,750.0,90.0,,,,,126.0")
    )
    assert rows == []
    assert skipped.counts["incomplete_party_votes"] == 1


def test_row_missing_the_total_is_skipped(tmp_path):
    rows, skipped = read_baseline(
        _csv(tmp_path, "01/01/01/003,ok,750.0,90.0,1.0,2.0,3.0,4.0,")
    )
    assert rows == []
    assert skipped.counts["no_total"] == 1


def test_zero_registered_voters_is_skipped(tmp_path):
    # Turnout is undefined with a zero register, so the row would be inert
    # anyway - but skipping it keeps it out of the turnout views too.
    rows, skipped = read_baseline(
        _csv(tmp_path, "03/01/03/001,ok,0.0,0.0,1.0,2.0,3.0,4.0,10.0")
    )
    assert rows == []
    assert skipped.counts["zero_registered_voters"] == 1


def test_a_genuine_zero_vote_is_kept(tmp_path):
    """Zero votes for a party is data; a blank is not.

    The loader must tell them apart, or it either invents votes or discards
    real ones."""
    rows, _ = read_baseline(
        _csv(tmp_path, "01/01/01/004,ok,500.0,100.0,0.0,0.0,0.0,0.0,0.0")
    )
    assert len(rows) == 1
    assert rows[0].votes == dict.fromkeys(MAJOR_PARTIES, 0)
    assert rows[0].total == 0


def test_mixed_file_loads_only_the_complete_rows(tmp_path):
    rows, skipped = read_baseline(
        _csv(
            tmp_path,
            COMPLETE,
            "01/01/01/002,ok,750.0,90.0,,,,,126.0",
            "01/01/01/003,ok,750.0,90.0,1.0,2.0,3.0,4.0,",
        )
    )
    assert [r.pu_code for r in rows] == ["01-01-01-001"]
    assert skipped.total() == 2


# ─── consensus_data shape ─────────────────────────────────────────────────


def test_unknown_fields_are_null_not_invented(tmp_path):
    """The source has no rejected-ballot or signature data.

    A zero for rejected_ballots would assert that no ballot was rejected;
    a False for presiding_officer_signed would assert the form was unsigned.
    Both are claims this source cannot make."""
    rows, _ = read_baseline(_csv(tmp_path, COMPLETE))
    data = rows[0].consensus_data()

    assert data["rejected_ballots"] is None
    assert data["presiding_officer_signed"] is None
    assert data["agent_signatures_detected"] is None
    assert data["official_stamp_present"] is None
    # The four-party caveat travels with the row, not only in a runbook.
    assert "four-party total" in data["_source_note"]


def test_consensus_data_matches_what_the_anomaly_engine_reads(tmp_path):
    # engine._build_pu_turnout / _to_historical read exactly these keys.
    rows, _ = read_baseline(_csv(tmp_path, COMPLETE))
    data = rows[0].consensus_data()
    for key in ("registered_voters", "total_votes_cast", "total_valid_votes",
                "candidate_votes"):
        assert key in data
    assert data["registered_voters"] > 0


# ─── Signal summary ───────────────────────────────────────────────────────


def test_signal_summary_separates_zero_accreditation_from_over_voting(tmp_path):
    rows, _ = read_baseline(
        _csv(
            tmp_path,
            # votes recorded, accreditation synced zero
            "01/01/01/001,ok,800.0,0.0,40.0,44.0,42.0,0.0,126.0",
            # votes exceed a positive accreditation
            "01/01/01/002,ok,800.0,50.0,40.0,44.0,42.0,0.0,126.0",
            # votes exceed the register itself
            "01/01/01/003,ok,100.0,90.0,40.0,44.0,42.0,0.0,126.0",
        )
    )
    signals = summarise_signals(rows)

    assert signals["votes_without_accreditation"] == 1
    assert signals["turnout_exceeds_accreditation"] == 2   # rows 2 and 3
    assert signals["votes_exceed_registered"] == 1
