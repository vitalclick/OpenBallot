"""Polling-unit enrichment loader - parsing, validation and precision.

The script lives under repo `scripts/` rather than the worker package (it is
an operator tool, not part of the running service), so this test pulls it in
via a sys.path tweak - the same arrangement as test_ward_reconciliation.py.
Kept here so it runs in CI alongside the rest of the Python suite.

Fixtures below are synthetic. The loader's real input is third-party data
whose licensing is unsettled (issue #64), and none of it belongs in this
repository until that is resolved. The shapes are what matter for these
tests, and they are documented in issues #65 and #66.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from load_pu_enrichment import (
    PRECISION_EXACT,
    PRECISION_SHARED,
    classify_precision,
    in_nigeria_bbox,
    lga_prefix,
    normalise_pu_code,
    parse_coordinate,
    parse_count,
    plan_gap_fill,
    read_roster,
    read_roster_geography,
    read_voter_info,
    ward_prefix,
)

ROSTER_HEADER = "polling_unit_code,status,state_name,lga_name,ward_name,unit_name,lat,lng\n"
VOTER_HEADER = "polling_unit_code,Registered_num,Accredited_num\n"


def _roster(tmp_path: Path, *lines: str) -> Path:
    p = tmp_path / "roster.csv"
    p.write_text(ROSTER_HEADER + "".join(line + "\n" for line in lines))
    return p


def _voters(tmp_path: Path, *lines: str) -> Path:
    p = tmp_path / "voters.csv"
    p.write_text(VOTER_HEADER + "".join(line + "\n" for line in lines))
    return p


# ─── Code normalisation ───────────────────────────────────────────────────


def test_slash_codes_normalise_to_delim_form():
    assert normalise_pu_code("01/01/01/001") == "01-01-01-001"


def test_dash_codes_pass_through_unchanged():
    # The loader should be indifferent to which separator the source uses.
    assert normalise_pu_code("01-01-01-001") == "01-01-01-001"


def test_malformed_codes_are_rejected_not_guessed():
    for bad in ["", None, "01/01/01", "01/01/01/001/002", "AB/01/01/001", "not a code"]:
        assert normalise_pu_code(bad) is None


def test_surrounding_whitespace_is_tolerated():
    assert normalise_pu_code("  01/01/01/001  ") == "01-01-01-001"


# ─── Coordinates ──────────────────────────────────────────────────────────


def test_coordinates_parse_from_strings():
    assert parse_coordinate("5.124", "7.3702") == (5.124, 7.3702)


def test_unparseable_coordinates_return_none():
    for lat, lng in [("", "7.37"), ("5.12", ""), (None, None), ("n/a", "7.37")]:
        assert parse_coordinate(lat, lng) is None


def test_nan_coordinates_are_rejected():
    # NaN is a float and slips past a naive bounds check, since every
    # comparison against it is false.
    assert parse_coordinate("nan", "7.37") is None


def test_bbox_accepts_real_nigerian_points():
    assert in_nigeria_bbox(5.124, 7.3702)      # Abia
    assert in_nigeria_bbox(6.4969, 3.3515)     # Lagos
    assert in_nigeria_bbox(13.05, 13.2)        # far north-east


def test_bbox_rejects_points_outside_the_country():
    assert not in_nigeria_bbox(0.0, 0.0)       # null island
    assert not in_nigeria_bbox(51.5, -0.12)    # London
    assert not in_nigeria_bbox(-26.2, 28.0)    # Johannesburg


def test_bbox_cannot_detect_transposed_coordinates():
    """Nigeria's lat range (3.5-14.5) and lng range (2.0-15.5) overlap almost
    entirely, so a swapped pair usually lands back inside the box.

    Asserted so the limitation is recorded rather than assumed away: the bbox
    catches gross errors and foreign points, and a transposition check would
    need a different signal - agreement with the polling unit's known state,
    say. Here a transposed Abia coordinate passes, and that is expected.
    """
    assert in_nigeria_bbox(5.124, 7.3702)      # Abia, correct order
    assert in_nigeria_bbox(7.3702, 5.124)      # same point transposed


# ─── Voter counts ─────────────────────────────────────────────────────────


def test_counts_parse_from_float_strings():
    # The source writes integers as floats.
    assert parse_count("968.0") == 968
    assert parse_count("0.0") == 0


def test_bad_counts_return_none():
    for bad in ["", None, "n/a", "nan"]:
        assert parse_count(bad) is None


def test_negative_counts_are_rejected():
    # polling_units.registered_voters carries CHECK (registered_voters >= 0);
    # better to reject here than to trip the constraint mid-batch.
    assert parse_count("-5") is None


# ─── Precision classification ─────────────────────────────────────────────


def test_unique_coordinates_are_exact_and_shared_ones_are_not(tmp_path):
    # Two polling units in one school share a point; the third stands alone.
    roster = _roster(
        tmp_path,
        "01/01/01/001,ok,ABIA,ABA NORTH,EZIAMA,SCHOOL I,5.124,7.3702",
        "01/01/01/002,ok,ABIA,ABA NORTH,EZIAMA,SCHOOL II,5.124,7.3702",
        "01/01/01/003,ok,ABIA,ABA NORTH,EZIAMA,MARKET,5.130,7.3750",
    )
    rows, _ = read_roster(roster)
    precision = classify_precision(rows)

    assert precision["01-01-01-001"] == PRECISION_SHARED
    assert precision["01-01-01-002"] == PRECISION_SHARED
    assert precision["01-01-01-003"] == PRECISION_EXACT


def test_precision_of_an_empty_roster_is_empty():
    assert classify_precision([]) == {}


# ─── Roster reading ───────────────────────────────────────────────────────


def test_out_of_bbox_rows_are_rejected_with_a_reason(tmp_path):
    roster = _roster(
        tmp_path,
        "01/01/01/001,ok,ABIA,ABA NORTH,EZIAMA,GOOD,5.124,7.3702",
        "01/01/01/002,ok,ABIA,ABA NORTH,EZIAMA,NULL ISLAND,0.0,0.0",
    )
    rows, rejects = read_roster(roster)

    assert [r.pu_code for r in rows] == ["01-01-01-001"]
    assert rejects.by_reason()["coordinate_outside_nigeria"] == 1
    # The reason carries the offending value, so the report is actionable.
    assert rejects.rows[0][2] == "0.0,0.0"


def test_duplicate_codes_are_rejected_not_silently_overwritten(tmp_path):
    roster = _roster(
        tmp_path,
        "01/01/01/001,ok,ABIA,ABA NORTH,EZIAMA,FIRST,5.124,7.3702",
        "01/01/01/001,ok,ABIA,ABA NORTH,EZIAMA,SECOND,5.200,7.4000",
    )
    rows, rejects = read_roster(roster)

    assert len(rows) == 1
    assert rows[0].pu_name == "FIRST"
    assert rejects.by_reason()["duplicate_pu_code"] == 1


def test_rows_without_coordinates_are_still_gap_fill_candidates(tmp_path):
    # A polling unit missing from the registry is worth inserting even when
    # we cannot place it on a map. Losing the unit would be the worse trade.
    roster = _roster(
        tmp_path,
        "01/01/01/001,ok,ABIA,ABA NORTH,EZIAMA,MAPPED,5.124,7.3702",
        "01/01/01/002,ok,ABIA,ABA NORTH,EZIAMA,UNMAPPED,,",
    )
    rows, rejects = read_roster(roster)
    geo = read_roster_geography(roster)

    assert len(rows) == 1
    assert rejects.by_reason()["missing_coordinate"] == 1
    assert set(geo) == {"01-01-01-001", "01-01-01-002"}
    assert geo["01-01-01-002"][0] == "UNMAPPED"


def test_names_are_normalised(tmp_path):
    roster = _roster(
        tmp_path,
        "01/01/01/001,ok,ABIA,ABA  NORTH,EZIAMA,RAILWAY QUARTERS,5.124,7.3702",
    )
    rows, _ = read_roster(roster)
    # Collapsed whitespace and title case, matching load_polling_units.py.
    assert rows[0].lga_name == "Aba North"
    assert rows[0].ward_name == "Eziama"


# ─── Voter info reading ───────────────────────────────────────────────────


def test_voter_info_reads_registered_and_ignores_election_facts(tmp_path):
    voters = _voters(tmp_path, "01/01/01/001,968.0,85.0", "01/01/01/002,750.0,90.0")
    registered, rejects = read_voter_info(voters)

    # Accredited voters are an election fact and belong to the per-election
    # baseline (#67), not the election-agnostic registry.
    assert registered == {"01-01-01-001": 968, "01-01-01-002": 750}
    assert len(rejects) == 0


def test_missing_registered_count_is_reported(tmp_path):
    voters = _voters(tmp_path, "01/01/01/001,,85.0")
    registered, rejects = read_voter_info(voters)

    assert registered == {}
    assert rejects.by_reason()["missing_registered_voters"] == 1


# ─── Prefixes ─────────────────────────────────────────────────────────────


def test_prefix_helpers():
    assert ward_prefix("01-08-10-004") == "01-08-10"
    assert lga_prefix("01-08-10-004") == "01-08"


# ─── Gap-fill planning ────────────────────────────────────────────────────


def test_gap_fill_groups_missing_pus_by_ward():
    roster_geo = {
        "01-08-10-001": ("ABSU", "Umuanyi / Absu", "Isuikwuato", "ABIA"),
        "01-08-10-002": ("HOPE VILLE", "Umuanyi / Absu", "Isuikwuato", "ABIA"),
        "01-08-11-001": ("ELSEWHERE", "Other Ward", "Isuikwuato", "ABIA"),
        "01-08-09-001": ("KNOWN", "Known Ward", "Isuikwuato", "ABIA"),
    }
    known = {"01-08-09-001"}
    missing, orphans = plan_gap_fill(
        roster_geo,
        known_pus=known,
        ward_by_prefix={"01-08-09": "AB-08-09"},
        lga_by_prefix={"01-08": "AB-08"},
    )

    assert orphans == []
    assert missing == {
        "01-08-10": ["01-08-10-001", "01-08-10-002"],
        "01-08-11": ["01-08-11-001"],
    }


def test_gap_fill_reports_pus_whose_lga_is_unknown():
    # Our LGA count already matches INEC's published 774, so a polling unit
    # naming an absent LGA means the input disagrees with the registry about
    # the shape of the country. The loader surfaces it instead of inventing.
    roster_geo = {"99-99-99-001": ("MYSTERY", "Nowhere", "Nowhere", "ATLANTIS")}
    missing, orphans = plan_gap_fill(
        roster_geo, known_pus=set(), ward_by_prefix={}, lga_by_prefix={"01-08": "AB-08"}
    )

    assert missing == {}
    assert orphans == ["99-99-99-001"]


def test_gap_fill_is_a_no_op_when_the_registry_is_complete():
    roster_geo = {"01-08-09-001": ("KNOWN", "Known Ward", "Isuikwuato", "ABIA")}
    missing, orphans = plan_gap_fill(
        roster_geo,
        known_pus={"01-08-09-001"},
        ward_by_prefix={"01-08-09": "AB-08-09"},
        lga_by_prefix={"01-08": "AB-08"},
    )

    assert missing == {}
    assert orphans == []
