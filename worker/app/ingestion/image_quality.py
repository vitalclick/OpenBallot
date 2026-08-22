"""Is this photograph readable at all? (issue #70)

Two cheap checks, run before anything expensive.

**Minimum legible dimensions.** From the CCIJ 2023 analysis, an accident that
turned out to matter: many illegible IReV papers shared one exact size,
192x256 pixels, and that single observation identified over 10,000 election
papers too small for a human to read. Their condition labels bear it out at
scale -- 12,054 documents classified `blurred`, plus another 2,198 routed to
blur crowdsourcing, about 8% of all 176,846.

**Blur.** A sharp photograph of a printed form has strong local intensity
changes at every glyph edge; blurring collapses them. The variance of the
Laplacian separates the two. Milliseconds, no model, no network, and no
dependency beyond Pillow, which the worker already carries.

The pipeline already checks image *bytes* (`min_image_bytes`), which is a poor
proxy: a heavily compressed 4000x3000 photograph can weigh less than a crisp
small one. Pixels are the thing that decides legibility.

Where this belongs
------------------
The real value is at capture time, in the agent's hand, not in a review queue
hours later. The same thresholds run in the PWA (`web/lib/image-quality.ts`)
before a submission enters the offline queue, so an agent standing in front of
the form is told to retake it while retaking is still possible. This module is
the server-side counterpart -- the client check is a courtesy, not a guarantee,
and anything the client reports must be re-derived from the bytes we received.

Advisory, never blocking
------------------------
Neither check rejects a submission. An agent who genuinely cannot get a
sharper photograph -- bad light, a damaged form, a crowd, a hostile polling
unit -- must still be able to submit, and a marginal image of a real result is
worth more than no image. Both produce flags.
"""

from __future__ import annotations

from dataclasses import dataclass

# The dimensions CCIJ found on illegible IReV papers. Anything at or below
# this in either axis cannot be read by a person, so it cannot be verified by
# one either.
ILLEGIBLE_WIDTH = 192
ILLEGIBLE_HEIGHT = 256

# A comfortable floor for a phone photograph of an A4 form. Modern phones
# produce several thousand pixels on the long edge; anything under this has
# been downscaled hard somewhere.
MIN_LEGIBLE_LONG_EDGE = 1_000

# Score below which an image reads as blurred.
#
# NOT CALIBRATED. CCIJ say of their own value of 130 that it is "hypothetical
# and needs to be tuned", and theirs is not transferable anyway -- it was a
# spectral measure, this is variance of the Laplacian, and both depend on
# image size and compression. This must be calibrated against real EC8A
# photographs before it is trusted. Until then it is configurable
# (settings().blur_threshold) so it can be moved on election day without a
# redeploy, and the failure direction is deliberately lenient: a false "too
# blurry" costs an agent's trust, which is worth more than a marginal image.
DEFAULT_BLUR_THRESHOLD = 130.0


@dataclass(frozen=True)
class QualityReport:
    width: int
    height: int
    blur_score: float | None          # None when it could not be computed
    below_legible_dimensions: bool
    likely_blurred: bool

    @property
    def flags(self) -> dict[str, object]:
        """Flag payload to merge into a submission's validation_flags."""
        out: dict[str, object] = {}
        if self.below_legible_dimensions:
            out["image_below_legible_dimensions"] = {
                "width": self.width,
                "height": self.height,
                "min_long_edge": MIN_LEGIBLE_LONG_EDGE,
            }
        if self.likely_blurred:
            out["image_blurred"] = {"blur_score": round(self.blur_score or 0.0, 2)}
        return out

    @property
    def is_usable(self) -> bool:
        """Advisory only. Every caller still accepts the submission."""
        return not (self.below_legible_dimensions or self.likely_blurred)


def below_legible_dimensions(width: int, height: int) -> bool:
    """Too small for a human to read, therefore too small to verify."""
    if width <= 0 or height <= 0:
        return True
    if width <= ILLEGIBLE_WIDTH and height <= ILLEGIBLE_HEIGHT:
        return True
    return max(width, height) < MIN_LEGIBLE_LONG_EDGE


def blur_score(image_bytes: bytes) -> float | None:
    """Sharpness score. Higher is sharper.

    Variance of the Laplacian: a sharp photograph of a printed form has strong
    local intensity changes at every glyph edge, and blurring collapses them.
    Computed with Pillow alone -- already a dependency -- rather than pulling
    numpy into the worker for one FFT. The browser check
    (`web/lib/image-quality.ts`) computes the same quantity the same way, so
    one threshold means the same thing in both places.

    Returns None when the score cannot be computed: an unreadable file, or a
    format Pillow will not open. None means "not measured", and callers must
    not read it as "blurred" -- failing to run a check is not evidence about
    the image.
    """
    try:
        import io

        from PIL import Image, ImageFilter, ImageStat
    except ImportError:
        return None

    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            grey = img.convert("L")
            # Fixed working size keeps the score comparable across a 12MP
            # phone photo and a 1MP scan. Without it the threshold would mean
            # different things for different cameras.
            grey.thumbnail((512, 512))

            laplacian = grey.filter(
                ImageFilter.Kernel(
                    size=(3, 3),
                    kernel=(0, -1, 0, -1, 4, -1, 0, -1, 0),
                    scale=1,
                    offset=128,       # keep negative responses representable
                )
            )
            stats = ImageStat.Stat(laplacian)
            variance = stats.var[0]
    except Exception:
        # Deliberately blind. This is an advisory quality check sitting in the
        # ingestion path: any decoder quirk, truncated upload or exotic format
        # must degrade to "not measured" rather than take down the processing
        # of a real submission. There is no failure here worth losing an EC8A
        # over.
        return None

    if variance is None or variance < 0:
        return None

    # Log scale so the threshold is not dominated by a handful of very sharp
    # edges, and so the range is comfortable to reason about.
    from math import log10

    return float(20 * log10(max(variance, 1e-9) + 1.0))


def evaluate_image_quality(
    *,
    width: int,
    height: int,
    image_bytes: bytes | None = None,
    blur_threshold: float = DEFAULT_BLUR_THRESHOLD,
) -> QualityReport:
    """Assess one image. Never rejects; produces flags."""
    score = blur_score(image_bytes) if image_bytes else None

    return QualityReport(
        width=width,
        height=height,
        blur_score=score,
        below_legible_dimensions=below_legible_dimensions(width, height),
        # An unmeasured score is not a blurred image.
        likely_blurred=score is not None and score < blur_threshold,
    )
