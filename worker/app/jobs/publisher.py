"""Redis pub/sub publisher for SSE updates.

When a background job completes (success or failure), the worker
publishes a JSON event to a Redis channel. The web layer subscribes to
that channel and fans events out to SSE clients - which is how the
public map gets sub-second updates without polling.

Channels:
  openballot:events:submission   - one event per submission state change
  openballot:events:verification - one event per verified_result update
  openballot:events:anomaly      - one event per new anomaly hit
"""

from __future__ import annotations

import json
import logging
from typing import Any

import redis.asyncio as aioredis

from ..config import settings

log = logging.getLogger(__name__)


CHANNEL_SUBMISSION = "openballot:events:submission"
CHANNEL_VERIFICATION = "openballot:events:verification"
CHANNEL_ANOMALY = "openballot:events:anomaly"


class EventPublisher:
    """Publishes events. Subscribers live in the web layer (Node's
    ioredis client) so the SSE endpoint can stream events to browsers
    without going through the worker's HTTP path."""

    def __init__(self, redis: aioredis.Redis):
        self.redis = redis

    @classmethod
    def from_settings(cls) -> "EventPublisher":
        return cls(aioredis.from_url(settings().redis_url, decode_responses=True))

    async def publish(self, channel: str, event: dict[str, Any]) -> None:
        try:
            await self.redis.publish(channel, json.dumps(event))
        except Exception as e:
            # Pub/sub failures must never block the job from completing -
            # they only impair the realtime UX, and the next polled
            # fetch will see the new state anyway.
            log.warning("publisher.failed", extra={"channel": channel, "error": str(e)})

    async def submission_extracted(
        self,
        *,
        submission_id: str,
        election_id: str,
        pu_code: str,
        confidence: float,
        anomaly_count: int,
    ) -> None:
        await self.publish(
            CHANNEL_SUBMISSION,
            {
                "type": "submission.extracted",
                "submission_id": submission_id,
                "election_id": election_id,
                "pu_code": pu_code,
                "confidence": confidence,
                "anomaly_count": anomaly_count,
            },
        )

    async def submission_failed(
        self,
        *,
        submission_id: str,
        election_id: str,
        pu_code: str,
        error: str,
    ) -> None:
        await self.publish(
            CHANNEL_SUBMISSION,
            {
                "type": "submission.failed",
                "submission_id": submission_id,
                "election_id": election_id,
                "pu_code": pu_code,
                "error": error,
            },
        )

    async def verified_result(
        self, *, election_id: str, pu_code: str, status: str
    ) -> None:
        await self.publish(
            CHANNEL_VERIFICATION,
            {
                "type": "verified_result",
                "election_id": election_id,
                "pu_code": pu_code,
                "status": status,
            },
        )
