"""Rate limit decisions for the auth surface.

Two limits enforced:

  * Per-phone: max N OTP requests per 10 minutes. Prevents an attacker
    from triggering an SMS flood on a target number.
  * Per-IP: max M OTP requests per hour. Prevents an attacker from
    cycling phones from a single source.

Pure function: takes the recent auth_events and returns a decision. The
caller fetches events and persists outcomes. Keeps this layer hermetic.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone


@dataclass
class RateLimitDecision:
    allow: bool
    reason: str             # "ok" | "phone_throttled" | "ip_throttled"
    retry_after_seconds: int = 0


def evaluate_rate_limit(
    *,
    phone_request_times: list[datetime],
    ip_request_times: list[datetime],
    phone_window_seconds: int = 600,
    phone_max: int = 3,
    ip_window_seconds: int = 3600,
    ip_max: int = 30,
    now: datetime | None = None,
) -> RateLimitDecision:
    now = now or datetime.now(timezone.utc)

    phone_window_start = now - timedelta(seconds=phone_window_seconds)
    recent_phone = [t for t in phone_request_times if t >= phone_window_start]
    if len(recent_phone) >= phone_max:
        oldest = min(recent_phone)
        retry_after = max(0, int((oldest + timedelta(seconds=phone_window_seconds) - now).total_seconds()))
        return RateLimitDecision(allow=False, reason="phone_throttled", retry_after_seconds=retry_after)

    ip_window_start = now - timedelta(seconds=ip_window_seconds)
    recent_ip = [t for t in ip_request_times if t >= ip_window_start]
    if len(recent_ip) >= ip_max:
        oldest = min(recent_ip)
        retry_after = max(0, int((oldest + timedelta(seconds=ip_window_seconds) - now).total_seconds()))
        return RateLimitDecision(allow=False, reason="ip_throttled", retry_after_seconds=retry_after)

    return RateLimitDecision(allow=True, reason="ok")
