"""Tests for the extraction engine factory.

Verifies the four configuration branches:
  - both Document AI + OpenAI configured  -> real primary + real secondary
  - Document AI only                       -> real primary + stub secondary
  - OpenAI only                            -> secondary promoted to primary
  - neither                                -> both stubs
"""

from __future__ import annotations

from unittest.mock import patch

from app.extraction.document_ai import DocumentAIExtractor
from app.extraction.engine import StubExtractor
from app.extraction.factory import build_engine
from app.extraction.gpt4o_vision import GPT4oVisionExtractor


def _settings(**kw):
    """Build a mock-ish settings object as a simple namespace."""
    class _S:
        google_document_ai_project = None
        google_document_ai_processor = None
        openai_api_key = None
        extraction_confidence_floor = 0.85
    s = _S()
    for k, v in kw.items():
        setattr(s, k, v)
    return s


def test_both_real_when_both_configured():
    with patch("app.extraction.factory.settings") as ms, \
         patch("app.extraction.document_ai.settings") as md, \
         patch("app.extraction.gpt4o_vision.settings") as mg:
        cfg = _settings(
            google_document_ai_project="proj",
            google_document_ai_processor="proc",
            openai_api_key="sk-test",
        )
        ms.return_value = cfg
        md.return_value = cfg
        mg.return_value = cfg

        engine = build_engine()
        assert isinstance(engine.primary, DocumentAIExtractor)
        assert isinstance(engine.secondary, GPT4oVisionExtractor)
        assert engine.confidence_floor == 0.85


def test_document_ai_only():
    with patch("app.extraction.factory.settings") as ms, \
         patch("app.extraction.document_ai.settings") as md, \
         patch("app.extraction.gpt4o_vision.settings") as mg:
        cfg = _settings(
            google_document_ai_project="proj",
            google_document_ai_processor="proc",
        )
        ms.return_value = cfg
        md.return_value = cfg
        mg.return_value = cfg

        engine = build_engine()
        assert isinstance(engine.primary, DocumentAIExtractor)
        assert isinstance(engine.secondary, StubExtractor)


def test_openai_only_promotes_to_primary():
    with patch("app.extraction.factory.settings") as ms, \
         patch("app.extraction.document_ai.settings") as md, \
         patch("app.extraction.gpt4o_vision.settings") as mg:
        cfg = _settings(openai_api_key="sk-test")
        ms.return_value = cfg
        md.return_value = cfg
        mg.return_value = cfg

        engine = build_engine()
        # OpenAI is promoted to primary when Document AI is absent.
        assert isinstance(engine.primary, GPT4oVisionExtractor)
        assert isinstance(engine.secondary, StubExtractor)


def test_stubs_only_when_nothing_configured():
    with patch("app.extraction.factory.settings") as ms, \
         patch("app.extraction.document_ai.settings") as md, \
         patch("app.extraction.gpt4o_vision.settings") as mg:
        cfg = _settings()
        ms.return_value = cfg
        md.return_value = cfg
        mg.return_value = cfg

        engine = build_engine()
        assert isinstance(engine.primary, StubExtractor)
        assert isinstance(engine.secondary, StubExtractor)
