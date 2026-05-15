# Release notes

## v0.1.0 — Launch scaffold complete

**Date**: 2026-05-15
**Status**: Foundation. Pre-launch operational work begins from here.

This is the first tagged release of OpenBallot Nigeria. The release
represents a functionally complete codebase against every capability
claim in the project README. The platform has not yet been deployed
to production; the work that takes it from "tagged scaffold" to "live
service on openballot.ng" is operational, not engineering, and is
documented in detail in `docs/DEPLOYMENT_INFO.md`.

### What's in v0.1.0

**Data plane**
- 11 SQL migrations, all apply cleanly to a fresh Postgres 16 +
  PostGIS 3 via the auto-migrator (`worker -m cli.migrate` under
  pg_advisory_lock)
- 21 application tables covering geography, elections, agents,
  ec8a_submissions, verified_results, discrepancies, anomalies,
  audit_log, audit_anchors, agent_otps, auth_events,
  pending_device_changes, observer_registrations, state_boundaries,
  lga_boundaries, plus rollup views and tile materialised views
- Row-level security policies portable between Supabase and
  self-hosted Postgres

**Verification + trust pillars**
- Multi-source consensus engine covering all six map states
  (`no_data`, `single_source`, `inec_published`, `consensus`,
  `discrepancy`, `inec_confirmed`, `inec_conflict`)
- Three-layer anomaly detection: deterministic sanity checks
  (6 types), statistical peer-outlier detection (3 types),
  historical-baseline comparison (2 types) — 11 anomaly types total
- Tamper-evident audit chain at three implementations: SQL trigger
  (system of record), Python verifier (matches byte-for-byte),
  standalone zero-dependency Python script (`scripts/verify_audit_chain.py`)
- Ethereum mainnet anchor cron with EIP-1559 gas ceiling, two-phase
  idempotent driver, recovery from mid-deploy interruptions

**Ingestion + extraction**
- Async ingestion pipeline: `/v1/ingest` returns 202 in milliseconds;
  background worker consumes from Redis, runs Document AI + GPT-4o
  Vision through the factory-built engine, recomputes verification,
  fires sanity anomalies, writes audit events, publishes SSE updates
- Presigned direct-to-storage uploads (S3 / R2 / MinIO compatible)
  with size + content-type + SHA-256 binding at presign time
- IReV scraper with pilot harness: endpoint discovery, fixture
  capture for unrecognised shapes, full pipeline report, ship-or-hold
  verdict before committing to a multi-day full scrape
- Crashed-worker recovery cron with give-up-after-4h policy
- Retry endpoint for failed extractions

**Identity + access**
- Phone OTP via Twilio (SMS) + WhatsApp Business adapter
  (~60% cheaper at Nigerian rates) with automatic SMS fallback
- E.164 phone normalisation via google-libphonenumber
- JWT (HS256) with device-fingerprint binding so a stolen token from
  a different device is rejected at the auth boundary
- Rate limiting: phone (3 OTPs / 10 min), IP (30 OTPs / hour)
- Party-admin CSV roster onboarding with audit-logged agent provisioning
- Observer self-registration with consortium approval queue
- Consortium reviewer queue for submissions requiring manual approval

**Public read surface**
- Mapbox-rendered choropleth with PostGIS → MVT vector tiles at
  every zoom band (state polygons / LGA / ward / individual PUs)
- Real-time SSE stream from Redis pub/sub
- Per-PU public detail page (`/pu/{pu_code}`) with EC8A image gallery,
  anomaly list, audit-chain entries, full SHA-256 manifest
- Discrepancy register with side-by-side image comparison
- Anomaly register with filter + severity slider
- Full results CSV export (streaming, cursor-paginated, one row per
  PU × candidate, 19 columns)
- SHA-256 hash manifest endpoint for offline verification
- Embeddable iframe widget for media partners
- Five-language nav scaffolding (EN / HA / YO / IG / PCM)
- `/status` public operational dashboard

**Operations**
- Production docker-compose with one-shot migrate job, persistent
  worker + jobworker + anchor cron + anomaly-sweep cron + recovery
  cron services
- Caddy reverse proxy config with HSTS preload, Cloudflare-IP
  allowlist, automatic TLS
- Sentry integration (worker + web/client + web/server + web/edge)
- Prometheus metrics covering ingestion / extraction / auth / anchor /
  anomaly / queue depth, exposed at `/metrics`
- structlog JSON logging in production
- Post-deploy smoke test script (`scripts/post-deploy-smoke.sh`,
  8 checks, exits non-zero on any failure)
- k6 load test scripts for tile read-path + ingest write-path
- End-to-end integration test (`scripts/e2e-test.sh`)
- GitHub Actions CD pipeline: tag → buildx → GHCR → SSH-to-Hetzner →
  migrate → roll → smoke

**Documentation**
- `docs/DEPLOYMENT_INFO.md` — operator handbook (13 external services,
  step-by-step provisioning, complete env var reference, cost
  summary, disaster recovery, credential rotation)
- `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/SECURITY.md`,
  `docs/DEVELOPMENT.md`, `docs/DEPLOYMENT.md`
- `docs/THREAT_MODEL.md` — 8 adversary profiles × attack paths × controls
- `docs/adr/` — 10 architecture decision records with rationale
- `docs/JOURNALIST_QUICKSTART.md` — 10-minute guide for working press
- `docs/INVESTOR_BRIEF.md` — one-pager linking every claim to its code
- `docs/ROADMAP.md` — public roadmap with explicit "we won't do X" section
- `CONTRIBUTING.md`, `CONTRIBUTORS.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`

### Test coverage at this release

- 160 worker tests passing (`pytest -q`)
- 16 scraper tests passing (`node --test`)
- `ruff check app tests cli` clean
- `npm run typecheck` clean
- `npm run lint` clean (warnings only, no errors)
- 11 migrations apply cleanly on a fresh Postgres + PostGIS

### What v0.1.0 deliberately does NOT include

- A live deployment. The codebase is tagged-and-ready; provisioning
  Cloudflare R2, Supabase, Twilio, Document AI, OpenAI, Infura, and
  the Hetzner host is operational work documented but not executed.
- Real Nigerian state polygons. Demo polygons ship in the seed file;
  the operator loads real OCHA/HDX polygons via
  `scripts/load_state_polygons.py` before launch.
- Translated landing copy in HA/YO/IG/PCM. Nav strings are
  translated; longer landing copy falls back to English until
  translators land it.
- A custom Document AI processor trained on EC8A. The adapters
  handle both the generic Form Parser and a custom processor; the
  operator trains the custom processor pre-launch.
- The 2023 IReV full-corpus load. The scraper + pilot harness are
  ready; running the multi-day full scrape happens after the
  pilot's ship/hold verdict.

### Next steps

See `docs/ROADMAP.md` § Next for the operational checklist that
takes the project from this tag to live service on openballot.ng.

### Acknowledgements

This release represents approximately 25 person-weeks of engineering
work compressed into the scaffold. Specific design influences are
recorded in `CONTRIBUTORS.md`.

---

*The form is the truth. The truth is public.*
