# IReV Scrape Runbook

Operational guide for the `scrapers/irev-results/` scraper against the
post-2026 INEC IReV API. Pair this with the technical contract notes in
`scrapers/irev-results/README.md`.

## Pre-flight (do this every time)

From `scrapers/irev-results/`:

```bash
# 1. Contract verifier — confirms all 5 API routes return the expected
#    shapes against the live backend.
npm run verify

# 2. Tests — sanity check the parser against captured fixtures.
npm test

# 3. CDN reachability — probes one live EC8A image. Exits 0 if the CDN
#    allowlist lets this host through, 1 if blocked.
node scrape.js --check-cdn
```

If `--check-cdn` exits 1, you can still scrape, but with
`--catalog-only`. See the **CDN allowlist** section below.

## Common operations

```bash
# What elections are uploading right now? (no scrape, just stats)
node scrape.js --type GOV --year 2025 --stats

# One ward, ~14 PUs, no writes — fastest validation of the contract.
npm run smoke

# Full election catalog (metadata + image URLs, no image bytes).
node scrape.js --election-id 2919 --catalog-only

# Full election with images (requires CDN allowlist).
node scrape.js --election-id 2919

# One-state pilot with timing, bandwidth, structured report.
node scripts/pilot.js --type GOV --year 2025 --max-pus 200 --catalog-only
# → writes pilot-output/irev_2919/pilot-report.{json,md}
```

## CDN allowlist

The EC8A images live behind `inc-s3-cache.incportals.com`, which
allowlists by host. External scrapers get
`HTTP 403 Host not in allowlist`. Verified 2026-05-19 across the cache
host, the Heroku guest fallback, and the SPA hosts — all gated by the
same allowlist.

**Three ways to deal with this:**

1. **Catalog-only mode.** Use `--catalog-only` to scrape every metadata
   row + image URL without attempting the download. The image bytes can
   be backfilled from an allowlisted host later; the URL is stable, so
   re-downloading produces the same SHA and the evidence chain stays
   intact. Recommended default until allowlist is in place.

2. **Run from an allowlisted IP.** If/when our scrape host is on INEC's
   allowlist, drop the `--catalog-only` flag and the scraper will
   archive image bytes to the configured object store. See
   *Deployment options* below.

3. **Request inclusion.** INEC's public-relations / API contact (per
   the ADR-0001 evidence-handling policy) — explain the project, ask
   for our outbound IP range or scrape-host hostname to be added to
   `inc-s3-cache.incportals.com`'s allowlist. If they decline, fall
   back to (1).

### Deployment options for image-archive runs

The scrape host needs (a) outbound HTTPS to dolphin-app + the CDN,
(b) Postgres for `ec8a_submissions` writes, and (c) S3-compatible
storage for image archive.

- **Self-hosted in NG**: VPS or bare-metal in a Nigerian colocation
  facility — most likely to satisfy INEC's allowlist if they prefer
  Nigerian-network origins.
- **Cloud + static egress IP**: AWS/GCP with a NAT gateway pinned to a
  small set of IPs we can send to INEC for allowlisting.
- **Workstation tunnel**: short-term, a developer's machine routed
  through an allowlisted SOCKS proxy. Fine for one-off backfills, not
  a production posture.

## Presidential elections are not currently scrapable

The Presidential entry point is gone from the post-2026 IReV API.
Verified 2026-05-19:

- `/elections` does not return Presidential rows (all 400 most-recent
  elections are Gov / Senate / Reps / Assembly / Chairman / Councillor).
- The Presidential ObjectId `5f0eb67db39f166717b8411f` (referenced by
  every state's `.presidential` field) **is** accepted by
  `/elections/{id}/lga` — the route returns 200 — but yields `data:[]`.
  The schema slot exists, the data does not.
- The SPA's Presidential component calls `election-reports/election/{id}`,
  which now returns Express 404 (route no longer mounted server-side).
- Guessed routes `/presidential`, `/pres/elections`, `/presidentials`,
  `/presidential-elections`, `/election/1` all 404.

Practical implication: any Presidential-era backfill must wait for INEC
to either re-publish the 2023 Presidential data on the current API, or
provide a separate archive endpoint. We cannot fix this client-side.

## Failure modes and what they mean

| Outcome bucket | Meaning | Operator action |
|---|---|---|
| `ok` | Image downloaded, hashed, uploaded, row persisted. | None. |
| `not_uploaded` | API returned a PU entry with no `document.url`. | Normal — INEC hasn't uploaded an EC8A for this PU yet. |
| `image_blocked` | API gave us the URL but CDN returned 403. | Re-run from allowlisted host, or stay in `--catalog-only`. |
| `error` | Something else broke — network, DB, storage, parse. | Inspect `progress.json` for the message. |

The pilot-report markdown surfaces these buckets and refuses to say
"SHIP" if any `error` rows or any `image_blocked` rows are present.

## Re-running and resuming

Progress is checkpointed to `progress.json` every 25 PUs and at clean
exit. Re-running with the same filters skips PUs already marked done
(`ok` or `not_uploaded`). Use `--reset` to throw away progress and
start over (useful when the parser or contract has changed under you).

## See also

- `scrapers/irev-results/README.md` — full API contract + discovery
  narrative
- ADR-0001 — image-is-canonical evidence policy that scopes the scraper
- `docs/DEPLOYMENT_GUIDE.md` — general deployment posture
