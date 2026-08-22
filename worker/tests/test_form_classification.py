"""Form classification (issue #71).

Roughly one document in twenty on INEC's own portal is not a usable
presidential EC8A. These tests pin what we do about that.
"""

from __future__ import annotations

import pytest

from app.extraction.errors import ExtractionError, NotAnEC8AError
from app.ingestion.form_classification import (
    EXTERNAL_STATUS_MAP,
    Classification,
    FormClass,
    LayoutSummary,
    classify,
    layout_outlier_reasons,
)
from app.ingestion.pipeline import ValidationFlag


def _layout(**overrides) -> LayoutSummary:
    """A typical valid presidential EC8A."""
    base = {
        "n_boxes": 40,
        "n_columns": 5,
        "n_key_values": 4,
        "n_paragraphs": 2,
        "n_tables": 3,
        "has_expected_stamps": True,
    }
    base.update(overrides)
    return LayoutSummary(**base)


# ─── Layout thresholds ────────────────────────────────────────────────────


def test_a_typical_ec8a_breaks_no_thresholds():
    assert layout_outlier_reasons(_layout()) == []


@pytest.mark.parametrize(
    "override,expected",
    [
        ({"n_boxes": 400}, "boxes>250"),
        ({"n_columns": 14}, "columns>10"),
        ({"n_key_values": 1}, "key_values<2"),
        ({"n_paragraphs": 0}, "paragraphs<1"),
        ({"n_tables": 1}, "tables<2"),
        ({"has_expected_stamps": False}, "stamps_missing"),
    ],
)
def test_each_published_threshold_fires(override, expected):
    assert expected in layout_outlier_reasons(_layout(**override))


def test_a_wildly_wrong_document_breaks_several():
    reasons = layout_outlier_reasons(
        _layout(n_boxes=500, n_columns=20, n_tables=0, has_expected_stamps=False)
    )
    assert len(reasons) >= 4


# ─── Classification ───────────────────────────────────────────────────────


def test_clean_layout_classifies_as_ec8a():
    result = classify(layout=_layout())
    assert result.form_class is FormClass.EC8A
    assert result.is_ec8a
    assert result.should_extract


def test_structural_outlier_is_unknown_not_a_guess():
    """Structure can say "not a typical result sheet" without saying what it
    is instead. Naming it would be a guess."""
    result = classify(layout=_layout(n_tables=0, n_boxes=900))
    assert result.form_class is FormClass.UNKNOWN
    assert "tables<2" in result.reasons


def test_unknown_documents_are_still_extracted():
    """An uncertain classifier must not become a reason to drop evidence.
    We would rather pay for one extraction than refuse a valid result."""
    assert classify(layout=_layout(n_tables=0)).should_extract
    assert classify().should_extract


def test_a_collation_form_is_not_extracted_as_a_polling_unit_result():
    """The roadmap names the collation forms as the manipulation surface that
    produced Rivers-2023. Reading one as a PU result is the failure this
    platform exists to prevent."""
    result = classify(external_status="collation_paper")
    assert result.form_class is FormClass.COLLATION_FORM
    assert not result.should_extract


def test_model_verdict_is_honoured():
    result = classify(model_verdict="not_an_ec8a")
    assert result.form_class is FormClass.NOT_A_FORM
    assert not result.should_extract


def test_model_verdict_beats_a_clean_layout():
    # The model has seen the image; counts have not.
    result = classify(layout=_layout(), model_verdict="not_an_ec8a")
    assert result.form_class is FormClass.NOT_A_FORM


def test_external_label_is_definitive():
    assert classify(external_status="ec40g").form_class is FormClass.EC40G
    assert classify(external_status="wrong_election").form_class is FormClass.WRONG_ELECTION
    assert classify(external_status="selfie").form_class is FormClass.NOT_A_FORM


def test_legibility_labels_do_not_decide_form_type():
    """A blurred EC8A is still an EC8A. Legibility belongs to the quality
    gate (#70), not to classification - conflating them would discard
    readable-but-imperfect result sheets."""
    assert EXTERNAL_STATUS_MAP["blurred"] is None

    result = classify(external_status="blurred", layout=_layout())
    assert result.form_class is FormClass.EC8A
    assert result.should_extract


def test_unrecognised_external_label_falls_through_rather_than_deciding():
    result = classify(external_status="something_new", layout=_layout())
    assert result.form_class is FormClass.EC8A


def test_no_evidence_at_all_is_unknown():
    result = classify()
    assert result.form_class is FormClass.UNKNOWN
    assert result.should_extract


def test_every_external_label_maps_somewhere_deliberate():
    # Guards against a label being added to the corpus and silently ignored.
    for label, mapped in EXTERNAL_STATUS_MAP.items():
        assert label == label.lower()
        assert mapped is None or isinstance(mapped, FormClass)


# ─── The flags exist and line up ──────────────────────────────────────────


def test_validation_flags_cover_the_classes_we_act_on():
    for flag in (
        ValidationFlag.NOT_AN_EC8A,
        ValidationFlag.WRONG_ELECTION,
        ValidationFlag.COLLATION_FORM,
        ValidationFlag.EC40G_FORM,
        ValidationFlag.CANCELLATION_FORM,
        ValidationFlag.BLANK_FORM,
        ValidationFlag.LAYOUT_OUTLIER,
    ):
        assert isinstance(flag.value, str)


def test_not_an_ec8a_error_carries_its_flag():
    """The backend's verdict must reach the submission record rather than
    becoming a generic failure in a log."""
    err = NotAnEC8AError("classified as not an EC8A", image_url="https://cdn/x.jpg")
    assert err.validation_flag == ValidationFlag.NOT_AN_EC8A.value
    assert err.image_url == "https://cdn/x.jpg"
    assert isinstance(err, ExtractionError)


def test_classification_dataclass_is_honest_about_ec8a():
    assert Classification(FormClass.EC8A, []).is_ec8a
    assert not Classification(FormClass.UNKNOWN, []).is_ec8a
