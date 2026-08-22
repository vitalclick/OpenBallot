"""Tests for the ingestion pipeline.

Covers all of the boundary conditions the pipeline is meant to catch:
hash format, GPS geofence, EXIF integrity, duplicate party submissions.
"""

from datetime import datetime, timezone
from uuid import uuid4

from app.ingestion import IngestionPipeline
from app.ingestion.pipeline import IngestionContext, ValidationFlag
from app.models import GPSPoint, IngestionPayload, SubmissionSource


PU_LAT, PU_LNG = 6.4969, 3.3515  # Surulere Ward 4 / Unit 1


def _payload(**overrides) -> IngestionPayload:
    base = {
        "election_id": "2027-presidential",
        "pu_code": "25-11-04-001",
        "source_type": SubmissionSource.PARTY_AGENT,
        "party_code": "APC",
        "image_url": "https://cdn.openballot.ng/ec8a/test.jpg",
        "image_sha256": "a" * 64,
        "image_bytes": 800_000,
        "gps": GPSPoint(lat=PU_LAT, lng=PU_LNG, accuracy_metres=8),
        "captured_at": datetime(2027, 2, 27, 17, 43, 22, tzinfo=timezone.utc),
        "exif_metadata": {"Software": "iOS 18.2", "DateTimeOriginal": "2027:02:27 17:43:22"},
        "client_submission_uuid": uuid4(),
    }
    base.update(overrides)
    return IngestionPayload(**base)


def _ctx(**overrides) -> IngestionContext:
    base = dict(
        pu_lat=PU_LAT,
        pu_lng=PU_LNG,
        election_date=datetime(2027, 2, 27, tzinfo=timezone.utc),
        min_image_bytes=60_000,
        max_image_bytes=12_000_000,
        gps_soft_metres=100,
        gps_hard_metres=2_000,
        existing_party_submission=False,
    )
    base.update(overrides)
    return IngestionContext(**base)


def test_happy_path_accepts_submission():
    r = IngestionPipeline().run(_payload(), _ctx())
    assert r.accepted is True
    assert r.flags == {ValidationFlag.OK.value: True}


def test_malformed_hash_rejected():
    r = IngestionPipeline().run(_payload(image_sha256="NOT_HEX_" + "a" * 56), _ctx())
    assert r.accepted is False
    assert ValidationFlag.HASH_MALFORMED.value in r.flags


def test_oversize_image_rejected():
    r = IngestionPipeline().run(_payload(image_bytes=20_000_000), _ctx())
    assert r.accepted is False


def test_geofence_warning_at_500m_does_not_block():
    # ~500m east of PU lng
    r = IngestionPipeline().run(
        _payload(gps=GPSPoint(lat=PU_LAT, lng=PU_LNG + 0.0045)), _ctx()
    )
    assert r.accepted is True
    assert ValidationFlag.GPS_WARNING.value in r.flags


def test_geofence_hard_violation_rejected():
    # ~5km east
    r = IngestionPipeline().run(
        _payload(gps=GPSPoint(lat=PU_LAT, lng=PU_LNG + 0.045)), _ctx()
    )
    assert r.accepted is False
    assert ValidationFlag.GPS_VIOLATION.value in r.flags


def test_missing_gps_flagged_but_accepted():
    r = IngestionPipeline().run(_payload(gps=None), _ctx())
    assert r.accepted is True
    assert ValidationFlag.GPS_MISSING.value in r.flags


def test_photoshopped_exif_flagged():
    r = IngestionPipeline().run(
        _payload(
            exif_metadata={
                "Software": "Adobe Photoshop 25.0",
                "DateTimeOriginal": "2027:02:27 17:43:22",
            }
        ),
        _ctx(),
    )
    assert r.accepted is True
    assert ValidationFlag.EXIF_SOFTWARE_WARNING.value in r.flags


