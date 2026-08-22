"""Layout geometry: boxes, overlap, orientation and crop bounds (issue #69).

Pure functions over detected elements. No model, no image, no torch -- so the
judgements encoded here can be tested directly.

The orientation logic is the interesting part. Election documents arrive
upside down, sideways and tilted, and a page of handwritten numbers offers no
reliable text-line signal to correct by. CCIJ's insight was to orient from
*semantics* instead: the INEC logo sits at the top of a correctly oriented
EC8A, so wherever the logo is, that is the top. It is unambiguous in a way
pixel statistics are not.
"""

from __future__ import annotations

from dataclasses import dataclass
from statistics import median

# Classes the layout detector emits, in its label order.
LABELS = (
    "box", "table", "column", "header",
    "signature", "figure", "paragraph", "logo", "kv", "stamp",
)


@dataclass(frozen=True)
class LayoutBox:
    """One detected element, as an oriented bounding box.

    Corners are in image pixels, in detector order. Oriented rather than
    axis-aligned because these documents are photographed at an angle far more
    often than they are scanned flat.
    """

    label: str
    confidence: float
    corners: tuple[tuple[float, float], ...]   # 4 (x, y) pairs
    angle_degrees: float = 0.0

    @property
    def xs(self) -> tuple[float, ...]:
        return tuple(x for x, _ in self.corners)

    @property
    def ys(self) -> tuple[float, ...]:
        return tuple(y for _, y in self.corners)

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        """Axis-aligned (x1, y1, x2, y2) enclosing the oriented box."""
        return min(self.xs), min(self.ys), max(self.xs), max(self.ys)

    @property
    def centroid(self) -> tuple[float, float]:
        return sum(self.xs) / 4, sum(self.ys) / 4

    @property
    def width(self) -> float:
        x1, _, x2, _ = self.bounds
        return x2 - x1

    @property
    def height(self) -> float:
        _, y1, _, y2 = self.bounds
        return y2 - y1

    @property
    def area(self) -> float:
        return self.width * self.height


def _rect_intersection(a: LayoutBox, b: LayoutBox) -> float:
    ax1, ay1, ax2, ay2 = a.bounds
    bx1, by1, bx2, by2 = b.bounds
    w = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    h = max(0.0, min(ay2, by2) - max(ay1, by1))
    return w * h


def polygon_iou(a: LayoutBox, b: LayoutBox) -> float:
    """Intersection over union of two elements.

    Computed on the axis-aligned bounds rather than the true oriented
    polygons. For near-duplicate detections of the same element -- which is
    what this is used for -- the two agree closely, and the approximation
    avoids a polygon-clipping dependency (CCIJ used shapely) in a service
    where every dependency is a supply-chain question.
    """
    inter = _rect_intersection(a, b)
    union = a.area + b.area - inter
    return inter / union if union > 0 else 0.0


def inside_ratio(inner: LayoutBox, outer: LayoutBox) -> float:
    """How much of `inner` falls within `outer`, 0-1.

    Distinct from IoU: a small signature sitting inside a large table has a
    tiny IoU but an inside-ratio of 1. Containment is the question when asking
    "is this signature in the agent column".
    """
    if inner.area <= 0:
        return 0.0
    return _rect_intersection(inner, outer) / inner.area


def nms_classwise(boxes: list[LayoutBox], iou_threshold: float = 0.3) -> list[LayoutBox]:
    """Suppress duplicate detections, per class.

    Per class, not globally: a stamp overlapping a signature is a real and
    meaningful arrangement on these forms -- it is how a presiding officer
    endorses a result -- and suppressing one because of the other would
    destroy exactly the evidence issue #72 needs.
    """
    kept: list[LayoutBox] = []
    by_label: dict[str, list[LayoutBox]] = {}
    for box in boxes:
        by_label.setdefault(box.label, []).append(box)

    for label_boxes in by_label.values():
        for box in sorted(label_boxes, key=lambda b: b.confidence, reverse=True):
            if all(polygon_iou(box, k) <= iou_threshold for k in kept
                   if k.label == box.label):
                kept.append(box)

    return kept


