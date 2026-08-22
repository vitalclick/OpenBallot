"""Extraction engine factory.

Wires the right primary + secondary backend based on configuration:

  * Both Document AI and OpenAI configured  -> real primary + real secondary
  * Only Document AI configured             -> real primary + stub secondary
  * Only OpenAI configured                  -> stub primary + real secondary
                                               (OpenAI acts as primary)
  * Neither configured                      -> both stubs (development)

The result is always an ExtractionEngine wrapping two Extractor instances,
so calling code remains identical across environments.
"""

from __future__ import annotations

import logging

from ..config import settings
from . import document_ai, gpt4o_vision
from .engine import ExtractionEngine, StubExtractor

log = logging.getLogger(__name__)


def build_engine() -> ExtractionEngine:
    s = settings()
    primary = document_ai.build_from_settings()
    secondary = gpt4o_vision.build_from_settings()

    if primary is None and secondary is None:
        log.warning(
            "extraction.factory.stubs_only",
            extra={"reason": "no AI credentials configured"},
        )
        primary = StubExtractor(name="document-ai-stub", confidence=0.97)
        secondary = StubExtractor(name="gpt4o-vision-stub", confidence=0.92)
    elif primary is None:
        log.info("extraction.factory.openai_only", extra={})
        primary = secondary
        secondary = StubExtractor(name="gpt4o-vision-stub", confidence=0.0)
    elif secondary is None:
        log.info("extraction.factory.document_ai_only", extra={})
        secondary = StubExtractor(name="gpt4o-vision-stub", confidence=0.0)
    else:
        log.info("extraction.factory.both_real", extra={})

    return ExtractionEngine(
        primary=primary,
        secondary=secondary,
        confidence_floor=s.extraction_confidence_floor,
    )
