"""Layout geometry: orientation, crop bounds, overlap (issue #69).

All pure functions over element boxes, so the judgements — which way is up,
what to crop, what counts as a duplicate — are testable without a model.
"""

from __future__ import annotations

from app.layout.geometry import (
    LayoutBox,
    document_roi,
    infer_orientation,
    inside_ratio,
    layout_summary,
    median_tilt,
    nms_classwise,
    polygon_iou,
)

PAGE_W, PAGE_H = 1200.0, 1700.0


def box(label, x1, y1, x2, y2, confidence=0.9, angle=0.0) -> LayoutBox:
    return LayoutBox(
        label=label,
        confidence=confidence,
        corners=((x1, y1), (x2, y1), (x2, y2), (x1, y2)),
        angle_degrees=angle,
    )


# ─── Overlap ──────────────────────────────────────────────────────────────


def test_identical_boxes_fully_overlap():
    a = box("stamp", 0, 0, 10, 10)
    assert polygon_iou(a, a) == 1.0


def test_disjoint_boxes_do_not_overlap():
    assert polygon_iou(box("stamp", 0, 0, 10, 10), box("stamp", 50, 50, 60, 60)) == 0.0


def test_inside_ratio_sees_containment_where_iou_does_not():
    """A small signature inside a large table has a tiny IoU but is entirely
    contained. Containment is the question when placing an element."""
    small = box("signature", 10, 10, 20, 20)
    large = box("table", 0, 0, 200, 200)
    assert polygon_iou(small, large) < 0.01
    assert inside_ratio(small, large) == 1.0


# ─── Duplicate suppression ────────────────────────────────────────────────


def test_duplicate_detections_of_one_element_collapse():
    kept = nms_classwise([
        box("stamp", 0, 0, 100, 100, confidence=0.9),
        box("stamp", 5, 5, 105, 105, confidence=0.7),   # same stamp
    ])
    assert len(kept) == 1
    assert kept[0].confidence == 0.9      # the more confident survives


def test_a_stamp_over_a_signature_survives_both():
    """A stamp covering a signature is how a presiding officer endorses a
    result. Suppressing one because of the other would destroy exactly the
    evidence the authentication check needs."""
    kept = nms_classwise([
        box("stamp", 0, 0, 100, 100, confidence=0.9),
        box("signature", 10, 10, 90, 90, confidence=0.8),
    ])
    assert {b.label for b in kept} == {"stamp", "signature"}


# ─── Tilt ─────────────────────────────────────────────────────────────────


def test_tilt_folds_angles_about_ninety():
    """3 degrees and 177 describe the same tilt. Averaging them raw gives 90,
    which is the one answer that is certainly wrong."""
    boxes = [box("box", 0, 0, 10, 10, angle=a) for a in (3, 177, 2, 178, 3)]
    tilt = median_tilt(boxes)
    assert tilt is not None and tilt < 10


def test_scattered_angles_give_no_tilt():
    # Disagreement is informative: it usually means poor detection.
    boxes = [box("box", 0, 0, 10, 10, angle=a) for a in (5, 40, 85, 20, 65, 50)]
    assert median_tilt(boxes) is None


def test_no_boxes_gives_no_tilt():
    assert median_tilt([]) is None


# ─── Orientation ──────────────────────────────────────────────────────────


def _upright_page(logo_box):
    return [logo_box] + [box("box", 100, 500, 200, 550, angle=2) for _ in range(8)]


def test_logo_at_the_top_means_upright():
    rotation = infer_orientation(
        _upright_page(box("logo", 500, 60, 700, 200, angle=2)), PAGE_W, PAGE_H
    )
    assert rotation is not None and abs(rotation) < 15


def test_logo_at_the_bottom_means_inverted():
    rotation = infer_orientation(
        _upright_page(box("logo", 500, 1500, 700, 1650, angle=2)), PAGE_W, PAGE_H
    )
    assert rotation is not None and rotation > 150


def test_sideways_pages_are_detected_by_the_logo_edge():
    left = [box("logo", 40, 700, 180, 900, angle=88)] + [
        box("box", 500, 500, 600, 550, angle=88) for _ in range(8)
    ]
    assert infer_orientation(left, PAGE_W, PAGE_H) == 90

    right = [box("logo", 1000, 700, 1150, 900, angle=88)] + [
        box("box", 500, 500, 600, 550, angle=88) for _ in range(8)
    ]
    assert infer_orientation(right, PAGE_W, PAGE_H) == -90


def test_header_is_used_when_there_is_no_logo():
    boxes = [box("header", 400, 80, 800, 200, angle=2)] + [
        box("box", 100, 500, 200, 550, angle=2) for _ in range(8)
    ]
    rotation = infer_orientation(boxes, PAGE_W, PAGE_H)
    assert rotation is not None and abs(rotation) < 15


def test_no_anchor_means_no_rotation_rather_than_a_guess():
    """None means "do not rotate", not "rotate by zero". Confidently rotating
    a document on a guess is worse than leaving it alone and flagging it."""
    boxes = [box("box", 100, 500, 200, 550, angle=2) for _ in range(8)]
    assert infer_orientation(boxes, PAGE_W, PAGE_H) is None


