# ADR-0007: Document AI primary + GPT-4o Vision fallback

- **Status**: Accepted
- **Date**: 2026-03-22
- **Deciders**: Worker lead, technical lead

## Context

EC8A extraction is the project's largest variable cost and its
largest accuracy risk. We need an extractor that:
  - reads structured fields reliably across image quality
  - produces a confidence score per field
  - admits when it does not know rather than inventing values
  - is cheap enough to run at 2.6M+ submissions per general election

No single backend hits all four points reliably.

## Decision

**Two-tier extraction with a hard confidence floor:**

  - **Primary**: Google Document AI (Form Parser, optionally a custom
    EC8A-trained processor). Cheap, fast, deterministic per-field
    confidence scores.
  - **Secondary**: GPT-4o Vision. Invoked when Document AI's
    aggregate confidence falls below `EXTRACTION_CONFIDENCE_FLOOR`
    (default 0.85) OR arithmetic checks fail on the primary result.

Both backends share an `Extractor` protocol; the engine takes whichever
result has higher confidence AND arithmetic-consistent. Anything still
below the floor lands in the consortium review queue rather than the
public map.

## Alternatives considered

- **Document AI only**: rejected. On poor-quality images the
  confidence drops without a fallback to verify against, and we'd
  have to send those to the review queue at higher rate.
- **GPT-4o only**: rejected on cost (~10× per page) and on
  determinism (model updates change extraction behaviour).
- **Self-host an OSS OCR (Tesseract / PaddleOCR)**: rejected for
  Nigerian-form accuracy at our scale and for the operational
  burden of running an OCR fleet.

## Consequences

**Easy**: per-field confidence is preserved through the pipeline.
The review queue is sized by the floor parameter; tightening or
loosening it is a one-env-var change.

**Hard**: two API integrations to monitor, two cost lines, two
prompt-version drift surfaces. Mitigated by the factory pattern
(`worker/app/extraction/factory.py`) that returns stubs when neither
is configured - dev and CI stay hermetic.

**Locked-in**: per-PU output schema. Both backends must produce the
`ExtractedEC8A` shape. A future backend (Tesseract self-host,
specialist EC8A model, etc.) plugs in by implementing the same
protocol.

## References

- `worker/app/extraction/document_ai.py`
- `worker/app/extraction/gpt4o_vision.py`
- `worker/app/extraction/factory.py`
- `worker/app/extraction/prompts.py` - the GPT-4o prompt (versioned)
