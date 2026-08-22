# ADR-0014 — Layout judgement lives in pure geometry, the model lives elsewhere

**Status:** Accepted
**Date:** 2026-08-22
**Issues:** #69, #71, #72

## Context

Adopting a document-layout stage (orientation, cropping, dewarping, and the
positional detection of stamps and signatures) brings a vision model into a
platform that previously had none.

The reference implementation pins `torch==1.11.0`, `torchvision==0.12.0` and
`ultralytics==8.2.22`, with 85 MB of trained weights. Together that is larger
than the entire rest of the worker. `worker/` is a FastAPI service that must
stay responsive on election night; adding a multi-gigabyte ML stack to it
changes its memory profile, its cold-start time and its attack surface at
once.

There is a second, less obvious problem. The valuable part of that pipeline is
not the model. It is the *judgement encoded around* the model:

- which way is up (the INEC logo is at the top of an EC8A, so wherever the
  logo is, that is the top)
- what to crop (tables set the horizontal extent; overreach destroys votes)
- what a signature's position means (one in the agent column is not the
  presiding officer's, whatever a model says)
- what a valid result sheet looks like structurally (the outlier thresholds)

Bundled with the model, none of that is testable without a GPU, a model
download and a torch install — so in practice it would not be tested at all.

## Decision

**Split them.** `app/layout/geometry.py` and `app/layout/authentication.py`
are pure functions over element boxes: no model, no image, no torch.
`app/layout/detector.py` is the only module that touches a model, and it
imports lazily.

**The model runs as a separate service.** `HTTPDetector` calls it over HTTP
with a short timeout. `LocalDetector` exists for offline batch work — scoring
the evaluation set, tuning thresholds — and imports `ultralytics` inside the
call, so importing the module never pulls it in.

**Detection failure is never fatal.** Every path degrades to "no detections".
Rectification is an enhancement to extraction, not a precondition: a document
we cannot analyse structurally is still one we can send to Document AI.

**Weights are not in git.** 85 MB of binary, fetched from object storage on
container start.

## Consequences

Good:

- The judgements are unit-tested. 37 tests cover orientation, crop bounds,
  duplicate suppression and positional authentication, and they run in
  milliseconds in ordinary CI with no model present.
- The worker's dependency set is unchanged. No torch, no ultralytics, no
  shapely — the polygon IoU is computed on axis-aligned bounds, which agree
  closely with the true polygons for the near-duplicate case it is used for.
- The vision service can be scaled, restarted, or switched off independently
  of ingestion. On election night that matters: a slow vision service becomes
  a degraded feature rather than a queue of stalled extractions.
- A future detector — a different model, a different vendor — slots in behind
  the same `LayoutDetector` interface without touching any of the judgement.

Costs:

- Two services to deploy and monitor instead of one, and an HTTP hop per
  document.
- The geometry is written against one detector's label vocabulary
  (`box, table, column, header, signature, figure, paragraph, logo, kv,
  stamp`). A detector with a different vocabulary needs a mapping layer.
- `NullDetector` is the default, so a deployment that forgets to configure the
  vision service gets no layout analysis and no error. That is the correct
  failure direction, but it must be visible in the health endpoint.

## Alternatives considered

**Bundle the model into the worker.** Simpler to deploy, and rejected: it
couples ingestion availability to model availability, inflates the worker
image by an order of magnitude, and would leave the judgement untested.

**Use a hosted document-layout API.** Removes the operational burden, adds a
third external dependency and a per-document cost to a path that runs on every
submission. Worth revisiting if the self-hosted service proves burdensome.

**Skip layout entirely and rely on the extraction backends.** This is the
status quo, and it is what makes `presiding_officer_signed` an unverified
model opinion. The evaluation set in #72 exists precisely to measure whether
that opinion is any good.
