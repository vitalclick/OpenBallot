# IReV results scraper

Ingests the 2023 Nigerian general election results from INEC's IReV portal
into the OpenBallot platform. Walks the polling-unit registry produced by
`Polling-Units/scraper.js` and, for each (election × PU) pair, fetches the
published result + EC8A image, mirrors the image to our storage, and writes
an `ec8a_submissions` row with `source_type='inec_irev'`.

> ⚠️ **Status (May 2026): API target has moved. Pipeline requires
> redesign before it can run end-to-end.** See "May 2026 discovery notes"
> below for what changed and what the next operator picks up. The
> docs above describe the *intended* end-state; the code currently in
> this directory was written against the original 2023 IReV API which
> INEC has since retired.

## What it produces

Per polling unit, per election:

- An entry in `ec8a_submissions` (review_status `auto_approved`, source
  `inec_irev`, confidence `1.0` because the source is INEC themselves)
- An `audit_log` event chained into the tamper-evident SHA-256 hash chain
- A `verified_results` row with status `inec_published`
- The EC8A image, mirrored to S3-compatible storage with its SHA-256 stored
  in the submission and verifiable from the public hash manifest

## Prerequisites

1. **Geo registry**: run `Polling-Units/scraper.js` first to produce the
   per-state JSON files in `Polling-Units/results/`.
2. **Database**: migrations applied (`db/migrations/0001..0005_*.sql`).
3. **Storage**: MinIO (dev) or Cloudflare R2 (prod) reachable.

## Configuration

All endpoints are configurable. Defaults are documented in `config.js`.
Override via environment variables; the values most likely to need
adjustment in a real run:

```bash
# Base URL of the IReV deployment (INEC has shifted this between cycles)
IREV_BASE=https://lv.irev.inecnigeria.org

# Comma-separated list of path templates to try per PU. Tokens
# {election_id} and {pu_code} are substituted. The first one returning a
# parseable JSON body wins.
IREV_RESULT_PATHS=/api/v1/elections/{election_id}/polling-units/{pu_code},/api/elections/{election_id}/results/{pu_code}

# Per-election IDs IReV uses internally. Confirm against the live portal.
# (NB: 2026-05-19 — IReV also exposes FCT Area Council types CHAIRMAN
# and COUNCILLOR. Add IREV_ID_CHAIRMAN / IREV_ID_COUNCILLOR here once
# the redesign covers them.)
IREV_ID_PRESIDENTIAL=presidential-2023
IREV_ID_SENATE=senate-2023
IREV_ID_REPS=house-of-reps-2023
IREV_ID_GOV=governorship-2023
IREV_ID_STHA=state-house-2023

# Rate limiting - this is a public-good archive scrape, be polite
IREV_DELAY_MS=450
IREV_CONCURRENCY=4

# Storage
STORAGE_ENDPOINT=http://localhost:9000
STORAGE_BUCKET=ec8a-evidence
STORAGE_ACCESS_KEY=minioadmin
STORAGE_SECRET_KEY=minioadmin

# Database
DATABASE_URL=postgresql://openballot:openballot@localhost:5432/openballot
```

## Recommended sequence: discover -> pilot -> full

Before committing multi-day scrape time, validate that the parser matches
INEC's current IReV schema. The pilot tooling makes that a 30-minute job.

### 1. Discover the live endpoint

```bash
# Pick any known-good PU code from Polling-Units/results/
node scripts/discover-endpoints.js \
  --election presidential \
  --pu 25-11-04-007
```

The script probes nine candidate URL templates, prints which ones returned
parseable JSON, and emits an `export IREV_RESULT_PATHS=...` line to paste
before the pilot.

### 2. Run the one-state pilot

```bash
node scripts/pilot.js \
  --state Lagos \
  --election presidential \
  --limit 200
```

This processes 200 PUs end-to-end (fetch -> parse -> upload -> persist ->
audit), captures every raw response to `fixtures/captured/<election_id>/`,
samples 5 uploaded images and recomputes their SHA-256 against the DB
record, runs the audit chain verifier, and writes:

  - `pilot-output/pilot-report.json`  - structured report
  - `pilot-output/pilot-report.md`    - human summary