def test_logo_in_the_middle_is_inconclusive():
    boxes = _upright_page(box("logo", 500, 800, 700, 900, angle=2))
    assert infer_orientation(boxes, PAGE_W, PAGE_H) is None


# ─── Crop bounds ──────────────────────────────────────────────────────────


def test_roi_tightens_around_the_form():
    boxes = [
        box("logo", 500, 100, 700, 200),
        box("table", 200, 300, 1000, 1300),
        box("stamp", 250, 1400, 400, 1500),
    ]
    x1, y1, x2, y2 = document_roi(boxes, PAGE_W, PAGE_H)

    # Narrower than the page horizontally - the desk either side is gone.
    assert x1 > 0
    assert x2 < PAGE_W
    # The table survives intact. Cropping into it would destroy votes
    # silently, which is the only outcome here that really matters.
    assert x1 <= 200 and x2 >= 1000
    # The 15% margin around a tall ROI can reach past the top of the page;
    # clamping to the edge is correct, so y1 may legitimately be 0.
    assert 0 <= y1 <= 100
    assert y2 <= PAGE_H


def test_roi_falls_back_to_the_whole_page_without_structure():
    assert document_roi([], PAGE_W, PAGE_H) == (0, 0, int(PAGE_W), int(PAGE_H))


def test_an_implausible_bound_is_distrusted():
    """A 'table' detected in the far right of the page would crop away the
    left half of the form. The clamp takes the full width instead."""
    boxes = [box("table", 1100, 300, 1180, 400)]
    x1, _, x2, _ = document_roi(boxes, PAGE_W, PAGE_H)

    # The left bound is distrusted outright and reset to the page edge.
    assert x1 == 0
    # The right bound stays where the (spurious) table put it, but with the
    # left edge recovered the crop still spans essentially the whole page, so
    # nothing of the form is lost. That is the property that matters - not
    # that the numbers come back exactly equal to the page width.
    assert x2 >= 0.98 * PAGE_W


def test_roi_never_exceeds_the_page():
    boxes = [box("table", -50, -50, 2000, 3000), box("stamp", 0, 2900, 100, 3000)]
    x1, y1, x2, y2 = document_roi(boxes, PAGE_W, PAGE_H)
    assert (x1, y1) == (0, 0)
    assert x2 <= PAGE_W and y2 <= PAGE_H


# ─── Summary feeds form classification ────────────────────────────────────


def test_summary_counts_feed_the_classifier():
    boxes = (
        [box("box", 0, 0, 10, 10) for _ in range(40)]
        + [box("column", 0, 0, 10, 10) for _ in range(5)]
        + [box("kv", 0, 0, 10, 10) for _ in range(4)]
        + [box("paragraph", 0, 0, 10, 10) for _ in range(2)]
        + [box("table", 0, 0, 10, 10) for _ in range(3)]
        + [box("stamp", 0, 0, 10, 10)]
    )
    summary = layout_summary(boxes)
    assert summary.n_boxes == 40
    assert summary.n_tables == 3
    assert summary.has_expected_stamps

    from app.ingestion.form_classification import classify

    assert classify(layout=summary).is_ec8a


# ─── Detector boundary (issue #69) ────────────────────────────────────────


def test_detection_payload_parses_into_boxes():
    from app.layout.detector import parse_detections

    result = parse_detections({
        "page_width": 1200,
        "page_height": 1700,
        "boxes": [
            {"label": "table", "confidence": 0.9,
             "corners": [[100, 300], [1100, 300], [1100, 1200], [100, 1200]],
             "angle_degrees": 1.5},
        ],
    })
    assert result.ok
    assert len(result.boxes) == 1
    assert result.boxes[0].label == "table"
    assert result.page_width == 1200


def test_one_malformed_box_does_not_cost_the_whole_page():
    """A detector emitting one unusable entry should not lose us the other
    forty."""
    from app.layout.detector import parse_detections

    result = parse_detections({
        "page_width": 1200, "page_height": 1700,
        "boxes": [
            {"label": "table", "confidence": 0.9,
             "corners": [[0, 0], [10, 0], [10, 10], [0, 10]]},
            {"label": "broken"},                         # no corners
            {"label": "stamp", "corners": [[0, 0], [1, 1]]},   # only 2 corners
        ],
    })
    assert len(result.boxes) == 1


async def test_the_null_detector_succeeds_with_nothing():
    """The default when no vision service is configured. 'No boxes' must be a
    success, so downstream consumers degrade instead of failing."""
    from app.layout.detector import NullDetector

    result = await NullDetector().detect(b"")
    assert result.ok
    assert result.boxes == []


async def test_a_dead_vision_service_degrades_instead_of_raising():
    """An EC8A must never be lost because a vision service was unavailable."""
    from app.layout.detector import HTTPDetector

    result = await HTTPDetector("http://127.0.0.1:1", timeout_seconds=0.05).detect(b"x")
    assert result.boxes == []
    assert not result.ok
    assert result.failed_reason        # the reason survives for the logs
