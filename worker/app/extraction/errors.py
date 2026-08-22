"""Typed extraction errors.

Some extraction "failures" are findings. A backend reporting that the image is
not an EC8A has told us something true and useful about the submission, and
collapsing that into a generic RuntimeError loses it: the job is marked failed,
a stack trace goes to the log, and the public record shows an unexplained gap
where it could have shown "this upload was not a result sheet".

Distinguishing them lets the caller flag and publish rather than fail silently
(issue #71).
"""

from __future__ import annotations


class ExtractionError(RuntimeError):
    """Base for extraction problems."""


class NotAnEC8AError(ExtractionError):
    """The backend judged the image not to be a polling-unit result sheet.

    A classification, not a fault. Carries no retry value: running the same
    image through the same model again will reach the same conclusion, so the
    caller should flag for review rather than re-queue.
    """

    def __init__(self, message: str, *, image_url: str | None = None):
        super().__init__(message)
        self.image_url = image_url

    @property
    def validation_flag(self) -> str:
        # Matches ValidationFlag.NOT_AN_EC8A. Kept as a plain string so the
        # extraction package does not import the ingestion package.
        return "not_an_ec8a"