The report ends with a verdict: **ship the full scrape** or **hold +
here's exactly what to fix**. Common holds:

  - parser saw an unrecognised payload shape -> update `lib/parse.js`
    (the exemplar fixture path is in the report)
  - low success rate -> investigate the IReV URL pattern or election ID
  - audit chain broken -> stop, this is a bug, not a config issue

### 3. Run the full scrape

```bash
npm install

# Full scrape (resumable - safe to interrupt and re-run)
node scrape.js

# A single state
node scrape.js --state Lagos

# A single election type
node scrape.js --election presidential

# Smoke test (100 PUs, no writes)
node scrape.js --dry-run --max 100

# Reset progress and start over
node scrape.js --reset
```

## Resumability

Progress is flushed atomically every 50 PUs to `progress.json`. A re-run
skips any `(election_id, pu_code)` pair already marked done in the
progress file. To force re-processing of a single unit, edit the JSON or
use `--reset` for a clean restart.

## Status values written to verified_results

For every PU successfully scraped the row is written with status
`inec_published` - distinct from `single_source` (which means a single
party agent or observer). This makes the 2023 historical dataset visually
distinguishable on the map from in-progress current elections.

## When INEC's response shape changes

The parser in `lib/parse.js` tolerates three observed IReV JSON shapes
(`result.scores` array, `data.results` map, `Votes` array). If INEC
ships a new shape, add a branch there - do not silently coerce, return
`null` and let the PU be flagged in the progress report so the gap is
visible.

## Cost / volume envelope

| Election    | Approx PUs | Images at ~1MB each | Storage |
|-------------|------------|---------------------|---------|
| Presidential | 176,846    | ~180 GB             | R2: ~$3/mo |
| Senate       | 176,846    | ~180 GB             | R2: ~$3/mo |
| Reps         | 176,846    | ~180 GB             | R2: ~$3/mo |
| Gov          | ~140,000   | ~140 GB             | R2: ~$2/mo |
| STHA         | ~140,000   | ~140 GB             | R2: ~$2/mo |
| **Total**    | ~810,000   | ~820 GB             | R2: ~$13/mo |

At 450ms inter-request delay and 4 concurrent workers, a full single-election
scrape lands in ~3 days of wall time. The full five-election dataset is
~12-15 days of continuous scraping. Both fit comfortably inside any
reasonable run schedule before the public launch.

## Tests

```bash
node --test test/
```

The unit tests cover the parser against all three known IReV JSON shapes
plus the empty/unrecognised cases. End-to-end testing against a real IReV
deployment is run manually as part of pre-launch validation - not in CI
- because it depends on INEC's live infrastructure.

## May 2026 discovery notes — the API has moved and the model changed

A 2026-05-17 session attempted to run this scraper end-to-end and found
that **none of the URL templates in `lib/endpoint_discovery.js` are
reachable**. INEC retired the original `lv.irev.inecnigeria.org` host
after 2023 and rebuilt IReV on a different stack. The new picture:

### Hosts

Re-verified 2026-05-19 via `curl -I`:

| Hostname | Status | Role |
|---|---|---|
| `lv.irev.inecnigeria.org` | DNS does not resolve | Original 2023 host — gone |
| `www.inecelectionresults.ng` | HTTP 200 (Cloudflare → DigitalOcean SPA) | Public-facing portal (Angular) |
| `irev.inecnigeria.org` | HTTP 200 (Cloudflare → DigitalOcean SPA) | Same Angular app under INEC's own domain |
| `dolphin-app-sleqh.ondigitalocean.app` | HTTP 200 — **live API** | Express + MongoDB backend |
| `lv001-r.inecelectionresults.ng` | DNS does not resolve | Stale URL still referenced in the SPA bundle |
| `irev-v2.herokuapp.com` | HTTP 403 — host resolves but the Heroku app no longer serves | Pilot environment from earlier vintage |

EC8A image storage:
- `ecollation-result-docs.s3.eu-west-2.amazonaws.com` — collated docs
- `etransmission-result-docs.s3.eu-west-2.amazonaws.com` — raw EC8A scans (the canonical evidence per ADR-0001)

