# ADR-0015 — Geometric table reconstruction: evaluated, deferred, not rejected

**Status:** Proposed — evaluation, no implementation
**Date:** 2026-08-22
**Issue:** #74
**Amends:** ADR-0007 (Document AI primary, GPT-4o fallback)

## Context

We extract EC8A figures with two paid, external, opaque backends: Google
Document AI as primary, GPT-4o Vision on fallback. When a number comes back
wrong we have a confidence score and no way to see why.

The CCIJ pipeline offers a third shape. Rather than asking a model to read a
table, it reconstructs the table geometrically:

1. The layout model locates tables, columns and individual cell boxes.
2. Amazon Textract returns text with coordinates.
3. IoU matching assigns each piece of text to the cell box containing it.

Plus a recovery step worth noting on its own: cells the OCR missed are
cropped, composited onto a fresh page, and re-OCR'd — reclaiming them at a
fraction of the cost of reprocessing the page.

Since #69 landed, we already have the layout half. The geometry is ours, so
the expensive structural understanding is free and only cheap text detection
would be billed. CCIJ's whole-corpus Textract pass cost roughly $500, and they
note table extraction is "roughly 100 times more expensive than basic text
extraction" — which is exactly why they used cheap text detection plus their
own geometry for the bulk, reserving table extraction for ~30,000 hard cases.

## Decision

**Do not implement yet. Do not close the door.**

The case is genuinely attractive but rests on estimates, not measurements. We
have run nothing: no accuracy comparison, no cost-per-document at election-night
volume, no latency figure including the second-pass recovery. Committing to a
third backend on the strength of a plausible argument would be the same mistake
as trusting a confident model.

What would change the decision, in order:

1. **Accuracy on the same sample used to baseline #68 and #72**, so all three
   are comparable. If it does not match Document AI, cost is irrelevant.
2. **Cost per document at realistic volume**, against both current backends.
3. **Latency including recovery**, since this sits in the ingestion path.
4. **Whether it works as a cross-check rather than a replacement** — see below.

## The reason to keep it open

Two arguments outlast the cost question.

**Auditability.** Every figure this method produces is traceable to a specific
box at specific coordinates on the image. We could show a reader exactly which
region of the EC8A produced the number we published. Given that the platform's
stated premise is "no black box", an extraction path we can *explain* has value
independent of its price. Neither current backend can offer that.

**Consensus across methods.** `verification/engine.py` already computes
consensus across independent *sources*. Three independent *extraction methods*
agreeing on a figure is a materially stronger claim than one backend's
confidence — and unlike the source consensus, it is available for a polling
unit with only a single submission, which is most of them early on election
night.

That second point suggests the right shape if this proceeds: a **cross-check,
not a replacement**. Run it alongside, compare, and surface disagreement — the
same posture #68 takes with the figures and words columns, and for the same
reason. Independent readings that agree are evidence; a single reading is an
assertion.

## Dependencies

Requires the layout detector from #69 to be deployed and producing reliable
cell boxes. There is no point evaluating text-to-cell matching against a cell
map we do not trust, so the #72 evaluation set should be scored first: it
measures whether the layout model finds elements accurately at all.

## Risks

- **A third OCR vendor** is a third supply-chain dependency, a third set of
  credentials, and a third availability risk in the ingestion path.
- **Cell-matching failure is silent.** A misassigned cell puts a real number
  against the wrong party — arithmetic still passes, and the result is wrong in
  the most damaging possible way. The figures-vs-words reconciliation from #68
  would catch some of these, which is an argument for landing this only after
  that is proven in production.
- **The cost estimate is CCIJ's, on their corpus.** Our volume, image sizes and
  regional pricing differ.

## Recommendation

Revisit once #69 is deployed and #72 has produced accuracy numbers for the
layout model. If those are good, run the evaluation above on a few thousand
documents before writing any integration code. If it proceeds, land it as a
cross-check behind the existing `Extractor` protocol and amend ADR-0007.
