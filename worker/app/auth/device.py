"""Device binding.

The PWA generates a per-install UUID at first launch (stored in
localStorage) and sends a SHA-256 of it as `X-Device-Fingerprint` on
every authenticated request. On first successful login we record the
hash on `agents.device_fingerprint`. Subsequent logins from a different
device are blocked at the auth boundary; the operator approves the
change through the admin portal (this is the row in
`pending_device_changes`).

Why a per-install UUID rather than something cleverer (canvas
fingerprint, IP, user-agent string)?
  * Stable across browser updates (the cleverer signals are not).
  * Survives device reboots (localStorage is persistent).
  * Cleared by clearing site data - a deliberate user action - which is
    exactly when we want to require re-verification.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass


def device_fingerprint_hash(raw_fingerprint: str) -> str:
    """SHA-256 of the raw fingerprint. We never store the raw value."""
    return hashlib.sha256(raw_fingerprint.encode("utf-8")).hexdigest()


@dataclass
class DeviceDecision:
    allow: bool
    reason: str        # "first_login" | "same_device" | "device_change_required"


def evaluate_device_change(
    stored_hash: str | None,
    presented_hash: str,
) -> DeviceDecision:
    """Compare the presented device hash against what is on the agent row.

    Three outcomes:
      * stored is NULL          -> first login, bind the device, allow.
      * stored == presented     -> same device, allow.
      * stored != presented     -> change required; do NOT allow. The
                                   caller records a pending_device_changes
                                   row and the admin must approve.
    """
    if stored_hash is None:
        return DeviceDecision(allow=True, reason="first_login")
    if stored_hash == presented_hash:
        return DeviceDecision(allow=True, reason="same_device")
    return DeviceDecision(allow=False, reason="device_change_required")
