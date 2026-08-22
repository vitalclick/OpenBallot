"""EXIF integrity checks.

We don't trust EXIF for the GPS coordinate (the device sends that directly
in the payload) but absence or obvious tampering of EXIF is a signal worth
publishing - it tells reviewers and the public that the image was edited
or processed before upload.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

SUSPICIOUS_SOFTWARE_HINTS = (
    "photoshop",
    "gimp",
    "snapseed",
    "lightroom",
    "facetune",
    "pixelmator",
)


def evaluate_exif(
    exif: dict[str, Any] | None,
    election_date: datetime | None = None,
) -> dict[str, Any]:
    """Return a dict of validation flags describing EXIF state."""
    flags: dict[str, Any] = {
        "exif_present": exif is not None and bool(exif),
        "exif_integrity_ok": True,
        "exif_software_warning": False,
        "exif_datetime_mismatch": False,
    }

    if not exif:
        flags["exif_integrity_ok"] = False
        return flags

    software = str(exif.get("Software", "")).lower()
    if any(hint in software for hint in SUSPICIOUS_SOFTWARE_HINTS):
        flags["exif_software_warning"] = True
        flags["exif_integrity_ok"] = False

    # If the file claims a capture timestamp, sanity check against election date.
    if election_date is not None and (dt_str := exif.get("DateTimeOriginal")):
        try:
            captured = datetime.strptime(str(dt_str), "%Y:%m:%d %H:%M:%S").replace(
                tzinfo=UTC
            )
            delta_days = abs((captured.date() - election_date.date()).days)
            if delta_days > 1:
                flags["exif_datetime_mismatch"] = True
                flags["exif_integrity_ok"] = False
        except ValueError:
            flags["exif_integrity_ok"] = False

    return flags
