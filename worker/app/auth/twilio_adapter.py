"""Twilio SMS adapter.

We deliberately keep this small and behind a stable interface
(`SmsAdapter.send`). Two implementations:
  * TwilioAdapter      - real REST API call to Twilio's Programmable SMS
  * NoOpAdapter        - logs to stdout; the worker uses this in dev so
                         tests and local runs never send SMS.

The interface is async because Twilio's API call sits on the critical
path of the auth handler.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

import httpx

log = logging.getLogger(__name__)


@dataclass
class SmsResult:
    ok: bool
    provider_id: str | None
    error: str | None = None


class SmsAdapter(ABC):
    @abstractmethod
    async def send(self, *, to_e164: str, body: str) -> SmsResult: ...


class NoOpAdapter(SmsAdapter):
    """Logs the message instead of sending. The OTP code appears in the
    worker logs, which is fine for development - never for production."""

    async def send(self, *, to_e164: str, body: str) -> SmsResult:
        log.info("sms.noop", extra={"to": to_e164, "body": body})
        return SmsResult(ok=True, provider_id=f"noop-{abs(hash((to_e164, body))) % 10**12}")


class TwilioAdapter(SmsAdapter):
    """Real Twilio Programmable SMS via the REST API.

    https://www.twilio.com/docs/sms/api/message-resource#create-a-message-resource
    """

    BASE_URL = "https://api.twilio.com/2010-04-01"

    def __init__(self, account_sid: str, auth_token: str, from_number: str):
        self.account_sid = account_sid
        self.auth_token = auth_token
        self.from_number = from_number

    async def send(self, *, to_e164: str, body: str) -> SmsResult:
        url = f"{self.BASE_URL}/Accounts/{self.account_sid}/Messages.json"
        data = {"From": self.from_number, "To": to_e164, "Body": body}
        try:
            async with httpx.AsyncClient(timeout=10.0) as c:
                r = await c.post(url, auth=(self.account_sid, self.auth_token), data=data)
            if r.status_code >= 300:
                return SmsResult(ok=False, provider_id=None, error=f"HTTP {r.status_code}: {r.text[:200]}")
            payload: dict[str, Any] = r.json()
            return SmsResult(ok=True, provider_id=payload.get("sid"))
        except Exception as e:
            return SmsResult(ok=False, provider_id=None, error=str(e))


def build_default_adapter(
    *,
    enabled: bool,
    account_sid: str | None,
    auth_token: str | None,
    from_number: str | None,
) -> SmsAdapter:
    """Factory: returns the real adapter when Twilio is configured AND
    enabled; otherwise NoOp. Keeps test environments hermetic."""
    if enabled and account_sid and auth_token and from_number:
        return TwilioAdapter(account_sid, auth_token, from_number)
    return NoOpAdapter()
