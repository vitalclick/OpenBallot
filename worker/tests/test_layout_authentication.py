"""Positional stamp and signature detection (issue #72).

An unsigned EC8A is not a valid result, so these three fields matter in both
directions: missing a genuine signature casts doubt on a clean form, and
inventing one launders an unsigned one.

The premise under test is that POSITION decides the role. A signature in the
agent column is not the presiding officer's, however confident a model is
that it is a signature.
"""

from __future__ import annotations

from app.layout.authentication import (
    SignaturePosition,
    StampPosition,
    classify_signatures,
    classify_stamps,
    evaluate_authentication,
)
from app.layout.geometry import LayoutBox

PAGE_W, PAGE_H = 1200.0, 1700.0


def box(label, x1, y1, x2, y2, confidence=0.9) -> LayoutBox:
    return LayoutBox(
        label=label,
        confidence=confidence,
        corners=((x1, y1), (x2, y1), (x2, y2), (x1, y2)),
    )


def _form(*extra) -> list[LayoutBox]:
    """A well-formed EC8A: results table, agent column, declaration."""
    return [
        box("table", 100, 300, 1100, 1200),
        box("column", 850, 300, 1100, 1200),      # rightmost: agent signatures
        box("column", 100, 300, 400, 1200),
        box("paragraph", 100, 1250, 1100, 1350),
        *extra,
    ]


# ─── Stamps ───────────────────────────────────────────────────────────────


def test_a_stamp_inside_the_table_is_the_middle_stamp():
    stamps = classify_stamps(_form(box("stamp", 500, 700, 650, 850)), PAGE_W)
    assert len(stamps[StampPosition.MIDDLE]) == 1


def test_a_stamp_below_the_table_on_the_left_is_the_officers():
    stamps = classify_stamps(_form(box("stamp", 150, 1400, 320, 1550)), PAGE_W)
    assert len(stamps[StampPosition.BOTTOM_LEFT]) == 1


def test_a_centred_stamp_below_the_table_is_distinguished_from_it():
    stamps = classify_stamps(_form(box("stamp", 520, 1400, 680, 1550)), PAGE_W)
    assert len(stamps[StampPosition.BOTTOM_MIDDLE]) == 1
    assert not stamps[StampPosition.BOTTOM_LEFT]


def test_a_weak_stamp_detection_is_ignored():
    """A false stamp claims the form was formally endorsed - a stronger
    assertion than a false signature count, so it needs a higher bar."""
    stamps = classify_stamps(
        _form(box("stamp", 150, 1400, 320, 1550, confidence=0.2)), PAGE_W
    )
    assert all(not v for v in stamps.values())


def test_stamps_cannot_be_placed_without_a_table():
    """Without the table there is no frame of reference. Recorded as
    unplaced rather than guessed at."""
    stamps = classify_stamps([box("stamp", 150, 1400, 320, 1550)], PAGE_W)
    assert len(stamps[StampPosition.UNPLACED]) == 1


# ─── Signatures ───────────────────────────────────────────────────────────


def test_signatures_in_the_rightmost_column_are_agents():
    sigs = classify_signatures(
        _form(
            box("signature", 880, 400, 1050, 450),
            box("signature", 880, 500, 1050, 550),
            box("signature", 880, 600, 1050, 650),
        ),
        PAGE_H,
    )
    assert len(sigs[SignaturePosition.AGENT_COLUMN]) == 3


def test_a_signature_below_the_document_is_the_presiding_officer():
    sigs = classify_signatures(
        _form(box("signature", 200, 1450, 500, 1520)), PAGE_H
    )
    assert len(sigs[SignaturePosition.BELOW_DOCUMENT]) == 1


def test_a_signature_in_the_declaration_is_neither():
    sigs = classify_signatures(
        _form(box("signature", 300, 1270, 600, 1330)), PAGE_H
    )
    assert len(sigs[SignaturePosition.IN_PARAGRAPH]) == 1
    assert not sigs[SignaturePosition.BELOW_DOCUMENT]


# ─── The three schema fields ──────────────────────────────────────────────


def test_a_fully_authenticated_form():
    report = evaluate_authentication(
        _form(
            box("signature", 880, 400, 1050, 450),
            box("signature", 880, 500, 1050, 550),
            box("signature", 200, 1450, 500, 1520),      # officer
            box("stamp", 150, 1400, 320, 1550),          # officer's stamp
        ),
        PAGE_W,
        PAGE_H,
    )
    assert report.presiding_officer_signed
    assert report.agent_signatures_detected == 2
    assert report.official_stamp_present
    assert report.is_fully_authenticated
    assert report.missing == []


def test_agent_signatures_do_not_stand_in_for_the_officers():
    """The distinction a vision model cannot reliably make, and the one that
    decides whether a form is validly completed.

    A sheet covered in agent signatures but unsigned by the presiding officer
    is not a valid EC8A and must not read as one."""
    report = evaluate_authentication(
        _form(*[box("signature", 880, 400 + i * 100, 1050, 450 + i * 100)
                for i in range(5)]),
        PAGE_W,
        PAGE_H,
    )
    assert report.agent_signatures_detected == 5
    assert not report.presiding_officer_signed
    assert "presiding_officer_signature" in report.missing


def test_a_middle_stamp_does_not_stand_in_for_the_official_one():
    """A stamp inside the results table is a different mark. Accepting it as
    the official endorsement would let an unstamped form pass."""
    report = evaluate_authentication(
        _form(box("stamp", 500, 700, 650, 850)), PAGE_W, PAGE_H
    )
    assert not report.official_stamp_present
    assert "official_stamp" in report.missing


def test_a_stamp_over_the_officers_signature_is_recognised():
    """The classic arrangement: the officer stamps across their own
    signature. Both must survive, and the stamp must still be placed."""
    report = evaluate_authentication(
        _form(
            box("signature", 200, 1450, 500, 1520),
            box("stamp", 180, 1430, 520, 1540),      # covers the signature
        ),
        PAGE_W,
        PAGE_H,
    )
    assert report.presiding_officer_signed
    assert report.official_stamp_present


def test_an_empty_form_is_missing_everything():
    report = evaluate_authentication(_form(), PAGE_W, PAGE_H)
    assert not report.is_fully_authenticated
    assert set(report.missing) == {
        "presiding_officer_signature",
        "official_stamp",
        "polling_agent_signatures",
    }


def test_the_report_carries_the_positional_breakdown():
    # So a reviewer can see where each mark was found, not just the totals.
    report = evaluate_authentication(
        _form(box("signature", 880, 400, 1050, 450)), PAGE_W, PAGE_H
    )
    assert report.signatures[SignaturePosition.AGENT_COLUMN.value] == 1
    assert report.stamps[StampPosition.BOTTOM_LEFT.value] == 0
