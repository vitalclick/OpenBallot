# Contributing to OpenBallot Nigeria

OpenBallot Nigeria is open source under AGPL-3.0. Contributions from
engineers, designers, translators, civic-tech researchers, election
observers, and Nigerian developers in particular are very welcome.

## Quick start

```bash
git clone https://github.com/vitalclick/Nigeria-Election-Results-Portal
cd Nigeria-Election-Results-Portal
docker compose -f infra/docker-compose.yml up --build
# web   -> http://localhost:3000
# api   -> http://localhost:8000/docs
```

For the deeper setup story see `docs/DEVELOPMENT.md`.

## Where to start

| Area | Files | Good first issues |
|---|---|---|
| Translations | `web/messages/{ha,yo,ig,pcm}.json` | Fill in landing copy strings |
| OCR samples | `Polling-Units/` | Help label EC8A samples for the custom processor |
| Geo data | `db/seed/02_state_polygons.sql` | Replace placeholder polygons with real OCHA polygons |
| Tests | `worker/tests/`, `scrapers/irev-results/test/` | Adding edge cases never hurts |
| Documentation | `docs/` | Operator handbooks, accessibility guides |
| Frontend | `web/components/` | Polish, mobile fixes, dark mode |

If you're not sure where to start, open a GitHub Discussion describing
what you want to work on.

## Workflow

1. **Open an issue or discussion first** for anything non-trivial.
   We'd rather avoid you spending a week on a PR we cannot accept.
2. **Branch from `main`**, name the branch after the issue:
   `fix/123-statistical-zscore-off-by-one`.
3. **Write tests**. Anything that touches the verification engine,
   the audit chain, or the anomaly detector must have unit-test
   coverage. New endpoints get at least one happy-path + one
   failure-path test.
4. **Run the local checks** before pushing:
   ```bash
   cd worker && ruff check app tests cli && pytest -q
   cd ../web && npm run typecheck && npm run lint
   cd ../scrapers/irev-results && node --test test/*.js
   ```
5. **Push to your fork**, open a PR against `main`. Fill in the PR
   template. Sign the CLA (a comment on first PR — automated).
6. A maintainer reviews. Most reviews come back the same week.
7. Squash-merge after review approval + green CI.

## CLA

Because of the AGPL-3.0 choice (ADR-0009), the consortium needs the
option to relicense in future for legitimate public-interest cases.
First-time contributors are asked to sign a Contributor Licence
Agreement (Apache CCLA boilerplate, plain English). A bot comments on
your first PR with the link.

## Code style

- **Python**: ruff config in `pyproject.toml`; line length 100;
  Pydantic v2 models at every service boundary.
- **TypeScript**: strict mode; no `any` in production code; mock-mode
  fallbacks always required for new API routes.
- **SQL**: snake_case identifiers; explicit `BEGIN; ... COMMIT;` in
  every migration; new migrations follow the `NNNN_short_slug.sql`
  numbering.
- **Tests**: descriptive names — `test_recover_one_gives_up_after_threshold`
  rather than `test_2`. Each test asserts one behaviour.

## What we won't merge

- Anything that adds a path to publish a result without its EC8A
  image (ADR-0001).
- Anything that displays a `consensus` status from a single source
  (ADR-0002).
- Closed-source dependencies on the hot path. Optional integrations
  (Document AI, OpenAI, Twilio) are fine because operators can opt
  out; a closed-source ingestion library is not.
- Telemetry that leaks PII. Phone numbers and device fingerprints
  never leave the worker.

## Sensitive contributions

If you find a security issue do NOT file a public issue. Email
**security@openballot.ng** with the details. See
`docs/SECURITY.md` for the disclosure policy.

## Recognition

Contributors are listed in `CONTRIBUTORS.md` (generated from git
history at release time). Significant code contributors are also
eligible for nomination to the technical advisory committee.

## Code of Conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
The consortium enforces it via `conduct@openballot.ng`.