### Confirmed working API endpoints (May 2026)

Base: `https://dolphin-app-sleqh.ondigitalocean.app/api/v1/`

```
GET /                     -> { status: "success", request_time: <epoch_ms> }
GET /elections            -> { success: true, data: [{...election...}] }   400 rows, newest first; see pagination note
GET /states               -> { success: true, states: [{...state...}] }    37 entries
GET /elections/{election_id}  -> route is wired; returns { success:false, error_code:6, message:"Unable to complete request" } for unknown ids
```

**Pagination is not exposed (verified 2026-05-19).** The `/elections`
endpoint returns the same 400 rows regardless of `?page=N`, `?limit=N`,
`?election_type_id=N`, or `?type=…` — query params are silently ignored
and the response has no `total`, `next`, or `Link` header. Walking past
the most recent 400 elections via this endpoint is not currently
possible; the SPA must be using a route we haven't discovered.

**Presidential elections are not currently scrapable
(verified 2026-05-19, re-confirmed with deeper bundle scan).** The
post-2026 IReV API does not expose Presidential. Concretely:

- `/elections` returns 400 most-recent rows, all of type 2..7 (Gov /
  Senate / Reps / Assembly / Chairman / Councillor). No
  `election_type_id=1` row appears at any pagination key.
- Every state document carries a top-level `presidential` ObjectId
  (`5f0eb67db39f166717b8411f`) and `presidential_id: 1`. That
  ObjectId *is accepted* by `/elections/{id}/lga` (route returns 200)
  but yields `data:[]` — the schema slot exists, the data does not.
- The SPA's Presidential component (`/pres/elections/:election`) calls
  `election-reports/election/{election_id}`. **That route now returns
  Express 404** ("Cannot GET /api/v1/election-reports/election/...")
  for every id format tried — the SPA's own Presidential page would
  404 if a user clicked it.
- Guessed routes `/presidential`, `/pres/elections`, `/presidentials`,
  `/presidential-elections`, `/election/1` all return Express 404.

Conclusion: Presidential is server-side missing, not just client-side
hard-to-find. Any Presidential backfill must wait for INEC to
re-publish 2023 Presidential data via the current API, or provide a
separate archive endpoint. We cannot fix this client-side.

### The traversal model (discovered 2026-05-19 via SPA bundle scrape)

The Angular SPA at `https://irev.inecnigeria.org/` bundles its API
paths as string literals. Scraping `main.f5b6ab32c0c08cea.js` and
verifying each route against the live API revealed the full traversal:

**Key insight: the `:election` URL parameter is the Mongo `_id`
(ObjectId), NOT the integer `election_id`.** The integer goes in the
query string. Earlier attempts that put the integer in the path all
returned `{success:false, error_code:6}` — that's the API's "no such
document" response, not a routing error.

Confirmed working endpoints (each tested against Anambra Gov 2025,
`election_id=2919`, `_id=68fbd8c9f2b7c78fc9917c22`):

```
GET /api/v1/election-types
    -> all 7 election type definitions

GET /api/v1/elections
    -> 400 most-recent elections (Presidential absent — see above)

GET /api/v1/elections/elections/latest
    -> recently-updated elections (same shape as /elections)

GET /api/v1/elections/result/latest
    -> recently-updated PU result documents (across all elections)

GET /api/v1/elections/{election_objectId}/lga[?election={election_id}]
    -> { success, data: [{ _id, election, lga, wards:[…], … }] }
       Returns all LGAs in the election's state with embedded ward arrays.
       Query string is optional but the SPA always sends it.

GET /api/v1/elections/{election_objectId}/lga/state/{state_id}
    -> LGAs filtered to one state (for multi-state elections)

GET /api/v1/elections/{election_objectId}/pus?ward={ward_objectId}
    -> { success, data:[…PU result entries…], pus:[…], results:[…] }
       Each entry has: pu_code ("04/17/06/010"), polling_unit_id,
       polling_unit (full PU doc with state/lga/ward), and document.url
       (direct EC8A image URL — see image storage note below).
       Can also scope with &lga={lga_objectId} or just &election=.

GET /api/v1/elections/{election_objectId}/pus/recent
    -> recently-uploaded PU results for this election

GET /api/v1/elections/{election_objectId}/result/stats[?election=…]
    -> upload-progress metrics (NOT vote tallies — verified 2026-05-19):
       { pus, documents, expected, not_expected,
         latest: <full PU entry, most recently uploaded> }
       Query params are ignored. The IReV API does not expose vote
       tallies via any endpoint — per ADR-0001, the EC8A image is the
       canonical evidence and tallies are produced via OCR downstream.
```