def test_duplicate_party_submission_rejected():
    r = IngestionPipeline().run(_payload(), _ctx(existing_party_submission=True))
    assert r.accepted is False
    assert ValidationFlag.DUPLICATE_PARTY_SUBMISSION.value in r.flags


def test_duplicate_rule_does_not_apply_to_observers():
    r = IngestionPipeline().run(
        _payload(source_type=SubmissionSource.OBSERVER, party_code=None),
        _ctx(existing_party_submission=True),  # irrelevant for observers
    )
    assert r.accepted is True


# ─── Coordinate precision and absence (migration 0017, issue #65) ──────────
#
# Every polling unit starts with geog NULL, and enrichment resolves co-located
# PUs to a shared point. Neither case can be allowed to reject real evidence.


def test_unknown_pu_coordinates_do_not_crash_and_are_flagged():
    # Before enrichment, geog is NULL for every polling unit, so the API hands
    # the pipeline None for both coordinates. This must not attempt a fence.
    r = IngestionPipeline().run(_payload(), _ctx(pu_lat=None, pu_lng=None))
    assert r.accepted is True
    assert ValidationFlag.PU_COORDINATES_UNKNOWN.value in r.flags
    # The submission carried GPS, so it must not be reported as missing it.
    assert ValidationFlag.GPS_MISSING.value not in r.flags
    assert r.distance_metres is None


def test_shared_site_coordinate_does_not_hard_reject():
    # ~5km east: a hard violation on an exact coordinate. On a coordinate
    # shared with other polling units the distance is real but the fence is
    # not authority enough to discard the EC8A.
    far = _payload(gps=GPSPoint(lat=PU_LAT, lng=PU_LNG + 0.045))
    r = IngestionPipeline().run(far, _ctx(pu_coordinate_precision="shared_site"))

    assert r.accepted is True
    assert ValidationFlag.GPS_VIOLATION.value not in r.flags
    assert ValidationFlag.PU_COORDINATE_APPROXIMATE.value in r.flags
    assert ValidationFlag.GPS_WARNING.value in r.flags

    # The unenforced breach is recorded with its measurements, so a reviewer
    # sees what the fence would have done and why it did not.
    detail = r.flags[ValidationFlag.GEOFENCE_HARD_LIMIT_UNENFORCED.value]
    assert detail["pu_coordinate_precision"] == "shared_site"
    assert detail["hard_limit_metres"] == 2_000
    assert 4_500 < detail["distance_metres"] < 5_500


def test_exact_coordinate_still_hard_rejects():
    # The relaxation must be scoped to imprecise coordinates only.
    far = _payload(gps=GPSPoint(lat=PU_LAT, lng=PU_LNG + 0.045))
    r = IngestionPipeline().run(far, _ctx(pu_coordinate_precision="exact"))
    assert r.accepted is False
    assert ValidationFlag.GPS_VIOLATION.value in r.flags


def test_shared_site_within_soft_fence_is_clean_but_marked():
    # An approximate coordinate is still worth knowing about even when the
    # capture point sits comfortably inside the soft fence.
    r = IngestionPipeline().run(_payload(), _ctx(pu_coordinate_precision="shared_site"))
    assert r.accepted is True
    assert ValidationFlag.PU_COORDINATE_APPROXIMATE.value in r.flags
    assert ValidationFlag.GPS_WARNING.value not in r.flags


def test_missing_precision_does_not_weaken_the_fence():
    # A NULL precision alongside a real coordinate is impossible under the
    # 0017 CHECK constraint, but if it ever occurs the fence must fail toward
    # flagging rather than toward silently discarding evidence.
    far = _payload(gps=GPSPoint(lat=PU_LAT, lng=PU_LNG + 0.045))
    r = IngestionPipeline().run(far, _ctx(pu_coordinate_precision=None))
    assert r.accepted is True
    assert ValidationFlag.GEOFENCE_HARD_LIMIT_UNENFORCED.value in r.flags
