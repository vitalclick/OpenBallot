"""Authentication evaluation harness (issue #72).

The most important test here is the degenerate one: a detector that answers
"present" every single time must score well on accuracy and ZERO on negative
recall. If the harness cannot expose that, it cannot tell us anything useful
about a real detector either.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from eval_authentication import (
    FIELDS,
    ConfusionMatrix,
    parse_bool,
    read_labels,
    score,
)

HEADER = (
    "status,polling_unit_code,presiding_officer_name_present,"
    "presiding_officer_signature_present,polling_agent_signature_present,"
    "black_stamp\n"
)


def _csv(tmp_path: Path, name: str, *lines: str) -> Path:
    p = tmp_path / name
    p.write_text(HEADER + "".join(line + "\n" for line in lines))
    return p


# ─── Parsing ──────────────────────────────────────────────────────────────


def test_labels_parse_from_float_strings():
    assert parse_bool("1.0") is True
    assert parse_bool("0.0") is False
    assert parse_bool("1") is True


def test_unreadable_labels_are_none_not_false():
    # None means "no label". False means "the element is absent" - a claim.
    for bad in ["", None, "   ", "n/a"]:
        assert parse_bool(bad) is None


def test_codes_are_normalised_to_the_registry_form(tmp_path):
    labels = read_labels(_csv(tmp_path, "l.csv", "ok,09/13/03/002,0.0,1.0,1.0,1"))
    assert "09-13-03-002" in labels


# ─── Confusion matrix ─────────────────────────────────────────────────────


def test_matrix_counts_all_four_outcomes():
    m = ConfusionMatrix()
    m.observe(predicted=True, actual=True)      # TP
    m.observe(predicted=True, actual=False)     # FP
    m.observe(predicted=False, actual=True)     # FN
    m.observe(predicted=False, actual=False)    # TN
    assert (m.true_positive, m.false_positive, m.false_negative, m.true_negative) == (
        1, 1, 1, 1,
    )
    assert m.accuracy == 0.5


def test_negative_recall_measures_catching_the_absences():
    m = ConfusionMatrix()
    # Three forms genuinely missing the element; we caught two.
    m.observe(predicted=False, actual=False)
    m.observe(predicted=False, actual=False)
    m.observe(predicted=True, actual=False)
    assert m.negative_recall == 2 / 3


def test_an_empty_matrix_does_not_divide_by_zero():
    m = ConfusionMatrix()
    assert m.accuracy == 0.0
    assert m.precision == 0.0
    assert m.recall == 0.0
    assert m.f1 == 0.0
    assert m.negative_recall == 0.0


# ─── Scoring ──────────────────────────────────────────────────────────────


def test_a_perfect_detector_scores_perfectly(tmp_path):
    rows = [
        "ok,01/01/01/001,1.0,1.0,1.0,1",
        "ok,01/01/01/002,0.0,0.0,0.0,0",
    ]
    labels = read_labels(_csv(tmp_path, "labels.csv", *rows))
    predictions = read_labels(_csv(tmp_path, "preds.csv", *rows))

    matrices, overlap = score(labels, predictions)
    assert overlap == 2
    for field in FIELDS:
        assert matrices[field].accuracy == 1.0
        assert matrices[field].negative_recall == 1.0


def test_a_detector_that_always_says_present_is_exposed(tmp_path):
    """The degenerate case the whole harness exists to catch.

    83% of real forms carry a presiding officer's signature, so answering
    'signed' every time scores 83% accuracy while being wrong in exactly the
    case that matters."""
    labels = read_labels(
        _csv(
            tmp_path,
            "labels.csv",
            *[f"ok,01/01/01/{i:03d},1.0,1.0,1.0,1" for i in range(1, 9)],
            *[f"ok,01/01/02/{i:03d},0.0,0.0,0.0,0" for i in range(1, 3)],
        )
    )
    always_present = read_labels(
        _csv(
            tmp_path,
            "preds.csv",
            *[f"ok,01/01/01/{i:03d},1.0,1.0,1.0,1" for i in range(1, 9)],
            *[f"ok,01/01/02/{i:03d},1.0,1.0,1.0,1" for i in range(1, 3)],
        )
    )

    matrices, _ = score(labels, always_present)
    m = matrices["presiding_officer_signature_present"]

    assert m.accuracy == 0.8          # flattering
    assert m.recall == 1.0            # flattering
    assert m.negative_recall == 0.0   # and the truth: it caught nothing


def test_missing_predictions_are_a_coverage_gap_not_wrong_answers(tmp_path):
    """Scoring an absent prediction as 'absent' would punish or flatter a
    detector for something it never claimed."""
    labels = read_labels(
        _csv(
            tmp_path,
            "labels.csv",
            "ok,01/01/01/001,1.0,1.0,1.0,1",
            "ok,01/01/01/002,0.0,0.0,0.0,0",
        )
    )
    partial = read_labels(_csv(tmp_path, "preds.csv", "ok,01/01/01/001,1.0,1.0,1.0,1"))

    matrices, overlap = score(labels, partial)
    assert overlap == 1
    assert matrices["black_stamp"].total == 1


def test_no_overlap_scores_nothing(tmp_path):
    labels = read_labels(_csv(tmp_path, "labels.csv", "ok,01/01/01/001,1.0,1.0,1.0,1"))
    other = read_labels(_csv(tmp_path, "preds.csv", "ok,09/09/09/009,1.0,1.0,1.0,1"))

    matrices, overlap = score(labels, other)
    assert overlap == 0
    assert all(m.total == 0 for m in matrices.values())