The PU-result `document.url` returned in the 2025 Anambra sample
points to `https://inc-s3-cache.incportals.com/cached/express/results/…`
— that is, EC8A images are served from a CDN cache layer
(`inc-s3-cache.incportals.com`), NOT directly from the S3 buckets
listed above. The S3 buckets are still the origin per ADR-0001, but
the scraper should follow whatever URL the API returns.

**Image fetch limitation (verified 2026-05-19):** the
`inc-s3-cache.incportals.com` CDN allowlists by host — direct fetches
from outside INEC's partner network return
`HTTP 403 Host not in allowlist`. The SPA hosts
(`irev.inecnigeria.org`, `www.inecelectionresults.ng`) do NOT proxy
through to the image; they return the Angular shell with
`x-do-orig-status: 404` in the response headers. The metadata API
(`dolphin-app-sleqh`) is reachable, but the image bytes themselves
are not. Same allowlist applies to the `irev-v2.herokuapp.com`
guest fallback. Practical implications:

- **The scraper has a `--catalog-only` flag** that captures all
  metadata (per-PU records + image URLs) without attempting the image
  download. Use this when scraping from any host outside the allowlist.
- A full image archive requires either INEC adding our scrape host to
  the allowlist, or running the scrape from inside their partner
  network.
- Stored `image_url` should still be the IReV URL — re-downloading from
  an allowlisted host later will produce the same SHA, preserving the
  evidence chain.

### Mapping IReV IDs back to INEC delim codes

The good news: the per-PU response includes
`polling_unit.pu_code = "04/17/06/010"` and
`polling_unit.pu_code_string = "041706010"` directly. So the
INEC-delim ↔ IReV-id mapping table the original redesign plan called
for (step 3 below) is **not needed** — we can join on `pu_code` at
ingest time without a discovery pass.

Schema fragments observed in responses:

```
Election:
  _id              MongoDB ObjectId           e.g. "6549830e8f260c2694ceab91"
  election_id      integer                    e.g. 2793, 1486   <-- this is the lookup key
  full_name        human label                 e.g. "Governorship election - 2023-11-11 - BAYELSA"
  election_date    ISO date
  election_type_id integer                    1=Presidential, 2=Gov, 3=Senate, 4=Reps,
                                              5=Assembly, 6=Chairman, 7=Councillor
  state_id         integer                    1..37, IReV-internal (NOT INEC alpha)
  state            embedded state document    has .name ("BAYELSA") and .code ("06")
  domain_id        integer                    state/LGA/ward/constituency id (depends on election scope)
  domain_type      string                     "App\\Models\\State" | "App\\Models\\Lga" | "App\\Models\\Ward" | etc.
  domain           embedded domain document

State:
  _id              MongoDB ObjectId
  state_id         integer                    1..37
  name             string                     "FCT", "RIVERS"
  code             string                     "37", "32" -- INEC NUMERIC, not the alpha codes we use
```

### Confirmed broken — paths that returned 404

```
/api/v1/results
/api/v1/polling-units/{pu_code}
/api/v1/elections/{slug}/polling-units/{pu_code}
```

…plus every template in the current `CANDIDATE_TEMPLATES` array.

### Why the model mismatch matters

This scraper was designed PU-first: walk every PU in
`Polling-Units/results/*.json` and for each PU fetch all its elections.
The live IReV API is election-first: pick an `election_id`, then traverse
through `state_id → lga_id → ward_id → polling_unit_id` (all
IReV-internal integers, not our INEC delim codes), then fetch the result
for a single `(election_id, pu_id)` pair.

