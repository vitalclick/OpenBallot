# IReV results scraper

Ingests the 2023 Nigerian general election results from INEC's IReV portal
into the OpenBallot platform. Walks the polling-unit registry produced by
`Polling-Units/scraper.js` and, for each (election × PU) pair, fetches the
published result + EC8A image, mirrors the image to our storage, and writes
an `ec8a_submissions` row with `source_type='inec_irev'`.

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
