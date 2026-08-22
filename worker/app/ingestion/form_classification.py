"""Is this actually a polling-unit EC8A? (issue #71)

The README's ingestion diagram promises "form classification". The pipeline
implemented hash, size, geo-fence, EXIF and duplicate checks -- and nothing
that asks whether the uploaded image is the right document at all. The only
thing standing between a wrong upload and our published results was one
sentence in the GPT-4o prompt, whose answer we raised as a generic error and
threw away.

Roughly **one in twenty** documents on INEC's own IReV portal is not a usable
presidential EC8A. From the CCIJ classification of all 176,846:

    exist and not blur     149,205
    blurred                 12,054
    not uploaded             7,493
    wrong_election           2,294
    blur_crowdsourcing       2,022
    ec40g                    1,462
    blank_cancellation       1,217
    collation_paper            745
    blur_crowdsourcing2        176
    blank_with_handwritten_text 99
    irrelevant_picture          51
    selfie                      28

If that is the tail INEC's official channel produced, ours will produce a
comparable one. `collation_paper` deserves particular attention: the roadmap
names the higher collation forms (EC8B/C/D/E) as "the manipulation surface
that produced Rivers-2023". A collation sheet silently extracted as if it
were a polling-unit result is precisely the failure this platform exists to
prevent.

Nothing here discards a submission. Per the pipeline's stated policy, we
"publish evidence and let reviewers + the public see ambiguity, rather than
silently rejecting submissions" -- a wrong form at a contested polling unit
is either an error worth correcting on the spot or an attempt worth
recording, and both want publishing with a loud flag.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class FormClass(str, Enum):
    """What the uploaded document appears to be."""

    EC8A = "ec8a"                            # a polling-unit result sheet
    WRONG_ELECTION = "wrong_election"        # an EC8A, but for another race
    COLLATION_FORM = "collation_form"        # EC8B/C/D/E - ward level and above
    EC40G = "ec40g"                          # cancellation-of-poll form
    CANCELLATION = "cancellation"            # blank / cancelled result sheet
    BLANK = "blank"                          # a form with nothing filled in
    NOT_A_FORM = "not_a_form"                # a photo of something else
    UNKNOWN = "unknown"                      # could not tell


# How an external corpus's condition labels map onto our classes. Used when
# importing labelled data for evaluation, and to keep one vocabulary rather
# than two. Labels describing *legibility* rather than *form type* map to
# None: a blurred EC8A is still an EC8A, and belongs to the quality gate
# (issue #70), not here.
EXTERNAL_STATUS_MAP: dict[str, FormClass | None] = {
    "exist and not blur": FormClass.EC8A,
    "blurred": None,
    "blur_crowdsourcing": None,
    "blur_crowdsourcing2": None,
    "not uploaded": None,
    "wrong_election": FormClass.WRONG_ELECTION,
    "ec40g": FormClass.EC40G,
    "blank_cancellation": FormClass.CANCELLATION,
    "collation_paper": FormClass.COLLATION_FORM,
    "blank_with_handwritten_text": FormClass.BLANK,
    "irrelevant_picture": FormClass.NOT_A_FORM,
    "selfie": FormClass.NOT_A_FORM,
}


@dataclass(frozen=True)
class LayoutSummary:
    """Element counts from a document-layout model.

    Produced by the rectification/layout stage (issue #69). Kept as a plain
    count summary so the thresholds below can be tested, and the whole
    classification reasoned about, without running a vision model.
    """

    n_boxes: int
    n_columns: int
    n_key_values: int
    n_paragraphs: int
    n_tables: int
    has_expected_stamps: bool


# Outlier thresholds published by CCIJ, derived from the distribution of
# element counts over known-valid presidential EC8As. A document breaching any
# of them is not a typical result sheet.
#
# Deliberately tuned to admit false negatives: CCIJ let uncertain cases
# through and sent the flagged ones to human verification. That is the right
# posture for us too -- a missed classification costs a review, while a false
# one casts doubt on a valid result.
MAX_BOXES = 250
MAX_COLUMNS = 10
MIN_KEY_VALUES = 2
MIN_PARAGRAPHS = 1
MIN_TABLES = 2


def layout_outlier_reasons(layout: LayoutSummary) -> list[str]:
    """Which structural expectations this document breaks. Empty means none."""
    reasons: list[str] = []

    if layout.n_boxes > MAX_BOXES:
        reasons.append(f"boxes>{MAX_BOXES}")
    if layout.n_columns > MAX_COLUMNS:
        reasons.append(f"columns>{MAX_COLUMNS}")
    if layout.n_key_values < MIN_KEY_VALUES:
        reasons.append(f"key_values<{MIN_KEY_VALUES}")
    if layout.n_paragraphs < MIN_PARAGRAPHS:
        reasons.append(f"paragraphs<{MIN_PARAGRAPHS}")
    if layout.n_tables < MIN_TABLES:
        reasons.append(f"tables<{MIN_TABLES}")
    if not layout.has_expected_stamps:
        reasons.append("stamps_missing")

    return reasons


@dataclass(frozen=True)
class Classification:
    form_class: FormClass
    reasons: list[str]

    @property
    def is_ec8a(self) -> bool:
        return self.form_class is FormClass.EC8A

    @property
    def should_extract(self) -> bool:
        """Whether to spend an extraction call on this document.

        UNKNOWN still goes through: we would rather pay for an extraction on
        an ambiguous document than refuse to read a valid result because our
        own classifier was unsure.
        """
        return self.form_class in (FormClass.EC8A, FormClass.UNKNOWN)


def classify(
    layout: LayoutSummary | None = None,
    model_verdict: str | None = None,
    external_status: str | None = None,
) -> Classification:
    """Decide what this document is, from whatever evidence is available.

    Evidence is taken in order of directness:

      1. `external_status` - an existing human/crowdsourced label, when
         importing a labelled corpus. Definitive.
      2. `model_verdict` - the extraction backend's own call, e.g. GPT-4o
         returning `not_an_ec8a`. It has seen the image.
      3. `layout` - structural counts. Catches what a model missed, and
         works without one.

    With no evidence at all the answer is UNKNOWN, which still extracts. An
    absent classifier must not become a reason to drop evidence.
    """
    reasons: list[str] = []

    if external_status is not None:
        mapped = EXTERNAL_STATUS_MAP.get(external_status.strip().lower())
        if mapped is not None:
            return Classification(mapped, [f"external_status={external_status}"])
        # A legibility label says nothing about form type; fall through to
        # the other evidence rather than treating "blurred" as "not an EC8A".
        reasons.append(f"external_status={external_status} (not a form-type label)")

    if model_verdict:
        verdict = model_verdict.strip().lower()
        if verdict in ("not_an_ec8a", "not_ec8a"):
            return Classification(
                FormClass.NOT_A_FORM, reasons + ["model_verdict=not_an_ec8a"]
            )
        for name in FormClass:
            if verdict == name.value:
                return Classification(name, reasons + [f"model_verdict={verdict}"])

    if layout is not None:
        outliers = layout_outlier_reasons(layout)
        if outliers:
            # Structure says "not a typical result sheet", but not what it is
            # instead. Naming it would be a guess; UNKNOWN with the reasons
            # attached is the honest answer, and it still gets extracted.
            return Classification(FormClass.UNKNOWN, reasons + outliers)
        return Classification(FormClass.EC8A, reasons)

    return Classification(FormClass.UNKNOWN, reasons)
