"""Image quality gates (issue #70).

Two properties matter more than the thresholds themselves:

  * advisory, never blocking -- an agent who cannot get a sharper photo must
    still be able to submit
  * an unmeasured score is not a blurred image -- failing to run a check is
    not evidence about the image
"""

from __future__ import annotations

import io

import pytest

from app.ingestion.image_quality import (
    ILLEGIBLE_HEIGHT,
    ILLEGIBLE_WIDTH,
    MIN_LEGIBLE_LONG_EDGE,
    below_legible_dimensions,
    blur_score,
    evaluate_image_quality,
)

pytest.importorskip("PIL")

from PIL import Image


def _png(pixels: list[int], size: int) -> bytes:
    img = Image.new("L", (size, size))
    img.putdata(pixels)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _sharp(size: int = 600) -> bytes:
    """High-frequency content: a fine checkerboard, like printed text."""
    return _png(
        [255 * ((x // 2 + y // 2) % 2) for y in range(size) for x in range(size)],
        size,
    )


def _flat(size: int = 600) -> bytes:
    """No high-frequency content at all - the blurred extreme."""
    return _png([128] * (size * size), size)


# ─── Dimensions ───────────────────────────────────────────────────────────


def test_the_illegible_size_ccij_found_is_rejected():
    """192x256 identified over 10,000 unreadable IReV papers."""
    assert below_legible_dimensions(ILLEGIBLE_WIDTH, ILLEGIBLE_HEIGHT)


def test_a_phone_photograph_passes():
    assert not below_legible_dimensions(3024, 4032)
    assert not below_legible_dimensions(4032, 3024)   # landscape too


def test_downscaled_images_are_flagged():
    assert below_legible_dimensions(MIN_LEGIBLE_LONG_EDGE - 1, 400)


def test_the_long_edge_decides():
    # A tall narrow crop of a form is still readable if the long edge is big.
    assert not below_legible_dimensions(300, MIN_LEGIBLE_LONG_EDGE + 1)


def test_degenerate_dimensions_are_rejected():
    assert below_legible_dimensions(0, 0)
    assert below_legible_dimensions(-1, 5000)


# ─── Blur ─────────────────────────────────────────────────────────────────


def test_sharp_scores_above_flat():
    """The score has to order these two correctly, or the threshold is
    meaningless whatever value it takes."""
    sharp = blur_score(_sharp())
    flat = blur_score(_flat())
    assert sharp is not None and flat is not None
    assert sharp > flat


def test_unreadable_bytes_score_none_not_zero():
    # None means "not measured". Zero would mean "measured, and terrible".
    assert blur_score(b"not an image at all") is None
    assert blur_score(b"") is None


# ─── Reports ──────────────────────────────────────────────────────────────


def test_a_good_image_is_usable_and_unflagged():
    report = evaluate_image_quality(
        width=3024, height=4032, image_bytes=_sharp(), blur_threshold=0.0
    )
    assert report.is_usable
    assert report.flags == {}


def test_a_small_image_is_flagged_with_its_dimensions():
    report = evaluate_image_quality(width=192, height=256, image_bytes=None)
    assert not report.is_usable
    flag = report.flags["image_below_legible_dimensions"]
    assert flag["width"] == 192
    assert flag["height"] == 256


def test_a_blurred_image_is_flagged_with_its_score():
    report = evaluate_image_quality(
        width=3024, height=4032, image_bytes=_flat(), blur_threshold=1e9
    )
    assert report.likely_blurred
    assert "blur_score" in report.flags["image_blurred"]


def test_an_unmeasurable_score_is_never_reported_as_blurred():
    """Failing to run the check is not evidence about the image. Treating it
    as blurred would flag every submission whose bytes we never loaded."""
    report = evaluate_image_quality(width=3024, height=4032, image_bytes=None)
    assert report.blur_score is None
    assert not report.likely_blurred
    assert "image_blurred" not in report.flags


def test_quality_findings_never_reject_a_submission():
    """The whole gate is advisory. A marginal photograph of a real result is
    worth more than no photograph, and an agent who stops trusting the app
    stops submitting."""
    report = evaluate_image_quality(
        width=100, height=100, image_bytes=_flat(), blur_threshold=1e9
    )
    # Both findings fire...
    assert report.below_legible_dimensions
    assert report.likely_blurred
    # ...and the report still only produces flags. There is no reject path
    # here at all: nothing in this module returns a rejection.
    assert set(report.flags) == {"image_below_legible_dimensions", "image_blurred"}
