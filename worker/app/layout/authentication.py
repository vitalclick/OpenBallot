"""Who signed, and who stamped (issue #72).

`ExtractedEC8A` carries the three fields that make a result sheet legally
meaningful:

    presiding_officer_signed
    agent_signatures_detected
    official_stamp_present

We populate them by asking a vision model, in prose, to count signatures and
say whether the officer signed. There is no ground truth anywhere in the test
suite, and an unsigned EC8A is not a valid result -- getting this wrong in
either direction matters. Missing a genuine signature casts doubt on a clean
form; inventing one launders an unsigned one.

Position decides it, not appearance. From CCIJ's method:

> We identified the presiding officer's signature by its location at the
> bottom part of the page. Polling agent signatures were distinguished by
> their consistent placement inside specific tables. Different stamps were
> recognized based on their distinct positions, such as the black stamp
> typically found at the bottom left and orange stamps in the middle of the
> page.

That is more defensible than a model's boolean, because *position is what
makes the distinction in the first place*. A signature in the agent column is
not the presiding officer's, however confident a model is that it is a
signature. A detector that can only say "signature here" plus geometry can
answer the question; a model asked "did the officer sign?" is guessing at a
role the pixels do not carry.

Everything here is pure geometry over detected boxes -- no model, no image.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from .geometry import LayoutBox, inside_ratio, polygon_iou


class StampPosition(str, Enum):
    """Where a stamp sits, which is what distinguishes the stamps."""

    MIDDLE = "stamp_middle"                  # inside the results table
    BOTTOM_MIDDLE = "stamp_bottom_middle"    # below the table, centred
    BOTTOM_LEFT = "stamp_bottom_left"        # the presiding officer's stamp
    UNPLACED = "stamp_unplaced"


class SignaturePosition(str, Enum):
    AGENT_COLUMN = "signature_in_agent_column"    # a party agent
    BELOW_DOCUMENT = "signature_below_document"   # the presiding officer
    IN_PARAGRAPH = "signature_in_paragraph"       # a declaration signature
    UNPLACED = "signature_unplaced"


@dataclass(frozen=True)
class AuthenticationReport:
    presiding_officer_signed: bool
    agent_signatures_detected: int
    official_stamp_present: bool

    stamps: dict[str, int]
    signatures: dict[str, int]

    @property
    def is_fully_authenticated(self) -> bool:
        return (
            self.presiding_officer_signed
            and self.official_stamp_present
            and self.agent_signatures_detected > 0
        )

    @property
    def missing(self) -> list[str]:
        """Which required elements are absent. Publishable as findings.

        CCIJ found 3,955 forms missing a presiding officer's signature and
        13,000 missing the black stamp across the 2023 corpus.
        """
        out = []
        if not self.presiding_officer_signed:
            out.append("presiding_officer_signature")
        if not self.official_stamp_present:
            out.append("official_stamp")
        if self.agent_signatures_detected == 0:
            out.append("polling_agent_signatures")
        return out


# A stamp detection below this is too weak to assert an official endorsement.
# Higher than the signature floor: a false stamp claims the form was formally
# endorsed, which is a stronger and more consequential assertion than a false
# signature count.
STAMP_CONFIDENCE_FLOOR = 0.40
SIGNATURE_CONFIDENCE_FLOOR = 0.25


def _largest_table(boxes: list[LayoutBox]) -> LayoutBox | None:
    tables = [b for b in boxes if b.label == "table"]
    return max(tables, key=lambda b: b.height, default=None)


def classify_stamps(
    boxes: list[LayoutBox],
    page_width: float,
) -> dict[StampPosition, list[LayoutBox]]:
    """Place each stamp by where it sits relative to the results table."""
    stamps = [
        b for b in boxes
        if b.label == "stamp" and b.confidence > STAMP_CONFIDENCE_FLOOR
    ]
    signatures = [b for b in boxes if b.label == "signature"]
    out: dict[StampPosition, list[LayoutBox]] = {p: [] for p in StampPosition}

    table = _largest_table(boxes)
    if table is None:
        # Without the table there is no frame of reference, so nothing can be
        # placed. Recorded as unplaced rather than guessed at.
        out[StampPosition.UNPLACED].extend(stamps)
        return out

    _, table_top, _, table_bottom = table.bounds

    middle: LayoutBox | None = None
    for stamp in sorted(stamps, key=lambda b: -b.confidence):
        cx, cy = stamp.centroid
        if table_top <= cy <= table_bottom and inside_ratio(stamp, table) > 0.5:
            out[StampPosition.MIDDLE].append(stamp)
            if middle is None:
                middle = stamp
            continue

        if cy <= table_bottom:
            out[StampPosition.UNPLACED].append(stamp)
            continue

        # Below the table. Horizontal position separates the officer's stamp
        # (left) from the centred one.
        if middle is not None:
            mx1, _, mx2, _ = middle.bounds
            in_centre_band = mx1 < cx < mx2
        else:
            in_centre_band = page_width / 3 < cx < 2 * page_width / 3

        if in_centre_band:
            out[StampPosition.BOTTOM_MIDDLE].append(stamp)
        else:
            # A stamp that largely covers a signature is the officer
            # endorsing their own signature -- the classic bottom-left
            # arrangement -- rather than a separate mark.
            overlapping = any(
                polygon_iou(stamp, sig) >= 0.5 and sig.area < stamp.area
                for sig in signatures
            )
            if overlapping or cx < page_width / 2:
                out[StampPosition.BOTTOM_LEFT].append(stamp)
            else:
                out[StampPosition.UNPLACED].append(stamp)

    return out


def classify_signatures(
    boxes: list[LayoutBox],
    page_height: float,
) -> dict[SignaturePosition, list[LayoutBox]]:
    """Place each signature: agent column, below the document, or declaration.

    This is the distinction the schema needs and a model cannot reliably make:
    a signature's role on an EC8A is defined by where it is written.
    """
    signatures = [
        b for b in boxes
        if b.label == "signature" and b.confidence > SIGNATURE_CONFIDENCE_FLOOR
    ]
    columns = [b for b in boxes if b.label == "column"]
    paragraphs = [b for b in boxes if b.label == "paragraph"]
    table = _largest_table(boxes)
    out: dict[SignaturePosition, list[LayoutBox]] = {p: [] for p in SignaturePosition}

    # The agent column is the rightmost column of the results table: agents
    # sign against the row for their own party.
    agent_column: LayoutBox | None = None
    if table is not None and columns:
        in_table = [c for c in columns if inside_ratio(c, table) > 0.3]
        if in_table:
            agent_column = max(in_table, key=lambda c: c.centroid[0])

    for sig in signatures:
        _, cy = sig.centroid

        if agent_column is not None and inside_ratio(sig, agent_column) > 0.5:
            out[SignaturePosition.AGENT_COLUMN].append(sig)
            continue

        if any(inside_ratio(sig, p) > 0.5 for p in paragraphs):
            out[SignaturePosition.IN_PARAGRAPH].append(sig)
            continue

        # Below the table, in the bottom quarter of the page: the presiding
        # officer's block.
        below_table = table is None or cy > table.bounds[3]
        if below_table and cy > 0.7 * page_height:
            out[SignaturePosition.BELOW_DOCUMENT].append(sig)
        else:
            out[SignaturePosition.UNPLACED].append(sig)

    return out


def evaluate_authentication(
    boxes: list[LayoutBox],
    page_width: float,
    page_height: float,
) -> AuthenticationReport:
    """Fill the three schema fields from geometry.

    Note what counts as the presiding officer's signature: one placed *below
    the document*, not merely any signature. A form covered in agent
    signatures but unsigned by the officer is not a validly completed EC8A,
    and must not read as one.
    """
    stamps = classify_stamps(boxes, page_width)
    signatures = classify_signatures(boxes, page_height)

    officer_signed = bool(signatures[SignaturePosition.BELOW_DOCUMENT])
    agent_count = len(signatures[SignaturePosition.AGENT_COLUMN])

    # The official stamp is the officer's, at bottom left. A stamp inside the
    # table is a different mark and does not stand in for it.
    stamp_present = bool(
        stamps[StampPosition.BOTTOM_LEFT] or stamps[StampPosition.BOTTOM_MIDDLE]
    )

    return AuthenticationReport(
        presiding_officer_signed=officer_signed,
        agent_signatures_detected=agent_count,
        official_stamp_present=stamp_present,
        stamps={p.value: len(v) for p, v in stamps.items()},
        signatures={p.value: len(v) for p, v in signatures.items()},
    )
