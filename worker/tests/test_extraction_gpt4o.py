"""Tests for the GPT-4o Vision extractor.

We mock httpx so the tests run hermetically. The mocked response shape
matches OpenAI's chat completion JSON exactly so we are exercising the
real parsing path.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from app.extraction.gpt4o_vision import GPT4oVisionExtractor


def _mock_openai_response(content: dict) -> dict:
    return {
        "choices": [
            {
                "message": {"role": "assistant", "content": json.dumps(content)},
                "finish_reason": "stop",
            }
        ],
        "model": "gpt-4o",
    }


@pytest.fixture
def extractor():
    return GPT4oVisionExtractor(api_key="test-key", model="gpt-4o")


@pytest.fixture
def good_response_json():
    return {
        "pu_code": "25-11-04-007",
        "registered_voters": 500,
        "accredited_voters": 450,
        "candidate_votes": {"APC": 142, "PDP": 89, "LP": 203},
        "total_valid_votes": 434,
        "rejected_ballots": 12,
        "total_votes_cast": 446,
        "presiding_officer_signed": True,
        "agent_signatures_detected": 4,
        "official_stamp_present": True,
        "confidence": {
            "pu_code": 0.99,
            "registered_voters": 0.95,
            "accredited_voters": 0.94,
            "candidate_votes": 0.92,
            "total_valid_votes": 0.93,
            "rejected_ballots": 0.91,
            "total_votes_cast": 0.92,
            "signatures": 0.88,
        },
    }


async def test_extract_happy_path(extractor, good_response_json):
    mock_response = AsyncMock()
    mock_response.status_code = 200
    mock_response.json = lambda: _mock_openai_response(good_response_json)

    with patch("httpx.AsyncClient.post", return_value=mock_response):
        result = await extractor.extract("https://example.com/ec8a.jpg", "25-11-04-007")

    assert result.backend_used == "gpt4o_vision"
    assert result.extracted.pu_code == "25-11-04-007"
    assert result.extracted.candidate_votes == {"APC": 142, "PDP": 89, "LP": 203}
    assert result.extracted.total_valid_votes == 434
    assert result.arithmetic.consistent is True
    # Average of all per-field confidences ≈ 0.93
    assert 0.85 < result.confidence_score < 0.99


async def test_extract_uppercases_party_codes(extractor, good_response_json):
    good_response_json["candidate_votes"] = {"apc": 142, " pdp ": 89, "Lp": 203}
    mock_response = AsyncMock()
    mock_response.status_code = 200
    mock_response.json = lambda: _mock_openai_response(good_response_json)

    with patch("httpx.AsyncClient.post", return_value=mock_response):
        result = await extractor.extract("https://example.com/ec8a.jpg", "x")

    assert set(result.extracted.candidate_votes.keys()) == {"APC", "PDP", "LP"}


async def test_extract_rejects_not_an_ec8a(extractor):
    mock_response = AsyncMock()
    mock_response.status_code = 200
    mock_response.json = lambda: _mock_openai_response({"error": "not_an_ec8a"})

    with patch("httpx.AsyncClient.post", return_value=mock_response):
        with pytest.raises(RuntimeError, match="not an EC8A"):
            await extractor.extract("https://example.com/random.jpg", "x")


async def test_extract_raises_on_no_candidates(extractor, good_response_json):
    good_response_json["candidate_votes"] = {}
    mock_response = AsyncMock()
    mock_response.status_code = 200
    mock_response.json = lambda: _mock_openai_response(good_response_json)

    with patch("httpx.AsyncClient.post", return_value=mock_response):
        with pytest.raises(RuntimeError, match="no candidate votes"):
            await extractor.extract("https://example.com/ec8a.jpg", "x")


async def test_extract_raises_on_non_json_content(extractor):
    mock_response = AsyncMock()
    mock_response.status_code = 200
    mock_response.json = lambda: {
        "choices": [{"message": {"content": "definitely not json"}}]
    }

    with patch("httpx.AsyncClient.post", return_value=mock_response):
        with pytest.raises(RuntimeError, match="non-JSON"):
            await extractor.extract("https://example.com/ec8a.jpg", "x")


async def test_extract_raises_on_http_error(extractor):
    mock_response = AsyncMock()
    mock_response.status_code = 500
    mock_response.text = "internal server error"

    with patch("httpx.AsyncClient.post", return_value=mock_response):
        with pytest.raises(RuntimeError, match="HTTP 500"):
            await extractor.extract("https://example.com/ec8a.jpg", "x")


async def test_extract_arithmetic_inconsistent_flagged(extractor, good_response_json):
    # Total valid votes deliberately wrong; arithmetic check should fail.
    good_response_json["total_valid_votes"] = 999
    mock_response = AsyncMock()
    mock_response.status_code = 200
    mock_response.json = lambda: _mock_openai_response(good_response_json)

    with patch("httpx.AsyncClient.post", return_value=mock_response):
        result = await extractor.extract("https://example.com/ec8a.jpg", "x")

    assert result.arithmetic.consistent is False
    assert "candidate_votes_sum_neq_total_valid" in result.arithmetic.failed_checks


# ─── Figures-vs-words reconciliation (issue #68) ──────────────────────────


async def _extract(extractor, payload):
    with patch("httpx.AsyncClient.post", new=AsyncMock()) as post:
        post.return_value.status_code = 200
        post.return_value.json = lambda: _mock_openai_response(payload)
        post.return_value.raise_for_status = lambda: None
        return await extractor.extract("https://cdn/test.jpg", "25-11-04-007")


@pytest.mark.asyncio
async def test_words_column_is_preserved_verbatim(extractor, good_response_json):
    payload = dict(good_response_json)
    payload["candidate_votes_words"] = {
        "APC": "one hundred forty two",
        "PDP": "eighty nine",
        "LP": "two hundred three",
    }
    result = await _extract(extractor, payload)

    # Kept as written, not as a parsed number: a reviewer looking at a
    # disputed cell needs to see what was actually on the form.
    assert result.extracted.candidate_votes_words["APC"] == "one hundred forty two"
    assert result.extracted.candidate_votes == {"APC": 142, "PDP": 89, "LP": 203}


@pytest.mark.asyncio
async def test_agreement_across_both_columns_is_recorded(extractor, good_response_json):
    payload = dict(good_response_json)
    payload["candidate_votes_words"] = {
        "APC": "one hundred forty two",
        "PDP": "eighty nine",
        "LP": "two hundred three",
    }
    result = await _extract(extractor, payload)

    assert result.raw_response["votes_disputed"] == []
    assert all(v["agreed"] for v in result.raw_response["votes_reconciliation"].values())


@pytest.mark.asyncio
async def test_disagreement_lowers_confidence_and_names_the_party(
    extractor, good_response_json
):
    """The point of the second channel: the doubt localises to one party
    instead of condemning the whole extraction."""
    payload = dict(good_response_json)
    payload["candidate_votes_words"] = {
        "APC": "one hundred forty two",
        "PDP": "eighty nine",
        "LP": "nine hundred ninety nine",     # disagrees with the figure 203
    }
    result = await _extract(extractor, payload)

    assert result.raw_response["votes_disputed"] == ["LP"]
    # Below ExtractionEngine's 0.85 floor, so the engine escalates.
    assert result.per_field_confidence["candidate_votes"] < 0.85
    # Both readings survive for the reviewer.
    assert result.raw_response["votes_reconciliation"]["LP"]["figures"] == 203
    assert result.raw_response["votes_reconciliation"]["LP"]["words"] == 999


@pytest.mark.asyncio
async def test_words_disambiguate_a_split_figure(extractor, good_response_json):
    payload = dict(good_response_json)
    payload["candidate_votes"] = {"APC": "1 42", "PDP": 89, "LP": 203}
    payload["candidate_votes_words"] = {
        "APC": "one hundred forty two",
        "PDP": "eighty nine",
        "LP": "two hundred three",
    }
    result = await _extract(extractor, payload)

    assert result.extracted.candidate_votes["APC"] == 142
    assert result.raw_response["votes_disputed"] == []


@pytest.mark.asyncio
async def test_absent_words_column_keeps_the_old_behaviour(
    extractor, good_response_json
):
    """Older prompt versions and the Document AI backend return no words.
    Reconciliation must be additive, never a regression."""
    result = await _extract(extractor, good_response_json)

    assert result.extracted.candidate_votes_words is None
    assert result.extracted.candidate_votes == {"APC": 142, "PDP": 89, "LP": 203}
    assert result.raw_response["votes_disputed"] == []


@pytest.mark.asyncio
async def test_not_an_ec8a_raises_a_typed_classification_not_a_generic_error(
    extractor,
):
    """The backend's verdict is a finding, not a fault (issue #71).

    A generic RuntimeError here would be logged as an extraction failure and
    the reason lost - the public record would show an unexplained gap where
    it could show 'this upload was not a result sheet'."""
    from app.extraction.errors import NotAnEC8AError

    with pytest.raises(NotAnEC8AError) as excinfo:
        await _extract(extractor, {"error": "not_an_ec8a"})

    assert excinfo.value.validation_flag == "not_an_ec8a"
    assert excinfo.value.image_url == "https://cdn/test.jpg"
