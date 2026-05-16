# Deployment Information

This document is the single source of truth for everything an operator
needs to take OpenBallot Nigeria from a fresh clone to a live deployment
at https://openballot.ng. It covers every external service we depend on,
how to provision the account, where the credentials land in our
environment, the recurring cost, and the order in which to set things up.

**Do not commit any real secrets to this repository.** Every value in
this document is a placeholder. Real values live in:

  * **Production**: the secrets store of the deployment platform (e.g.
    Hetzner Cloud Secrets, Vercel Project Environment Variables,
    GitHub Actions Secrets).
  * **Local dev**: a `.env.local` (web) and `.env` (worker) that are
    excluded by `.gitignore`.

Treat any leak of these secrets as a security incident per
`docs/SECURITY.md`.

---

## Table of contents

1. [External services overview](#external-services-overview)
2. [Cloudflare R2 (EC8A image storage + CDN)](#cloudflare-r2-ec8a-image-storage--cdn)
3. [Supabase (Postgres + PostGIS + Realtime + Auth)](#supabase-postgres--postgis--realtime--auth)
4. [Mapbox (vector tiles + base map)](#mapbox-vector-tiles--base-map)
5. [Twilio (agent OTP SMS)](#twilio-agent-otp-sms)
6. [WhatsApp Business API (optional secondary channel)](#whatsapp-business-api-optional-secondary-channel)
7. [Google Document AI (primary OCR)](#google-document-ai-primary-ocr)
8. [OpenAI (GPT-4o Vision fallback)](#openai-gpt-4o-vision-fallback)
9. [Ethereum (audit log anchoring)](#ethereum-audit-log-anchoring)
10. [Hetzner Cloud (worker + web hosting)](#hetzner-cloud-worker--web-hosting)
11. [Vercel (web hosting alternative)](#vercel-web-hosting-alternative)
12. [Cloudflare DNS / SSL / DDoS](#cloudflare-dns--ssl--ddos)
13. [Domain registration](#domain-registration)
14. [Sentry (error monitoring)](#sentry-error-monitoring)
15. [Grafana + Loki + Prometheus (operational metrics)](#grafana--loki--prometheus-operational-metrics)
16. [Complete environment variable reference](#complete-environment-variable-reference)
17. [First-time deployment runbook](#first-time-deployment-runbook)
18. [Post-deployment verification](#post-deployment-verification)
19. [Pre-election readiness checklist (T-14, T-7, T-24h, T-0)](#pre-election-readiness-checklist)
20. [Cost summary](#cost-summary)
21. [Disaster recovery](#disaster-recovery)
22. [Credential rotation policy](#credential-rotation-policy)

---

## External services overview

| # | Service | Purpose | Tier we need | Set up by |
|---|---|---|---|---|
| 1 | Cloudflare R2 | EC8A image storage + CDN delivery | R2 standard | Operations lead |
| 2 | Supabase | Managed Postgres + PostGIS + Realtime + Storage mirror | Pro | Operations lead |
| 3 | Mapbox | Vector tile rendering + base map (optional) | Pay-as-you-go | Web lead |
| 4 | Twilio | Agent OTP SMS | Pay-as-you-go + Nigerian sender ID | Operations lead |
| 5 | WhatsApp Business API | Secondary agent notification channel | Through Meta business account | Optional |
| 6 | Google Cloud (Document AI) | Primary OCR for EC8A extraction | Pay-as-you-go | Worker lead |
| 7 | OpenAI | GPT-4o Vision fallback OCR | Pay-as-you-go | Worker lead |
| 8 | Infura (Ethereum) | Mainnet RPC for OP_RETURN audit anchor | Free tier sufficient | Worker lead |
| 9 | Hetzner Cloud | Worker VPS + Postgres replica (if self-hosting) | CCX line | Operations lead |
| 10 | Vercel (alt to Hetzner for web) | Next.js hosting | Pro | Operations lead |
| 11 | Cloudflare | DNS + edge cache + DDoS + WAF | Pro during elections | Operations lead |
| 12 | Sentry | Error monitoring | Team | Engineering lead |
| 13 | Grafana Cloud | Logs + metrics dashboard | Free tier sufficient | Engineering lead |

We do not depend on any service that holds election results behind a
paywall. Every result on OpenBallot is open data; every dependency above
is either infrastructure (storage, compute, DNS) or a third-party
processor we own the relationship with.

---

## Cloudflare R2 (EC8A image storage + CDN)

EC8A images are the **canonical evidence** of every result on OpenBallot.
They must be:
  * tamper-evident (we control the bucket; SHA-256 is recorded at ingest)
  * publicly readable (any citizen can compare a number to its document)
  * CDN-delivered (election-day traffic spikes do not melt the origin)

R2 satisfies all three at the lowest cost on the market.

### Provisioning

1. Create / log into a Cloudflare account at https://dash.cloudflare.com
2. Workers & Pages → R2 → Create bucket. Name: `openballot-ec8a-evidence`
3. R2 → Manage API tokens → Create API token with permissions:
   * Object Read
   * Object Write
   * Restricted to the bucket above
4. Copy the **Access Key ID** and **Secret Access Key**. These appear
   only once - if lost, create a new token.
5. Bucket settings → Public access → enable, attach a custom domain
   `evidence.openballot.ng` (we configure the CNAME under Cloudflare DNS
   later).
6. CORS policy on the bucket - allow `GET, HEAD` from
   `https://openballot.ng` and `https://*.openballot.ng` so the web app
   can fetch images directly.
7. Object lifecycle: keep all objects forever (no expiry). Storage is
   cheap and the historical archive is part of the platform's value.

### Credentials map to

| Env var | Value |
|---|---|
| `STORAGE_BUCKET` | `openballot-ec8a-evidence` |
| `STORAGE_ENDPOINT` | `https://<account_id>.r2.cloudflarestorage.com` |
| `STORAGE_ACCESS_KEY` | (from step 4) |
| `STORAGE_SECRET_KEY` | (from step 4) |
| `STORAGE_REGION` | `auto` |
| Public CDN URL | `https://evidence.openballot.ng` |

### Storage envelope (2023 historical scrape)

| Election | Approx PUs | Storage at 1MB/image |
|---|---|---|
| Presidential | 176,846 | ~180 GB |
| Senate | 176,846 | ~180 GB |
| Reps | 176,846 | ~180 GB |
| Governorship | ~140,000 | ~140 GB |
| State house | ~140,000 | ~140 GB |
| **Total** | ~810,000 | **~820 GB** |

R2 pricing (as of 2026):
  * Storage: $0.015/GB/month → **~$12/month** at 820GB
  * Class A (writes): $4.50 / million → ~$4 one-time for the full scrape
  * Class B (reads): $0.36 / million → covered by Cloudflare cache
  * **No egress fees** (this is R2's key advantage over S3)

---

## Supabase (Postgres + PostGIS + Realtime + Auth)

Supabase is the primary data plane: PostgreSQL 16 with PostGIS, Realtime
CDC streams for the public map, Row-Level Security for the API layer,
and Storage as a redundant secondary mirror of EC8A images.

### Provisioning

1. Create a Supabase project at https://supabase.com/dashboard
   * **Region**: `eu-central-1` (Frankfurt) - low latency to both
     Nigeria and our Hetzner workers
   * **Plan**: Pro ($25/month) — required for daily backups, log retention,
     and Realtime channels at the scale we need
2. Database → Extensions → enable:
   * `postgis`
   * `pg_stat_statements`
   * `pgcrypto` (already on by default)
3. Database → Migrations → apply all SQL in `db/migrations/` in order
   (0001 → 0007 as of this writing). The CI pipeline runs the same SQL
   against an ephemeral Postgres on every push, so the migrations are
   known-good.
4. Database → Policies → apply `db/policies/rls.sql`.
5. (Optional, post-launch) Database → Read replicas → add one replica in
   `af-south-1` for Africa-region read latency.
6. Project Settings → API → copy:
   * **Project URL** — for OpenBallot Nigeria this is `https://ibkpyiolygwxkltebjpk.supabase.co`
   * **anon public key** (safe to expose; used by browser code)
   * **service_role key** (server-side ONLY; full DB access; treat as a root password)

### Credentials map to

| Env var | Where it is used | Sensitivity |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Web (browser + server) | Public |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Web (browser) | Public (RLS enforces access) |
| `SUPABASE_SERVICE_ROLE_KEY` | Web server routes + Worker | **CRITICAL - root access** |
| `SUPABASE_URL` | Worker (mirrors `NEXT_PUBLIC_SUPABASE_URL`) | Public |
| `DATABASE_URL` | Worker (asyncpg) | **CRITICAL - direct DB access** |

The `DATABASE_URL` value is shown under Project Settings → Database →
Connection string. Use the **session pooler** (port 5432) for the worker
- not the transaction pooler - so PostGIS prepared statements work.

### Cost

| Tier | Monthly |
|---|---|
| Supabase Pro | $25 |
| Compute (4 GB RAM during peak, 2 GB otherwise) | $30 average |
| Storage above 8 GB included | +$0.125/GB |
| Read replica (post-launch) | +$25 |

Realistic monthly cost during steady state: **~$60/month**. Election week:
peaks at $200/month equivalent due to compute autoscale.

---

## Mapbox (vector tiles + base map)

Mapbox is **optional** - the SVG fallback in `web/components/ResultsMap.tsx`
renders the demo without it. For the production investor demo we want
the real renderer.

### Provisioning

1. Create an account at https://account.mapbox.com
2. Account → Tokens → Create public token
   * Name: `openballot-web-public`
   * Scopes: `styles:read`, `fonts:read`, `tiles:read`
   * URL restrictions: `https://openballot.ng/*`, `https://*.openballot.ng/*`,
     `http://localhost:3000/*`
3. Copy the **public access token** (starts with `pk.`)

### Credentials map to

| Env var | Value |
|---|---|
| `NEXT_PUBLIC_MAPBOX_TOKEN` | `pk.eyJ...` |

### Cost

Mapbox bills by tile load. Our deployment uses Mapbox **only for the
basemap raster** (or no Mapbox basemap at all - we already fall back to
OSM raster in `MapboxRenderer.tsx`). Our PU vector tiles come from our
own `/api/v1/tiles` endpoint.

| Volume | Monthly cost |
|---|---|
| 0 - 50k map loads | Free |
| 50k - 1M map loads | $0.50 / 1k |
| 1M+ map loads | Negotiated |

Realistic election-week peak: 250k map loads → ~$125 one-time. Off-peak:
free tier covers it.

**To stay free**: use OSM raster as the basemap (as the scaffolded
`MapboxRenderer.tsx` already does) and reserve Mapbox tokens for premium
styles only. The map renders perfectly without a Mapbox token.

---

## Twilio (agent OTP SMS)

Agent authentication depends on a working SMS channel. Twilio is the
default - see `worker/app/auth/twilio_adapter.py`.

### Provisioning

1. Create account at https://www.twilio.com/try-twilio
2. Console → Phone numbers → Buy a number
   * **Country**: Nigeria (+234)
   * **Capabilities**: SMS only
   * If a Nigerian local number is unavailable, fall back to a UK number
     - but apply for an **Alphanumeric Sender ID** in Nigeria so messages
     show "OpenBallot" instead of an international number.
3. Console → Messaging → Sender IDs → Register `OpenBallot` for Nigeria.
   This requires uploading the consortium registration certificate and
   sample SMS content. Approval takes 2-5 business days.
4. Console → Account Info → copy:
   * **Account SID** (starts with `AC`)
   * **Auth Token**

### Credentials map to

| Env var | Value |
|---|---|
| `TWILIO_ENABLED` | `true` in production; `false` everywhere else |
| `TWILIO_ACCOUNT_SID` | `AC...` (Account SID) |
| `TWILIO_AUTH_TOKEN` | Auth Token |
| `TWILIO_FROM` | The purchased number in E.164, or the approved alphanumeric sender ID |

When `TWILIO_ENABLED=false`, the worker uses the NoOp adapter which logs
the OTP to stdout. **Never deploy production with TWILIO_ENABLED=false.**

### Cost

Twilio Nigeria SMS:
  * **Outbound to Nigerian numbers**: ~$0.0700 / message
  * **Verification SMS** (preferred path via Twilio Verify): $0.05 / verification

At expected 2027 scale:
  * 250,000 party agents × ~3 SMS per agent (OTP + welcome + reminder) = 750k SMS
  * Total: **~$53,000** one-time
  * Mitigation: register Nigerian sender ID for ~30% discount; fall back
    to WhatsApp Business API where number is registered

This is the single largest variable cost. Budget accordingly.

---

## WhatsApp Business API (optional secondary channel)

Many Nigerian agents prefer WhatsApp. Cheaper than SMS where the agent
has registered. Optional, but a meaningful cost saver.

### Provisioning

1. Create / use a Meta Business Manager: https://business.facebook.com
2. Apply for WhatsApp Business API access. Approval takes 1-3 weeks.
3. Use Twilio's WhatsApp integration for a unified API - same Account
   SID, different sender (`whatsapp:+234...`).
4. Submit message templates for the OpenBallot OTP flow for Meta approval
   (templates required for outbound transactional WhatsApp messages).

### Credentials map to

| Env var | Value |
|---|---|
| `WHATSAPP_FROM` | `whatsapp:+234...` |
| `WHATSAPP_TEMPLATE_OTP` | The Meta-approved template name (e.g. `openballot_otp_v1`) |

### Cost

WhatsApp Business pricing (Nigeria, transactional template):
  * ~$0.029 / message
  * Approximately 60% cheaper than SMS

---

## Google Document AI (primary OCR)

The extraction engine's primary backend. See `worker/app/extraction/engine.py`
- swap `StubExtractor` for `DocumentAIExtractor` in production.

### Provisioning

1. Create / select a Google Cloud project at https://console.cloud.google.com
2. APIs & Services → enable **Document AI API**
3. Document AI → Workbench → Create Processor
   * Type: **Form Parser**
   * Region: `us` (or `eu` if data residency matters; for INEC IReV
     historical, either is fine - the images are already public)
4. After processor is created, copy:
   * **Project ID**
   * **Processor ID** (from the processor's overview page)
5. IAM → Create Service Account
   * Name: `openballot-document-ai`
   * Role: **Document AI API User**
6. Generate a JSON key. Store the JSON content as a single-line env var
   (or use Application Default Credentials if running on GCP).
7. (Once available) Train a custom processor on labelled EC8A samples
   from `Polling-Units/results/` plus the 2023 IReV historical images
   for higher accuracy than the generic Form Parser.

### Credentials map to

| Env var | Value |
|---|---|
| `GOOGLE_DOCUMENT_AI_PROJECT` | GCP project ID |
| `GOOGLE_DOCUMENT_AI_PROCESSOR` | Processor ID |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | Full JSON contents of the service account key, as a one-line string |

### Cost

Document AI Form Parser:
  * **$0.05 / page** for the first 1M pages/month
  * **$0.03 / page** above 1M

If we choose to re-OCR the 2023 IReV dataset (we are not, per the prior
decision - we ingest INEC's published numbers):
  * 800k images × $0.05 = $40,000 one-time

For 2027 (live): every party-agent + observer submission goes through
Document AI:
  * 500k submissions × $0.05 = $25,000 election day

---

## OpenAI (GPT-4o Vision fallback)

Secondary OCR backend that handles low-confidence extractions. Used by
`worker/app/extraction/engine.py` when Document AI's confidence drops
below `EXTRACTION_CONFIDENCE_FLOOR` or arithmetic checks fail.

### Provisioning

1. Create account at https://platform.openai.com
2. API keys → Create new secret key
   * Name: `openballot-worker-vision`
   * Restrict to `gpt-4o` (Vision) and nothing else
3. Settings → Limits → set a monthly cap (e.g. $5,000) so a runaway
   process cannot drain the account
4. Settings → Organization → Verify organization

### Credentials map to

| Env var | Value |
|---|---|
| `OPENAI_API_KEY` | `sk-...` |
| `OPENAI_MODEL` | `gpt-4o` |

### Cost

GPT-4o Vision (December 2025 pricing):
  * Input: ~$2.50 / 1M tokens
  * Output: ~$10.00 / 1M tokens
  * One EC8A image (with the standard extraction prompt): ~$0.015 - $0.025

Expected use rate: ~5% of submissions trigger fallback. At 500k 2027
submissions, fallback runs ~25k times → **~$500 election day**.

---

## Ethereum (audit log anchoring)

Every 30 minutes during active elections (configurable via
`ANCHOR_BATCH_INTERVAL_SECONDS`), the worker computes a Merkle root of
the recent audit log entries and writes it to Ethereum mainnet via an
OP_RETURN-style data transaction. This is the third-party-verifiable
anchor that lets anyone confirm our hash chain has not been rewritten.

### Provisioning

1. Create an Infura account at https://www.infura.io
2. Create a new API key with the **Web3 API** product enabled
3. Select **Mainnet** endpoint
4. Create / fund an Ethereum wallet that the worker will use to sign
   anchor transactions:
   * Generate a fresh wallet (hardware wallet recommended)
   * Fund with ~0.5 ETH (covers ~1,500 anchor transactions at typical
     gas)
   * **Restrict scope**: this wallet does nothing except anchor
     transactions. Never reuse for anything else.
   * Capture the **private key** as a secret

### Credentials map to

| Env var | Value |
|---|---|
| `ANCHOR_ENABLED` | `true` in production, `false` in dev |
| `ETHEREUM_RPC_URL` | `https://mainnet.infura.io/v3/<key>` |
| `ETHEREUM_ANCHOR_PRIVATE_KEY` | 0x... (the anchor wallet's private key) |
| `ETHEREUM_ANCHOR_ADDRESS` | 0x... (derived from the private key, also stored for monitoring) |
| `ANCHOR_BATCH_INTERVAL_SECONDS` | 1800 between elections; 600 during election peak |

### Cost

  * Typical OP_RETURN-style anchor TX: ~30k gas at ~25 gwei = ~0.00075 ETH ≈ $2.50
  * One anchor every 30 minutes for 48 hours of election activity = 96
    anchors = ~$240 per election
  * Annual cost (between elections, 1 anchor/hour): 8,760 anchors × $2.50
    = ~$22k/year (this is too expensive; we reduce to 1 anchor / 6 hours
    between elections = ~$3.5k/year)

The cron interval is governed by `ANCHOR_BATCH_INTERVAL_SECONDS`. Tune
this against the gas price oracle in `worker/app/audit/anchor.py`.

---

## Hetzner Cloud (worker + web hosting)

We host the FastAPI worker on Hetzner Cloud in Germany. Low latency to
Supabase (also in Frankfurt), low cost relative to AWS, and EU
jurisdiction for data residency neutrality on a politically sensitive
platform.

### Provisioning

1. Create account at https://www.hetzner.com/cloud
2. New project: `openballot-production`
3. Create server:
   * Image: Ubuntu 24.04 LTS
   * Type: **CCX23** (4 dedicated vCPU, 16 GB RAM, 240 GB SSD) — main worker
   * Location: Falkenstein, DE (close to Supabase Frankfurt)
   * Networking: place in a Hetzner Cloud private network, attach a
     dedicated firewall (allow 22 from ops bastion only, 443 from
     Cloudflare IPs only, internal worker ports only inside the private
     network)
   * SSH keys: upload team SSH keys; disable password auth
4. Create a second CCX23 in a different Hetzner location (e.g. Helsinki)
   for HA when we reach that stage
5. Optional but recommended: separate CCX13 for Redis (queue) and a
   third for Grafana/Loki/Prometheus

### Credentials map to

| Env var | Value |
|---|---|
| `HETZNER_API_TOKEN` | Project API token (used by CI deploy scripts) |

The worker `.env` on the Hetzner host carries all the database/Twilio/
storage/etc. credentials. Store the file at `/etc/openballot/worker.env`
with `chmod 600` owned by the `openballot` system user.

### Cost

| Resource | Monthly |
|---|---|
| 1× CCX23 (worker) | €33 |
| 1× CCX13 (Redis) | €13 |
| 1× CCX13 (monitoring) | €13 |
| Hetzner Load Balancer 11 | €5 |
| Snapshots / backups | €5 |
| **Total** | **~€69/month (~$75)** |

---

## Vercel (web hosting alternative)

Alternative to hosting Next.js on Hetzner. Vercel is the path of least
operational friction; Hetzner is cheaper at scale. Pick one - don't run
both.

### Provisioning

1. Sign in at https://vercel.com with the team GitHub account
2. New project → import `vitalclick/Nigeria-Election-Results-Portal`
3. Framework preset: **Next.js** (auto-detected)
4. Root directory: `web/`
5. Environment variables: set ALL of the `NEXT_PUBLIC_*` vars from the
   reference below, plus `SUPABASE_SERVICE_ROLE_KEY`
6. Build & development settings → Output directory: `.next` (default)
7. Connect a custom domain: `openballot.ng`. Vercel issues the cert.

### Cost

| Plan | Monthly |
|---|---|
| Pro | $20/team member |
| Bandwidth (250k visits ~5-10 GB) | Included |
| Function invocations | Included to 1M; ~$0.60 / 1M after |

Realistic election week peak: **~$150** (Pro + bandwidth overages).

---

## Cloudflare DNS / SSL / DDoS

Cloudflare sits in front of everything. DNS, edge cache, DDoS protection,
WAF.

### Provisioning

1. Add `openballot.ng` as a zone in Cloudflare
2. Change the domain's nameservers at the registrar to Cloudflare's
3. SSL/TLS → **Full (strict)**
4. Speed → Auto Minify, Brotli on
5. Caching → Caching Level: Standard; Browser Cache TTL: Respect existing
   headers
6. Page Rules / Cache Rules:
   * `openballot.ng/api/v1/tiles/*` → Cache Everything, Edge TTL 60s
   * `openballot.ng/api/v1/elections/*/results` → Edge TTL 5s during elections
   * `evidence.openballot.ng/*` → Cache Everything, Edge TTL 1 day
7. Security → Bot Fight Mode on, Challenge Passage 30 min
8. **Upgrade to Pro during election week** ($20/month, gives access to
   WAF custom rules + Image Resizing). Downgrade back to Free after.
9. DDoS → leave at automatic mitigation; review settings T-7 against
   current threat intel

### DNS records

| Record | Type | Value | Proxy |
|---|---|---|---|
| `openballot.ng` | A | Vercel IP (or Hetzner LB IP) | Proxied |
| `api.openballot.ng` | A | Hetzner LB IP (worker) | Proxied |
| `evidence.openballot.ng` | CNAME | R2 public hostname | Proxied |
| `admin.openballot.ng` | A | Same as openballot.ng | Proxied |
| `_acme-challenge.*` | TXT | (issued by ACME during cert renewal) | DNS only |

### Cost

Cloudflare Free is sufficient for normal operation. Pro ($20/month)
for the four weeks around election day.

---

## Domain registration

1. Register `openballot.ng` through a Nigerian registrar (e.g.
   Whogohost, Web4Africa) or through Cloudflare Registrar if `.ng`
   support is added.
2. Set WHOIS privacy where supported.
3. Renewal: 2-year cycle so we never lose the domain mid-election.

### Cost

`.ng` domains: **~$30/year**

---

## Sentry (error monitoring)

Captures unhandled exceptions in both web and worker.

### Provisioning

1. Create org at https://sentry.io
2. New project: `openballot-web` (Platform: Next.js)
3. New project: `openballot-worker` (Platform: Python / FastAPI)
4. Copy the **DSN** for each

### Credentials map to

| Env var | Value |
|---|---|
| `NEXT_PUBLIC_SENTRY_DSN` | Web DSN |
| `SENTRY_DSN` | Worker DSN |
| `SENTRY_ENVIRONMENT` | `production` / `staging` / `development` |

### Cost

Sentry Team: **$26/month** for the first user, $26 each additional.

---

## Grafana + Loki + Prometheus (operational metrics)

Self-hosted on the third Hetzner box. Grafana Cloud's free tier also
works for the first year.

### Provisioning (self-hosted)

```bash
# On the monitoring host
docker run -d --name grafana -p 3000:3000 grafana/grafana
docker run -d --name loki -p 3100:3100 grafana/loki
docker run -d --name prometheus -p 9090:9090 prom/prometheus
```

Then point the worker and web app's log shippers (Promtail, OpenTelemetry
Collector) at the Loki host.

### Credentials map to

| Env var | Value |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://monitoring.internal:4317` |
| `GRAFANA_ADMIN_PASSWORD` | (set on first boot) |

---

## Complete environment variable reference

This is the canonical list. Every variable used anywhere in the codebase
appears here. Cross-reference with `.env.example` (which keeps the same
order).

### Web (Next.js)

| Variable | Required | Default in mock mode | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | prod | unset → mock mode | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | prod | unset | Browser-safe Supabase key |
| `SUPABASE_SERVICE_ROLE_KEY` | prod | — | **CRITICAL** server-only |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | optional | unset → SVG fallback | Public Mapbox token, URL-restricted |
| `NEXT_PUBLIC_WORKER_URL` | yes | `http://localhost:8000` | Worker base URL |
| `NEXT_PUBLIC_BUILD_SHA` | optional | `dev` | Git SHA, surfaced in /api/v1/health |
| `NEXT_PUBLIC_SENTRY_DSN` | optional | — | Sentry web DSN |

### Worker (FastAPI)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | local pg | asyncpg connection string |
| `REDIS_URL` | yes | local redis | Queue backend |
| `STORAGE_ENDPOINT` | yes | local minio | R2 endpoint URL |
| `STORAGE_BUCKET` | yes | `ec8a-evidence` | Bucket name |
| `STORAGE_ACCESS_KEY` | yes | minio default | R2 access key |
| `STORAGE_SECRET_KEY` | yes | minio default | R2 secret key |
| `STORAGE_REGION` | no | `auto` | R2 uses `auto`; S3 needs region |
| `GOOGLE_DOCUMENT_AI_PROJECT` | prod | — | GCP project ID |
| `GOOGLE_DOCUMENT_AI_PROCESSOR` | prod | — | Document AI processor ID |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | prod | — | Service account JSON, single line |
| `OPENAI_API_KEY` | prod | — | OpenAI vision fallback |
| `OPENAI_MODEL` | no | `gpt-4o` | Vision model |
| `ETHEREUM_RPC_URL` | prod | — | Infura mainnet URL |
| `ETHEREUM_ANCHOR_PRIVATE_KEY` | prod | — | Anchor wallet key |
| `ETHEREUM_ANCHOR_ADDRESS` | prod | — | Derived address (monitoring) |
| `ANCHOR_ENABLED` | yes | `false` | Gate so dev never spends gas |
| `ANCHOR_BATCH_INTERVAL_SECONDS` | no | `1800` | 30 min between anchors |
| `TWILIO_ENABLED` | yes | `false` | Must be `true` in production |
| `TWILIO_ACCOUNT_SID` | prod | — | `AC...` |
| `TWILIO_AUTH_TOKEN` | prod | — | Auth token |
| `TWILIO_FROM` | prod | — | E.164 sender or alphanumeric ID |
| `WHATSAPP_FROM` | optional | — | `whatsapp:+234...` |
| `WHATSAPP_TEMPLATE_OTP` | optional | — | Meta template name |
| `AGENT_JWT_SECRET` | yes | dev default | **CRITICAL** rotate quarterly |
| `AGENT_JWT_TTL_SECONDS` | no | `86400` | 24h |
| `OTP_LENGTH` | no | `6` | |
| `OTP_TTL_SECONDS` | no | `300` | 5 min |
| `OTP_MAX_ATTEMPTS` | no | `5` | Per OTP |
| `OTP_MAX_REQUESTS_PER_PHONE_PER_10MIN` | no | `3` | Anti-flood |
| `OTP_MAX_REQUESTS_PER_IP_PER_HOUR` | no | `30` | Anti-cycle |
| `GPS_GEOFENCE_METRES` | no | `100` | Soft warn |
| `GPS_HARD_BLOCK_METRES` | no | `2000` | Hard reject |
| `MIN_IMAGE_BYTES` | no | `60000` | Reject thumbnails |
| `MAX_IMAGE_BYTES` | no | `12000000` | Cap payload |
| `EXTRACTION_CONFIDENCE_FLOOR` | no | `0.85` | Below this → human review |
| `CONSENSUS_MIN_SOURCES` | no | `2` | For consensus state |
| `CONSENSUS_TOLERANCE_VOTES` | no | `0` | Exact match required |
| `SENTRY_DSN` | optional | — | Worker DSN |
| `SENTRY_ENVIRONMENT` | optional | — | `production` etc. |
| `LOG_LEVEL` | no | `INFO` | |
| `ENVIRONMENT` | no | `development` | |

### Scraper (Node IReV)

See `scrapers/irev-results/README.md`. Key variables:

| Variable | Required | Default | Notes |
|---|---|---|---|
| `IREV_BASE` | yes | `https://lv.irev.inecnigeria.org` | Verify before each run |
| `IREV_RESULT_PATHS` | yes | three known shapes | Override after discovery |
| `IREV_ID_PRESIDENTIAL` | yes | `presidential-2023` | Confirm with IReV |
| `IREV_ID_SENATE` | yes | `senate-2023` | |
| `IREV_ID_REPS` | yes | `house-of-reps-2023` | |
| `IREV_ID_GOV` | yes | `governorship-2023` | |
| `IREV_ID_STHA` | yes | `state-house-2023` | |
| `IREV_DELAY_MS` | no | `450` | Inter-request delay |
| `IREV_CONCURRENCY` | no | `4` | Parallel workers |
| (storage / DB shared with worker above) | | | |

---

## First-time deployment runbook

Execute in this order. Each step has a verification step before
proceeding to the next.

### Phase 1 - Infrastructure (T-30 days)

1. Register `openballot.ng`. Verify WHOIS resolves.
2. Add zone to Cloudflare. Verify nameserver delegation.
3. Provision Cloudflare R2 bucket + API token. Verify with `aws s3 ls
   s3://openballot-ec8a-evidence --endpoint-url $STORAGE_ENDPOINT`.
4. Provision Supabase project. Verify by connecting `psql "$DATABASE_URL"`.
5. Apply all migrations (`db/migrations/0001..0007`) via Supabase SQL editor
   or `psql -f`. Apply RLS (`db/policies/rls.sql`). Verify with
   `SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';`
   - expect **17 application tables**.
6. Provision Twilio account. Buy Nigerian number or register sender ID.
7. Provision Document AI project + processor. Test extraction on a sample
   EC8A image from `Polling-Units/results/<state>/sample.jpg`.
8. Provision OpenAI account. Create API key.
9. Provision Infura. Generate anchor wallet, fund with 0.5 ETH. Send a
   test 0-ETH transaction to confirm signing works.
10. Provision Sentry projects (web + worker).

### Phase 2 - Application deploy (T-21 days)

11. Provision Hetzner cloud server (CCX23). Harden per
    `docs/SECURITY.md`: firewall, fail2ban, unattended-upgrades, SSH
    hardening.
12. Install Docker + Docker Compose on the Hetzner host.
13. Write `/etc/openballot/worker.env` with every prod credential (file
    mode 600, owner `openballot`).
14. Deploy worker via `docker compose -f infra/docker-compose.prod.yml up
    -d` (a future PR adds this; in the meantime, build the worker image
    and run it directly).
15. Verify worker: `curl https://api.openballot.ng/v1/health` returns
    `{"status":"ok"}`.
16. Verify auth: request an OTP for a registered test phone; check the
    Twilio console logs show the message dispatched; verify the OTP and
    confirm a JWT comes back.
17. Verify audit chain: `curl https://api.openballot.ng/v1/audit/verify`
    returns `{"ok":true,"events_checked":N}`.
18. Vercel: import repo, set all `NEXT_PUBLIC_*` env vars, deploy.
    Verify https://openballot.ng renders the landing page.
19. DNS: cut `openballot.ng` and `api.openballot.ng` to production.
    Wait for propagation (15 min typical).
20. Cloudflare cache rules: apply per the section above. Verify the tile
    endpoint hits the edge cache on the second request (`cf-cache-status:
    HIT`).

### Phase 3 - Data load (T-14 to T-7 days)

21. Run polling-unit registry scraper (`Polling-Units/scraper.js`) to
    populate `polling_units` for all 36 states + FCT. Expected count:
    **176,846 rows**.
22. Refresh tile-cache materialised views:
    `psql "$DATABASE_URL" -c "SELECT refresh_tile_caches();"`
23. Run IReV pilot scrape: `cd scrapers/irev-results && node
    scripts/pilot.js --state Lagos --election presidential --limit 200`.
    Inspect `pilot-output/pilot-report.md`; verdict must be **ship**.
24. Update parser if the pilot reports unrecognised shapes; re-run pilot.
25. Kick off full scrape: `node scrape.js`. Monitor `progress.json`.
26. Verify per-state counts after each ballot completes. Compare to
    INEC's published official totals.

### Phase 4 - Pre-launch (T-7 days)

27. Load test the worker: ingestion sustained at 150 submissions/sec for
    1 hour (use the wrk script in `scripts/loadtest.sh` - to be added).
28. Load test the tile endpoint: 1000 concurrent tile requests at zoom
    7-12. Verify p95 < 200ms.
29. Run penetration test (internal or external). Address every Critical
    + High finding before T-0.
30. Refresh anchor wallet ETH balance to ~1.0 ETH.
31. Run a full disaster recovery rehearsal: nuke a Hetzner instance,
    restore from snapshot, verify zero data loss.

### Phase 5 - Launch (T-0)

32. Upgrade Cloudflare zone to Pro.
33. Reduce `ANCHOR_BATCH_INTERVAL_SECONDS` from 1800 to 600.
34. Page the operations rota.
35. Tweet / press release / partner notification.
36. Watch Grafana. Stay calm.

---

## Post-deployment verification

After each deploy, the following must all pass before the deploy is
considered complete. Automated in `scripts/post-deploy-smoke.sh`.

| Check | Command | Pass criterion |
|---|---|---|
| Web alive | `curl -fsS https://openballot.ng/api/v1/health` | 200 + `{"status":"ok"}` |
| Worker alive | `curl -fsS https://api.openballot.ng/v1/health` | 200 |
| Audit chain unbroken | `curl -fsS https://api.openballot.ng/v1/audit/verify?limit=10000` | `"ok":true` |
| Tile endpoint live | `curl -fsS -o /dev/null -w "%{http_code}" "https://openballot.ng/api/v1/tiles/2023-presidential/0/0/0.mvt"` | 200 or 204 |
| TLS cert valid | `echo \| openssl s_client -servername openballot.ng -connect openballot.ng:443 2>/dev/null \| openssl x509 -noout -dates` | Cert valid 30+ days |
| RLS enforced | Hit `/api/v1/elections` as anon - returns data; hit raw `agents` table - 403 | as described |
| OTP rate limit | Request 4 OTPs for the same phone in 10 min | 4th returns 429 |
| Sentry receives events | Trigger a known error path | Event appears within 60s |

---

## Pre-election readiness checklist

### T-14 days

- [ ] Full data load complete; per-state PU counts match INEC reference
- [ ] Audit chain verified end-to-end (`pytest tests/test_audit_chain.py`
      + `/v1/audit/verify` on production)
- [ ] All seven SQL migrations applied; `db/policies/rls.sql` applied
- [ ] R2 bucket holds the full image archive; SHA-256 spot-check passes
- [ ] Mapbox token live; map renders at all zoom levels
- [ ] Twilio sender ID approved; test OTP successfully received in Nigeria

### T-7 days

- [ ] Load test passed
- [ ] Penetration test report addressed
- [ ] Anchor wallet funded with at least 1.0 ETH
- [ ] DNS TTLs reduced to 60s for fast failover
- [ ] On-call rota staffed, paging tested
- [ ] Backup Twilio numbers + WhatsApp templates approved
- [ ] All consortium reviewer accounts active and 2FA-enabled

### T-24 hours

- [ ] Schema migration freeze in effect
- [ ] Cloudflare Pro upgrade applied
- [ ] Anchor interval reduced to 10 min
- [ ] Hetzner snapshots taken (worker + monitoring hosts)
- [ ] Supabase backup verified
- [ ] All translations (HA, YO, IG, PCM) reviewed by native speakers
- [ ] Status page (`status.openballot.ng`) live and primed for incidents

### T-0 (election morning)

- [ ] Open the [Grafana dashboard](https://grafana.openballot.ng/d/elections)
- [ ] Confirm worker autoscale triggered as expected
- [ ] Confirm SSE stream healthy: `curl -N
      https://openballot.ng/api/v1/elections/2027-presidential/stream`
      emits heartbeats
- [ ] Watch ingestion queue depth; alert if backlog exceeds 5 minutes
- [ ] Watch audit chain anchor success rate

---

## Cost summary

Steady-state monthly cost (off-election):

| Service | Monthly |
|---|---|
| Cloudflare R2 (~820 GB) | $12 |
| Supabase Pro + compute | $60 |
| Hetzner (3 boxes + LB + snapshots) | $75 |
| Vercel Pro (optional if not on Hetzner) | $20 |
| Cloudflare (Free tier) | $0 |
| Sentry Team | $26 |
| Domain (annualised) | $3 |
| Mapbox (free tier) | $0 |
| Twilio (minimal between elections) | $5 |
| Infura (free tier) | $0 |
| **Total** | **~$200/month** |

Election week (one-time spikes):

| Item | Cost |
|---|---|
| Cloudflare Pro upgrade (1 month) | $20 |
| Twilio SMS (250k agents × 3) | $53,000 |
| Document AI (500k extractions) | $25,000 |
| OpenAI fallback (~25k images) | $500 |
| Ethereum anchor (96 anchors × $2.50) | $240 |
| Vercel bandwidth overage | $150 |
| Mapbox tile loads | $125 |
| **Election week one-time** | **~$79,000** |

For the 2023 historical scrape (we ingest INEC's published numbers, no
re-OCR): essentially $0 marginal cost - just the storage at $12/month
ongoing.

---

## Disaster recovery

### Scenarios and procedures

**Hetzner worker host dies**
1. Promote standby Hetzner instance via load balancer.
2. Restore latest snapshot to a fresh CCX23.
3. Replay any queue items from Redis backup (queue is append-only).
4. **RTO: 15 minutes. RPO: 0 (queue is durable).**

**Supabase database corruption**
1. Use Supabase point-in-time recovery to roll back to the last clean
   minute.
2. Replay audit_log re-application from the worker's local log shipper.
3. Run `/v1/audit/verify` to confirm chain intact post-restore.
4. **RTO: 30 minutes. RPO: 1 minute.**

**Cloudflare R2 outage**
1. Failover to Supabase Storage mirror (configured as secondary at
   bucket creation time).
2. Public image URLs redirect via CDN rule.
3. **RTO: 5 minutes. RPO: 0.**

**Twilio API down**
1. Auth router falls through to WhatsApp Business API if configured.
2. If WhatsApp also down: agents on election day proceed with the cached
   token from morning login. Re-auth waits for SMS recovery.
3. **No RTO impact during normal election operations.**

**Ethereum mainnet congestion (gas > 200 gwei)**
1. Anchoring continues but cost rises.
2. The cron has a max-gas-price ceiling (`ANCHOR_MAX_GAS_GWEI`); above
   it, anchors queue locally until gas drops.
3. The audit chain remains valid in our DB; the anchor is the
   third-party witness layer, not the chain itself.

### Backup inventory

| What | Where | Frequency | Retention |
|---|---|---|---|
| Postgres data | Supabase managed backups | Daily | 30 days |
| Postgres WAL | Supabase point-in-time recovery | Continuous | 7 days |
| R2 images | R2 native + Supabase Storage mirror | At ingest | Forever |
| Redis queue | RDB snapshot every 60s | Continuous | 24h |
| Audit log mirror | Object storage CSV export | Hourly during elections | Forever |
| Hetzner instance snapshots | Hetzner | Daily | 7 days |
| GitHub repo | GitHub + a weekly tarball to R2 | Continuous | Forever |

---

## Credential rotation policy

| Secret | Rotation cadence | Procedure |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Quarterly | Generate new in Supabase dashboard; update Hetzner + Vercel envs; verify deploy; revoke old |
| `AGENT_JWT_SECRET` | Quarterly OR after any suspected leak | Generate via `openssl rand -hex 48`; update worker env; all agents must re-authenticate (24h grace via dual-key verification window) |
| `TWILIO_AUTH_TOKEN` | Quarterly | Twilio dashboard → new token → update env → revoke old after deploy verified |
| `STORAGE_SECRET_KEY` | Semi-annual | New R2 token → update worker → revoke old after deploy verified |
| `ETHEREUM_ANCHOR_PRIVATE_KEY` | Annual or after any host compromise | Generate new wallet; sweep remaining ETH to new wallet; update env; revoke old (cannot truly revoke - just sweep) |
| `OPENAI_API_KEY` | Quarterly | platform.openai.com → new key → update worker → revoke old |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | Quarterly | New service account key in GCP IAM; update env; delete old key |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | Annual or on URL restriction change | New restricted token in Mapbox dashboard; update env; revoke old |
| SSH keys to Hetzner | Per personnel change | Add new key first, verify access, remove old |

### Emergency revocation

If any of the **CRITICAL** credentials above is suspected leaked:

1. **Immediately**: revoke via the provider dashboard (do not wait for
   the rotation procedure - that comes after).
2. Page the ops on-call.
3. Issue a security incident under `docs/SECURITY.md` § Responsible
   Disclosure.
4. Audit the relevant access logs for activity that pre-dates the
   revocation.
5. File a public post-mortem after resolution.

---

*This document is the operator's handbook. Keep it current. If a service
or credential changes and this doc is not updated in the same PR, that
is a failure of the deploy.*
