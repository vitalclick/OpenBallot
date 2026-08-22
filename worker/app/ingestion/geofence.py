"""GPS geofence check.

Submissions are flagged - not blocked - if the capture point falls outside
the soft fence. They are discarded outright only if the point is implausibly
far from the registered PU coordinates (e.g. submission from a different
state, which strongly suggests fraud or device-clock spoofing).

A hard reject is the one ingestion outcome an agent cannot recover from: the
submission is refused and the EC8A goes back in the folder. That is only a
defensible response when the registered coordinate is precise enough to bear
it. Rosters resolve co-located polling units - several PUs in one school or
market - to a single shared point. In the CCIJ 2023 roster that is 20,542
polling units, 11.6% of those with a coordinate. An agent standing at the
right polling unit can be hundreds of metres from such a point through no
fault of their own.

So the hard fence applies only where `polling_units.geog_precision` is
`exact` (see migration 0017). Elsewhere the distance is still measured and
still flagged - it is evidence either way - but it does not discard the
submission.
"""

from __future__ import annotations

from math import asin, cos, radians, sin, sqrt

# Precisions on which a hard reject may be based. Anything else measures and
# flags without discarding.
HARD_FENCE_PRECISIONS = frozenset({"exact"})


def haversine_metres(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance between two WGS84 points in metres."""
    r = 6_371_000.0
    phi1, phi2 = radians(lat1), radians(lat2)
    dphi = radians(lat2 - lat1)
    dlmb = radians(lng2 - lng1)
    a = sin(dphi / 2) ** 2 + cos(phi1) * cos(phi2) * sin(dlmb / 2) ** 2
    return 2 * r * asin(sqrt(a))


def evaluate_geofence(
    capture_lat: float,
    capture_lng: float,
    pu_lat: float,
    pu_lng: float,
    soft_metres: int,
    hard_metres: int,
    precision: str | None = "exact",
) -> tuple[float, str]:
    """Return (distance_metres, decision).

    decision ∈ {
        "ok",
        "geofence_warning",
        "geofence_violation",          # beyond the hard fence, and enforced
        "geofence_hard_limit_unenforced",  # beyond it, but the coordinate
                                           # is not precise enough to enforce
    }

    `precision` is the polling unit's `geog_precision`. The default of
    "exact" preserves the original behaviour for callers that do not supply
    one, so an omitted precision never silently weakens the fence.
    """
    d = haversine_metres(capture_lat, capture_lng, pu_lat, pu_lng)
    if d <= soft_metres:
        return d, "ok"
    if d <= hard_metres:
        return d, "geofence_warning"
    if precision in HARD_FENCE_PRECISIONS:
        return d, "geofence_violation"
    return d, "geofence_hard_limit_unenforced"
