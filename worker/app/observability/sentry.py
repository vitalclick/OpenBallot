"""Sentry SDK wiring.

init_sentry() is called at app + worker startup. Reads SENTRY_DSN +
SENTRY_ENVIRONMENT from settings; no-ops when DSN is unset.

Includes the FastAPI + httpx integrations so unhandled exceptions in
request handlers and outbound HTTP calls are captured automatically.
"""

from __future__ import annotations

import logging
import os
from typing import Any

log = logging.getLogger(__name__)

_initialised = False


def init_sentry(*, environment: str | None = None) -> None:
    """Initialise Sentry once per process. Safe to call multiple times."""
    global _initialised
    if _initialised:
        return

    dsn = os.environ.get("SENTRY_DSN")
    if not dsn:
        log.info("sentry.disabled", extra={"reason": "no DSN"})
        _initialised = True
        return

    try:
        import sentry_sdk
        from sentry_sdk.integrations.asyncio import AsyncioIntegration
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.httpx import HttpxIntegration
        from sentry_sdk.integrations.logging import LoggingIntegration

        sentry_sdk.init(
            dsn=dsn,
            environment=environment or os.environ.get("SENTRY_ENVIRONMENT", "production"),
            release=os.environ.get("SENTRY_RELEASE") or os.environ.get("BUILD_SHA"),
            traces_sample_rate=float(os.environ.get("SENTRY_TRACES_SAMPLE_RATE", "0.05")),
            profiles_sample_rate=float(os.environ.get("SENTRY_PROFILES_SAMPLE_RATE", "0.0")),
            send_default_pii=False,
            integrations=[
                AsyncioIntegration(),
                FastApiIntegration(),
                HttpxIntegration(),
                LoggingIntegration(level=logging.INFO, event_level=logging.ERROR),
            ],
        )
        log.info("sentry.initialised", extra={"env": environment})
    except Exception as e:
        # Never let Sentry's own import / init failure crash the worker.
        log.warning("sentry.init_failed", extra={"error": str(e)})

    _initialised = True


def capture_exception(error: BaseException, **context: Any) -> None:
    """Manually capture an exception with extra context. Used at boundaries
    where we swallow the exception (e.g. publisher.publish) but want the
    operator to see it in Sentry."""
    try:
        import sentry_sdk

        with sentry_sdk.push_scope() as scope:
            for k, v in context.items():
                scope.set_extra(k, v)
            sentry_sdk.capture_exception(error)
    except Exception:
        # The error reporter failing must never mask the error it was
        # reporting, so this stays swallowed -- but at debug level it is at
        # least discoverable when Sentry itself is misconfigured.
        logging.getLogger(__name__).debug("sentry.capture_failed", exc_info=True)
