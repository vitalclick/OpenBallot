"""Figures-vs-words reconciliation (issue #68).

Form EC8A records every vote count twice, in figures and in words. These tests
pin the reading of both channels and the agreement rules between them.
"""

from __future__ import annotations

from app.extraction.word_numbers import (
    correct_word,
    figure_candidates,
    numbers_match,
    reconcile_cell,
    reconcile_votes,
    segment_words,
    words_to_int,
)

# ─── Word correction ──────────────────────────────────────────────────────


def test_clean_number_words_pass_through():
    assert correct_word("three") == "three"
    assert correct_word("HUNDRED") == "hundred"


def test_ocr_slips_snap_to_the_vocabulary():
    assert correct_word("thre") == "three"
    assert correct_word("hundrd") == "hundred"
    assert correct_word("twety") == "twenty"


def test_punctuation_and_case_are_stripped():
    assert correct_word("Two!!") == "two"


def test_words_far_from_any_number_are_refused():
    """A wrong correction becomes a wrong vote count, so silence is safer."""
    assert correct_word("presiding") is None
    assert correct_word("") is None
    assert correct_word("xyzzy") is None


def test_short_words_are_not_freely_interchangeable():
    """'six' and 'ten' are two edits apart. An unbounded distance of 2 would
    make them the same word, which on a ballot form is unacceptable."""
    assert correct_word("six") == "six"
    assert correct_word("ten") == "ten"


# ─── Segmentation ─────────────────────────────────────────────────────────


def test_run_together_words_are_split():
    assert segment_words("onehundredtwo") == ["one", "hundred", "two"]


def test_unsegmentable_text_returns_nothing():
    # Better no parse than a partial one: a partial parse becomes a partial,
    # wrong number.
    assert segment_words("onehundredzzz") == []


# ─── Words to integer ─────────────────────────────────────────────────────


def test_spoken_form():
    assert words_to_int("one hundred twenty three") == 123
    assert words_to_int("one hundred and twenty three") == 123
    assert words_to_int("twenty-five") == 25
    assert words_to_int("four hundred") == 400


def test_dictated_digit_form():
    """A polling officer writing digits out one at a time is common. Reading
    'one two three' as 1+2+3 would be badly wrong."""
    assert words_to_int("one two three") == 123
    assert words_to_int("one zero six") == 106


def test_single_digit_word_is_its_value_not_a_dictation():
    assert words_to_int("one") == 1
    assert words_to_int("nine") == 9


def test_nil_variants_are_zero():
    for text in ("nil", "nill", "NIL", "none", "zero"):
        assert words_to_int(text) == 0


def test_thousands():
    assert words_to_int("one thousand") == 1000
    assert words_to_int("two thousand three hundred") == 2300


def test_illegible_words_return_none():
    assert words_to_int("") is None
    assert words_to_int("   ") is None
    assert words_to_int("scrawl") is None


def test_ocr_damaged_words_still_convert():
    assert words_to_int("thre hundrd twety one") == 321


# ─── Figures to candidates ────────────────────────────────────────────────


def test_clean_figures():
    assert figure_candidates("123") == [123]


def test_split_reading_offers_the_join_first():
    """OCR often sees '1 23' where the form says '123'. Both readings are
    offered; the words column decides."""
    assert figure_candidates("1 23") == [123, 1, 23]


def test_ocr_letter_confusions_are_substituted():
    assert figure_candidates("I8O") == [180]
    assert figure_candidates("S3") == [53]


def test_no_digits_yields_no_candidates():
    assert figure_candidates("") == []
    assert figure_candidates("---") == []


# ─── Agreement ────────────────────────────────────────────────────────────


def test_match_tolerances():
    assert numbers_match(123, 123)      # exact
    assert numbers_match(123, 125)      # within 2: a misread units digit
    assert numbers_match(183, 283)      # dropped hundreds digit
    assert not numbers_match(123, 456)


def test_agreement_yields_high_confidence():
    r = reconcile_cell("123", "one hundred twenty three")
    assert r.value == 123
    assert r.agreed
    assert r.confidence > 0.9
    assert not r.needs_review


def test_words_disambiguate_a_split_figure_reading():
    """The case that justifies the whole module: figures read ambiguously,
    words settle it."""
    r = reconcile_cell("1 23", "one hundred twenty three")
    assert r.value == 123
    assert r.agreed


def test_words_recover_a_hundreds_digit_dropped_from_the_figures():
    r = reconcile_cell("83", "one hundred eighty three")
    assert r.agreed
    assert r.value == 83          # the figure candidate that matched
    assert r.words == 183         # what the words actually said


def test_disagreement_sinks_confidence_below_any_floor():
    """The extraction engine's confidence_floor is 0.85. A cell whose two
    channels disagree must fall well under it so the fallback fires."""
    r = reconcile_cell("456", "one hundred twenty three")
    assert not r.agreed
    assert r.needs_review
    assert r.confidence < 0.5
    # Both readings are preserved so a reviewer can see the conflict.
    assert r.figures == 456
    assert r.words == 123


def test_single_channel_is_usable_but_unverified():
    r = reconcile_cell("123", None)
    assert r.value == 123
    assert not r.agreed
    assert 0.5 < r.confidence < 0.9


def test_words_alone_are_usable():
    r = reconcile_cell("", "one hundred twenty three")
    assert r.value == 123
    assert r.figures is None


def test_illegible_cell_has_no_value():
    r = reconcile_cell("", "")
    assert r.value is None
    assert r.confidence == 0.0


# ─── Whole-form reconciliation ────────────────────────────────────────────


def test_all_parties_agreeing_gives_high_confidence():
    values, detail, confidence = reconcile_votes(
        {"APC": "142", "PDP": "89", "LP": "203"},
        {"APC": "one hundred forty two", "PDP": "eighty nine",
         "LP": "two hundred three"},
    )
    assert values == {"APC": 142, "PDP": 89, "LP": 203}
    assert confidence > 0.9
    assert all(r.agreed for r in detail.values())


def test_one_disagreeing_party_drags_the_whole_form_down():
    """Confidence is the minimum across parties, not the mean.

    One unresolved party is enough to make the form worth a second look, and
    averaging would let the clean rows bury it."""
    values, detail, confidence = reconcile_votes(
        {"APC": "142", "PDP": "89", "LP": "203"},
        {"APC": "one hundred forty two", "PDP": "eighty nine",
         "LP": "nine hundred ninety nine"},
    )
    assert confidence < 0.5
    assert detail["LP"].needs_review
    assert not detail["APC"].needs_review
    # The disagreement localises to LP; the other two are still trustworthy.
    assert values["APC"] == 142


def test_missing_words_map_is_tolerated():
    values, _, confidence = reconcile_votes({"APC": "142"}, None)
    assert values == {"APC": 142}
    assert 0.5 < confidence < 0.9