Switching to that model requires (steps revised 2026-05-19 after the
SPA bundle scrape resolved most of the discovery work):

1. ~~Find the 2023 Presidential `election_id`.~~ **Deferred.**
   Presidential is wired in the schema (ObjectId
   `5f0eb67db39f166717b8411f`, accepted by `/elections/{id}/lga`) but
   the active Presidential election is not currently mapped — the
   endpoint returns `data:[]`. Picks up when INEC re-publishes
   Presidential. Note: the rest of the scraper can work on Gov/Senate/
   Reps/Assembly/Chairman/Councillor data right now without this.
2. ~~Find the traversal endpoints.~~ **Done** — see "The traversal
   model" section above. All paths verified against Anambra Gov 2025.
3. ~~Build a mapping from INEC delim codes to IReV internal IDs.~~
   **Not needed.** The per-PU response includes `pu_code` and
   `pu_code_string` directly — join by `pu_code` at ingest.
4. **Rewrite `lib/irev_client.js` and `scrape.js`** around the
   election-first traversal:
     ```
     for each election in GET /elections (filter by type/year):
       lgas = GET /elections/{_id}/lga?election={election_id}
       for each lga, for each ward in lga.wards:
         pus = GET /elections/{_id}/pus?ward={ward._id}&election={election_id}
         for each pu in pus.data:
           if pu.document?.url:
             download pu.document.url -> object store
             persist (pu.pu_code, pu.election_id, pu.document.url, hash)
     ```
   The existing `parse.js` will need a rewrite — the new response
   shape is materially different from the 2023 payload it was built
   for. Vote tallies appear to be absent from `/pus` (the document
   image is the canonical evidence per ADR-0001); aggregate tallies
   are on `/elections/{_id}/result/stats` — verify shape before
   wiring.
5. **Update `lib/endpoint_discovery.js`.** The
   `CANDIDATE_TEMPLATES` array is now obsolete — the SPA bundle is
   the source of truth and the templates above are verified. Either
   replace `CANDIDATE_TEMPLATES` with the verified set (and reframe
   the file as "current API contract" rather than "candidates to
   probe") or delete it and document the contract in `irev_client.js`
   directly.

### Pending verification

- Whether INEC has put authentication or rate limiting in front of
  `dolphin-app-sleqh.ondigitalocean.app` for high-volume traversal
  (the diagnostic curls returned 200 with no apparent throttling, but
  walking 174,175 PUs is a different volume profile).
- ~~Whether the EC8A image URLs returned by the per-PU result endpoint
  reference the S3 buckets above directly or go through a signed-URL
  proxy.~~ Answered 2026-05-19: a 2025 Anambra Gov PU returned
  `document.url = https://inc-s3-cache.incportals.com/cached/express/results/…`
  — i.e. an unsigned CDN cache URL. Whether older 2023 elections
  still point at the S3 origins or have been migrated to the cache
  layer is unverified.
- Whether `parties[]` on the election doc ever gets populated.
  Currently empty on every sampled election; party affiliation may
  only be reachable via `/result/stats` or by parsing the EC8A
  image.
- Whether the SPA's POST traffic to
  `irev-v2.herokuapp.com` / `lv001-r.inecelectionresults.ng` (the
  guest-URL fallback referenced in the bundle) matters for our use
  case. Heroku returns `Host not in allowlist` even with the right
  Origin; the dead lv001-r host means the SPA is broken 1/6 of the
  time for POSTs. None of our planned reads need POST.

### Where to pick up

The API contract is now known (see "The traversal model" section).
Next concrete piece of work is step 4 above: rewrite
`lib/irev_client.js` and `scrape.js` against the verified endpoints,
then rewrite `lib/parse.js` for the new per-PU payload shape.

If Presidential discovery becomes urgent before then, the DevTools
probe on <https://irev.inecnigeria.org/pres/elections> is still the
right move — that's the SPA route that resolves Presidential, and
its Network tab will reveal whatever bootstrap endpoint we haven't
located via static bundle scraping.