def median_tilt(boxes: list[LayoutBox]) -> float | None:
    """Median tilt of the page, or None when the boxes do not agree.

    Angles are folded about 90 degrees first: a rectangle at 3 degrees and one
    at 177 describe the same tilt, and averaging them raw gives 90, which is
    the one answer that is certainly wrong.

    None when the elements disagree too much to call -- which is itself
    informative, since it usually means the detection is poor rather than the
    page being at some unusual angle.
    """
    if not boxes:
        return None

    folded = [a if a <= 90 else 180 - a for a in (b.angle_degrees % 180 for b in boxes)]

    bins = [0] * 6                        # 0-15, 15-30, ... 75-90
    for angle in folded:
        bins[min(int(angle // 15), 5)] += 1

    top_two = sum(sorted(bins, reverse=True)[:2])
    if top_two / len(folded) * 100 <= 80:
        return None

    return median(folded)


def infer_orientation(
    boxes: list[LayoutBox],
    page_width: float,
    page_height: float,
) -> float | None:
    """How far to rotate the page to bring it upright, in degrees.

    Oriented from the INEC logo, falling back to the header. A page of
    handwritten numbers has no reliable text-line orientation, but the logo
    belongs at the top of a correctly oriented EC8A, so wherever the logo sits
    tells us which edge is up.

    Returns None when it cannot be determined. None means "do not rotate",
    not "rotate by zero": the caller passes the page through unchanged and
    flags it, rather than confidently rotating a document on a guess.
    """
    tilt = median_tilt(boxes)
    if tilt is None:
        return None

    for label in ("logo", "header"):
        anchors = [b for b in boxes if b.label == label]
        if not anchors:
            continue

        # Most confident, then topmost -- the same order CCIJ used.
        anchor = min(anchors, key=lambda b: (-b.confidence, b.centroid[1]))
        cx, cy = anchor.centroid

        if tilt < 25:                       # page is upright or inverted
            if cy < page_height / 3:
                return tilt                 # anchor at the top: already up
            if cy > 2 * page_height / 3:
                return 180 - tilt           # anchor at the bottom: inverted
        elif tilt > 75:                     # page is on its side
            if cx < page_width / 3:
                return 90
            if cx > 2 * page_width / 3:
                return -90

    return None


def document_roi(
    boxes: list[LayoutBox],
    page_width: float,
    page_height: float,
    margin: float = 0.15,
) -> tuple[int, int, int, int]:
    """Crop bounds (x1, y1, x2, y2) around the form itself.

    Photographs of these documents carry a lot of desk, hand and floor.
    Structure gives the bounds: tables set the horizontal extent, the
    logo/header the top, the bottom stamp the base.

    Every bound falls back to the full page. A crop that removes part of the
    result table would silently destroy votes, so where the evidence is
    missing or implausible the page is left whole -- the sanity clamps below
    exist for exactly that.
    """
    x1, y1, x2, y2 = 0.0, 0.0, float(page_width), float(page_height)

    tables = [b for b in boxes if b.label == "table"]
    if tables:
        x1 = min(min(b.xs) for b in tables)
        x2 = max(max(b.xs) for b in tables)

    tops = [b for b in boxes if b.label in ("logo", "header")]
    if tops:
        y1 = min(min(b.ys) for b in tops)

    stamps = [b for b in boxes if b.label == "stamp"]
    if stamps:
        y2 = max(max(b.ys) for b in stamps)

    pad_x = margin * (x2 - x1)
    pad_y = margin * (y2 - y1)
    x1, x2 = x1 - pad_x, x2 + pad_x
    y1, y2 = y1 - pad_y, y2 + pad_y

    # Sanity clamps: if a bound has landed somewhere that would cut into the
    # body of the form, distrust it and take the full page on that axis.
    if x1 >= page_width / 2:
        x1 = 0.0
    if y1 > page_height / 4:
        y1 = 0.0
    if x2 < page_width / 2:
        x2 = float(page_width)
    if y2 < 3 * page_height / 4:
        y2 = float(page_height)

    return (
        max(0, int(x1)),
        max(0, int(y1)),
        min(int(page_width), int(x2)),
        min(int(page_height), int(y2)),
    )


def layout_summary(boxes: list[LayoutBox], *, has_expected_stamps: bool | None = None):
    """Element counts, in the shape form classification expects (issue #71)."""
    from ..ingestion.form_classification import LayoutSummary

    def count(label: str) -> int:
        return sum(1 for b in boxes if b.label == label)

    return LayoutSummary(
        n_boxes=count("box"),
        n_columns=count("column"),
        n_key_values=count("kv"),
        n_paragraphs=count("paragraph"),
        n_tables=count("table"),
        has_expected_stamps=(
            count("stamp") > 0 if has_expected_stamps is None else has_expected_stamps
        ),
    )
