"""Tests for the party-admin roster CSV parser.

The parser is pure - no DB, no I/O. Every validation rule is exercised
here without spinning up Postgres.
"""

from __future__ import annotations

import pytest

from app.admin.csv_import import RosterImportError, parse_roster_csv

GOOD_CSV = """name,phone,pu_code,language
Aminu Yusuf,08035550101,25-11-04-007,en
Chidi Okeke,+2348022223333,33-15-05-001,ig
Ngozi Adesina,0803 555 0102,25-11-04-019,yo
"""


def test_happy_path_parses_three_rows():
    rows = parse_roster_csv(GOOD_CSV)
    assert len(rows) == 3
    # E.164 normalisation
    assert rows[0].phone_e164 == "+2348035550101"
    assert rows[1].phone_e164 == "+2348022223333"
    assert rows[2].phone_e164 == "+2348035550102"
    assert rows[0].language == "en"
    assert rows[2].language == "yo"


def test_default_language_is_english_when_omitted():
    csv = "name,phone,pu_code\nA,08035550101,25-11-04-007\n"
    rows = parse_roster_csv(csv)
    assert rows[0].language == "en"


def test_case_insensitive_headers():
    csv = "Name,PHONE,Pu_Code,Language\nA,08035550101,25-11-04-007,EN\n"
    rows = parse_roster_csv(csv)
    assert rows[0].full_name == "A"
    assert rows[0].language == "en"


def test_missing_required_column_rejected():
    csv = "name,pu_code\nA,25-11-04-007\n"
    with pytest.raises(RosterImportError, match="missing required column"):
        parse_roster_csv(csv)


def test_empty_csv_rejected():
    with pytest.raises(RosterImportError, match="empty"):
        parse_roster_csv("")


def test_no_data_rows_rejected():
    csv = "name,phone,pu_code\n"
    with pytest.raises(RosterImportError, match="zero rows"):
        parse_roster_csv(csv)


def test_invalid_phone_rejected_with_line_number():
    csv = "name,phone,pu_code\nA,not-a-phone,25-11-04-007\n"
    with pytest.raises(RosterImportError, match="line 2"):
        parse_roster_csv(csv)


def test_duplicate_phone_in_file_rejected():
    csv = """name,phone,pu_code
A,08035550101,25-11-04-007
B,+2348035550101,25-11-04-008
"""
    with pytest.raises(RosterImportError, match="duplicated"):
        parse_roster_csv(csv)


def test_invalid_language_rejected():
    csv = "name,phone,pu_code,language\nA,08035550101,25-11-04-007,fr\n"
    with pytest.raises(RosterImportError, match="language"):
        parse_roster_csv(csv)


def test_empty_pu_code_rejected():
    csv = "name,phone,pu_code\nA,08035550101,\n"
    with pytest.raises(RosterImportError, match="pu_code is empty"):
        parse_roster_csv(csv)


def test_empty_name_rejected():
    csv = "name,phone,pu_code\n,08035550101,25-11-04-007\n"
    with pytest.raises(RosterImportError, match="name is empty"):
        parse_roster_csv(csv)


def test_all_errors_surface_not_just_first():
    csv = """name,phone,pu_code
,08035550101,25-11-04-007
B,not-a-phone,25-11-04-008
C,08035550102,
"""
    with pytest.raises(RosterImportError) as excinfo:
        parse_roster_csv(csv)
    assert len(excinfo.value.errors) == 3
