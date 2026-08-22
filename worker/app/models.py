"""Pydantic models for cross-service contracts.

These are the wire formats used by the public API, the agent PWA upload
endpoint, and inter-service queue messages. Keep them stable: every change
here is a coordinated change across web + worker.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


class ElectionType(str, Enum):
    PRESIDENTIAL = "presidential"
    SENATE = "senate"
    REPS = "reps"
    GOVERNORSHIP = "governorship"
    STHA = "stha"
    FCT_AREA = "fct_area"
    LGA = "lga"


class SubmissionSource(str, Enum):
    PARTY_AGENT = "party_agent"
    OBSERVER = "observer"
    INEC_IREV = "inec_irev"


class VerificationStatus(str, Enum):
    NO_DATA = "no_data"
    SINGLE_SOURCE = "single_source"
    INEC_PUBLISHED = "inec_published"   # INEC IReV is the only source
    CONSENSUS = "consensus"
    DISCREPANCY = "discrepancy"
    INEC_CONFIRMED = "inec_confirmed"
    INEC_CONFLICT = "inec_conflict"


class GPSPoint(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    accuracy_metres: float | None = None
    captured_at: datetime | None = None


class ExtractedEC8A(BaseModel):
    """Structured payload produced by the extraction engine."""

    pu_code: str
    registered_voters: int = Field(ge=0)
    accredited_voters: int = Field(ge=0)
    candidate_votes: dict[str, int]            # {party_code: votes}
    # EC8A records every count twice, in figures and in words. The words are
    # kept verbatim as read, not as a parsed number: they are the second
    # channel's evidence, and a reviewer looking at a disputed cell needs to
    # see what was actually written. Reconciliation lives in
    # extraction/word_numbers.py. None when the backend did not read them.
    candidate_votes_words: dict[str, str] | None = None
    total_valid_votes: int = Field(ge=0)
    rejected_ballots: int = Field(ge=0)
    total_votes_cast: int = Field(ge=0)
    presiding_officer_signed: bool
    agent_signatures_detected: int = Field(ge=0)
    official_stamp_present: bool

    @field_validator("candidate_votes")
    @classmethod
    def votes_non_negative(cls, v: dict[str, int]) -> dict[str, int]:
        for party, votes in v.items():
            if votes < 0:
                raise ValueError(f"votes for {party} must be non-negative")
        return v


class IngestionPayload(BaseModel):
    """What the PWA POSTs to the upload endpoint."""

    election_id: str
    pu_code: str
    source_type: SubmissionSource
    party_code: str | None = None
    image_url: str                              # already uploaded to object storage
    image_sha256: str = Field(min_length=64, max_length=64)
    image_bytes: int = Field(gt=0)
    gps: GPSPoint | None = None
    captured_at: datetime | None = None
    exif_metadata: dict[str, Any] | None = None
    client_submission_uuid: UUID | None = None  # idempotency token from offline queue


class SubmissionRecord(BaseModel):
    id: UUID
    election_id: str
    pu_code: str
    source_type: SubmissionSource
    party_code: str | None
    image_url: str
    image_sha256: str
    gps: GPSPoint | None
    submitted_at: datetime
    confidence_score: float | None
    extracted_data: ExtractedEC8A | None
    validation_flags: dict[str, Any]
    review_status: str


class VerificationOutcome(BaseModel):
    election_id: str
    pu_code: str
    status: VerificationStatus
    submission_count: int
    source_count: int
    consensus_data: ExtractedEC8A | None
    discrepant_fields: list[str] = []
    computed_at: datetime
