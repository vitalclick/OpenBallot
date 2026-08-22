"""FOIA'd LGA-results loader - parsing and name matching (issue #73).

Pulled in from repo `scripts/` via a sys.path tweak, matching the other
script tests in this directory.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from load_2023_lga_results import (
    PARTIES,
    LGAResult,
    match_lga,
    parse_votes,
    read_results,
)

HEADER = "State,S/N,LGA,APC,LP,PDP,NNPP\n"


def _csv(tmp_path: Path, *lines: str) -> Path:
    p = tmp_path / "lga.csv"
    p.write_text(HEADER + "".join(line + "\n" for line in lines))
    return p


# Registry index shape: (normalised state, normalised LGA) -> (code, state_code)
INDEX = {
    ("abia", "aba north"): ("AB-01", "AB"),
    ("anambra", "ihiala"): ("AN-12", "AN"),
    ("borno", "abadam"): ("BO-01", "BO"),
    ("ogun", "egbado north"): ("OG-05", "OG"),
}


# ─── Parsing ──────────────────────────────────────────────────────────────


def test_votes_parse():
    assert parse_votes("35898") == 35898
    assert parse_votes("35,898") == 35898     # thousands separators
    assert parse_votes("0") == 0


def test_bad_votes_are_none():
    for bad in ["", None, "  ", "n/a", "-5"]:
        assert parse_votes(bad) is None


def test_complete_row_is_read(tmp_path):
    rows, problems = read_results(_csv(tmp_path, "Abia,1,ABA NORTH,190,35898,428,94"))
    assert problems == []
    assert len(rows) == 1
    # Column order in the file is APC,LP,PDP,NNPP - not the tuple order.
    assert rows[0].votes == {"APC": 190, "LP": 35898, "PDP": 428, "NNPP": 94}


def test_row_missing_a_party_is_a_problem_not_a_zero(tmp_path):
    rows, problems = read_results(_csv(tmp_path, "Abia,1,ABA NORTH,190,,428,94"))
    assert rows == []
    assert problems[0][2].startswith("missing_votes:")
    assert "LP" in problems[0][2]


def test_all_parties_are_required():
    assert set(PARTIES) == {"APC", "PDP", "LP", "NNPP"}


# ─── Name matching ────────────────────────────────────────────────────────


def test_exact_name_matches():
    r = LGAResult("Abia", "ABA NORTH", dict.fromkeys(PARTIES, 0))
    assert match_lga(r, INDEX) == ("AB-01", "AB")


def test_case_and_spacing_are_normalised():
    r = LGAResult("  abia ", "Aba   North", dict.fromkeys(PARTIES, 0))
    assert match_lga(r, INDEX) == ("AB-01", "AB")


def test_source_typo_resolves_through_the_alias_map():
    """The source prints "IHALA" for Anambra's Ihiala - one character short.

    Handled by the shared LGA_NAME_ALIASES map in reconcile_ward_names.py,
    so a name fix lands in one place rather than two."""
    r = LGAResult("Anambra", "IHALA", dict.fromkeys(PARTIES, 0))
    assert match_lga(r, INDEX) == ("AN-12", "AN")


def test_renamed_lga_resolves_through_the_alias_map():
    # Ogun's Yewa North is Egbado North in the registry's vintage.
    r = LGAResult("Ogun", "YEWA NORTH", dict.fromkeys(PARTIES, 0))
    assert match_lga(r, INDEX) == ("OG-05", "OG")


def test_abadam_matches_now_that_the_registry_holds_it():
    """Borno / Abadam used to be absent from the registry entirely, because
    INEC's polling-unit roster returns nothing for it. The enrichment loader
    creates it, so the FOIA row now has somewhere to land."""
    r = LGAResult("Borno", "ABADAM", dict.fromkeys(PARTIES, 0))
    assert match_lga(r, INDEX) == ("BO-01", "BO")


def test_unknown_name_returns_none_rather_than_guessing():
    # The caller aborts on this. A near-miss silently mapped to the wrong LGA
    # would move real votes between LGAs.
    r = LGAResult("Abia", "NOWHERE AT ALL", dict.fromkeys(PARTIES, 0))
    assert match_lga(r, INDEX) is None


def test_alias_does_not_leak_across_states():
    """An alias is keyed by state. The same LGA name in the wrong state must
    not resolve, or votes would be attributed to another part of the country."""
    r = LGAResult("Lagos", "IHALA", dict.fromkeys(PARTIES, 0))
    assert match_lga(r, INDEX) is None
