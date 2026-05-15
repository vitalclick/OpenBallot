# Deployment Guide

This is the **playbook**: do this, then this, then this. The
companion document `DEPLOYMENT_INFO.md` is the **reference** — every
service, every env var, every cost line. Use the two together: the
guide tells you the order, the info doc tells you what each thing is.

The guide is opinionated. It matches the hosting recommendation in
the README and assumes the consortium has chosen:

- **Hetzner Cloud** (Falkenstein, DE) for worker + cron services
- **Supabase Pro** (Frankfurt) for Postgres + PostGIS + Realtime
- **Cloudflare R2** for EC8A image storage
- **Cloudflare** for DNS + CDN + DDoS
- **Hetzner self-hosted web** during pre-launch; **Vercel Pro** for
  the election cycle

If you've chosen a different shape (e.g. all-Vercel, or all-AWS),
the phases below still apply but the commands change. The
`DEPLOYMENT_INFO.md` table maps every service to its env var so a
swap is mechanical.

---

## Table of contents

1. [Two deployment shapes](#two-deployment-shapes)
2. [Pre-flight checklist](#pre-flight-checklist)
3. [Phase 0 — Domain + DNS bootstrap](#phase-0--domain--dns-bootstrap)
4. [Phase 1 — Provision external services](#phase-1--provision-external-services)
5. [Phase 2 — Provision the Hetzner host](#phase-2--provision-the-hetzner-host)
6. [Phase 3 — Secrets + worker.env](#phase-3--secrets--workerenv)
7. [Phase 4 — First deploy](#phase-4--first-deploy)
8. [Phase 5 — Verify](#phase-5--verify)
9. [Phase 6 — Load real data](#phase-6--load-real-data)
10. [Phase 7 — DNS cutover](#phase-7--dns-cutover)
11. [Phase 8 — Pre-election switch (T-30 days)](#phase-8--pre-election-switch-t-30-days)
12. [Phase 9 — Election day operations](#phase-9--election-day-operations)
13. [Phase 10 — Post-election archive](#phase-10--post-election-archive)
14. [Rollback procedures](#rollback-procedures)
15. [Common gotchas](#common-gotchas)

---

## Two deployment shapes

The deployment has two shapes you'll switch between:

### Shape A — Pre-launch (steady-state)

```
            Cloudflare DNS (Free tier)
                   │
                   ▼
      ┌────────────────────────────┐
      │  Hetzner CCX23 (Falkenstein)│
      │                            │
      │  caddy ──┬─ web (Next.js)  │
      │          ├─ worker (FastAPI)│
      │          ├─ jobworker (×1)  │
      │          ├─ anchor cron     │
      │          ├─ anomaly-sweep   │
      │          ├─ recovery cron   │
      │          └─ redis           │
      └────────────────────────────┘
                   │
        ┌──────────┼──────────────┐
        ▼          ▼              ▼
   Cloudflare   Supabase Pro   External APIs
   R2 storage   (Frankfurt)    Twilio / Doc AI /
                               OpenAI / Infura
```

Total cost: ~$200/month. Web served from Hetzner; SSE works natively.

### Shape B — Election cycle (~T-30 days through T+30 days)

```
            Cloudflare DNS (Pro tier, $20/mo)
                   │
                   ▼
   ┌────────────┐       ┌────────────────────────────┐
   │   Vercel   │  ◄──  │  Hetzner CCX23             │
   │ (web only) │       │  worker + jobworker (×4-8) │
   └────────────┘       │  cron services             │
                        │  redis                     │
                        └────────────────────────────┘
                                  │
                       (same data plane as Shape A)
```

Difference: web layer flips to Vercel for managed scaling + edge
caching; Cloudflare upgrades to Pro for the WAF and image-resizing
rules. Worker stays on Hetzner.

The switch in both directions is reversible and documented in
[Phase 8](#phase-8--pre-election-switch-t-30-days).

---

## Pre-flight checklist

### Accounts you'll need

You'll need an account on every service in this list before starting
Phase 1. The full provisioning steps for each are in
`docs/DEPLOYMENT_INFO.md`; this is just the inventory.

- [ ] **Cloudflare** — DNS + R2 + CDN + WAF
- [ ] **Supabase** — managed Postgres + PostGIS
- [ ] **Hetzner Cloud** — VPS (Falkenstein region)
- [ ] **Twilio** — SMS + WhatsApp
- [ ] **Google Cloud** — Document AI
- [ ] **OpenAI** — GPT-4o Vision
- [ ] **Infura** — Ethereum RPC
- [ ] **Sentry** — error monitoring
- [ ] **Mapbox** — optional, base map only (OSM raster works too)
- [ ] **GitHub** — the OpenBallot repository + Actions for CD

### Tools on your laptop

- [ ] `git`, `gh` (GitHub CLI)
- [ ] `ssh` with a keypair
- [ ] `psql` 16+
- [ ] `docker` and `docker compose` v2+
- [ ] `node` 20+ and `npm`
- [ ] `python` 3.11+
- [ ] `jq`, `curl`, `openssl`
- [ ] `aws` CLI v2 (for R2 verification only)

### A second pair of eyes

Bring a colleague on the call for Phases 2 (Hetzner provisioning) and
3 (secrets). Two-person ops on credential-handling steps is the
default at any organisation that handles sensitive data; we follow
the same rule. The reviewer's job: watch your screen, confirm each
command before you execute it.

---

## Phase 0 — Domain + DNS bootstrap

**Goal**: the domain points at Cloudflare nameservers, ready for
records to be added in later phases.

**Time**: 5 minutes of work + propagation wait (up to 48 hours; usually 15 minutes).

### Steps

1. Register `openballot.ng` through a Nigerian registrar (Whogohost or
   Web4Africa are the usual choices) — see `DEPLOYMENT_INFO.md` § Domain
   registration. Pay for **two years** so you don't lose the domain
   mid-cycle.

2. Add the zone to Cloudflare:
   - Sign in at https://dash.cloudflare.com
   - Add a site → `openballot.ng` → Free plan (we'll upgrade to Pro
     in Phase 8)
   - Cloudflare gives you two nameservers (e.g. `lia.ns.cloudflare.com` + `clay.ns.cloudflare.com`)

3. At the registrar's control panel, change the domain's nameservers
   to the two Cloudflare values.

4. Wait for propagation:
   ```bash
   dig +short ns openballot.ng
   ```
   Should return the Cloudflare nameservers. May take up to 48 hours
   but typically completes in 15 minutes.

### Checkpoint

```bash
dig +short ns openballot.ng
# expected: two .cloudflare.com lines
```

If you see your registrar's old nameservers, wait longer. Do not
proceed to Phase 1 until DNS is moved.

---

## Phase 1 — Provision external services

**Goal**: every external account exists, every API key is captured in
your password manager.

**Time**: 2-3 hours; some services have approval delays (Twilio
sender ID approval takes 2-5 business days, WhatsApp Business 1-3
weeks).

Each subsection has the **must do** steps. Reference data on plan
tiers + cost lives in `DEPLOYMENT_INFO.md`.

### 1.1 Cloudflare R2

```
Bucket name        : openballot-ec8a-evidence
Public access      : enable, attach evidence.openballot.ng
CORS               : allow GET, HEAD from https://openballot.ng,
                     https://*.openballot.ng
Lifecycle          : keep forever (no expiry)
API token scope    : Object Read + Object Write, restricted to bucket
```

Capture:
- `STORAGE_ACCESS_KEY`
- `STORAGE_SECRET_KEY`
- `STORAGE_ENDPOINT` (`https://<account_id>.r2.cloudflarestorage.com`)

Verify with:
```bash
aws s3 ls s3://openballot-ec8a-evidence \
  --endpoint-url "$STORAGE_ENDPOINT"
# Should list 0 objects, not error.
```

### 1.2 Supabase Pro

```
Project name       : openballot-production
Region             : eu-central-1 (Frankfurt)
Plan               : Pro ($25/mo)
Database extensions: postgis, pg_stat_statements, pgcrypto
```

After project creation:
1. Open the SQL editor → run `CREATE EXTENSION IF NOT EXISTS postgis;`
2. Note the `Project URL`, `anon` key, and `service_role` key from
   Settings → API. The `service_role` key is **root-equivalent**;
   treat it like a database password.

Capture:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `DATABASE_URL` (Settings → Database → Connection string → session pooler, port 5432)

**Do NOT apply migrations yet.** The auto-migrator in Phase 4 does that.

### 1.3 Cloudflare DNS records

Add the records you'll need later (most still point at placeholder IPs
or "Proxied" without a target yet):

| Record | Type | Value | Proxy |
|---|---|---|---|
| `openballot.ng` | A | placeholder (e.g. 192.0.2.1) | Proxied |
| `api.openballot.ng` | A | placeholder | Proxied |
| `evidence.openballot.ng` | CNAME | R2 public hostname from 1.1 | Proxied |
| `status.openballot.ng` | CNAME | `openballot.ng` | Proxied |

The A-record IPs get updated when the Hetzner host is up in Phase 2.

### 1.4 Twilio

```
Phone number    : Nigerian local (preferred); UK fallback if unavailable
Capabilities    : SMS
Alphanumeric ID : register "OpenBallot" for Nigeria - 2-5 business day approval
```

Apply for the sender ID immediately so the approval clock is running.

Capture:
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM`

### 1.5 WhatsApp Business (optional but recommended)

Apply via Twilio's WhatsApp integration — same account, different sender.
The approval window (1-3 weeks via Meta Business Manager) is longer
than the SMS path; start it now even if you'll launch on SMS-only.

Capture (when approved):
- `WHATSAPP_FROM` (format `whatsapp:+234...`)
- `WHATSAPP_TEMPLATE_OTP` (your Meta-approved template SID)

### 1.6 Google Document AI

```
GCP project         : openballot-prod
APIs enabled        : Document AI API
Processor type      : Form Parser  (or custom EC8A processor when trained)
Region              : us  (eu also fine; matches Supabase region preference)
Service account     : openballot-document-ai
Service account role: Document AI API User
```

Generate a JSON key for the service account. Store the contents as a
**single-line** env var (escape newlines or use base64).

Capture:
- `GOOGLE_DOCUMENT_AI_PROJECT`
- `GOOGLE_DOCUMENT_AI_PROCESSOR`
- `GOOGLE_APPLICATION_CREDENTIALS_JSON` (the entire JSON, one line)

### 1.7 OpenAI

Create a new API key restricted to `gpt-4o` only. Set a monthly cap
(e.g. $5,000) under Settings → Limits so a runaway worker can't drain
the account.

Capture:
- `OPENAI_API_KEY`

### 1.8 Infura + anchor wallet

1. Create an Infura account; create a Web3 API key with the Mainnet
   endpoint enabled.
2. Generate a fresh Ethereum wallet (hardware wallet recommended):
   - Use any wallet that exports a private key (MetaMask, Ledger, etc.)
   - Fund with ~0.5 ETH from your treasury wallet
   - This wallet does NOTHING except anchor TXes. Never reuse.

Capture:
- `ETHEREUM_RPC_URL` (`https://mainnet.infura.io/v3/<key>`)
- `ETHEREUM_ANCHOR_PRIVATE_KEY` (the 0x-prefixed hex string)
- `ETHEREUM_ANCHOR_ADDRESS` (derived; useful for monitoring)

### 1.9 Sentry

Create two projects:
- `openballot-web` (platform: Next.js)
- `openballot-worker` (platform: Python / FastAPI)

Capture:
- `SENTRY_DSN` (worker)
- `NEXT_PUBLIC_SENTRY_DSN` (web)

### 1.10 Mapbox (optional)

Skip if you're OK with OpenStreetMap as the basemap — the renderer
falls through automatically. If you want the Mapbox style:

```
Token name      : openballot-web-public
Scopes          : styles:read, fonts:read, tiles:read
URL restrictions: https://openballot.ng/*, https://*.openballot.ng/*,
                  http://localhost:3000/*
```

Capture:
- `NEXT_PUBLIC_MAPBOX_TOKEN` (starts with `pk.`)

### Checkpoint

You should now have, in a password manager:

```
NEXT_PUBLIC_SUPABASE_URL          (Phase 1.2)
NEXT_PUBLIC_SUPABASE_ANON_KEY     (Phase 1.2)
SUPABASE_SERVICE_ROLE_KEY         (Phase 1.2)
DATABASE_URL                      (Phase 1.2)
STORAGE_ENDPOINT                  (Phase 1.1)
STORAGE_BUCKET                    (Phase 1.1)
STORAGE_ACCESS_KEY                (Phase 1.1)
STORAGE_SECRET_KEY                (Phase 1.1)
TWILIO_ACCOUNT_SID                (Phase 1.4)
TWILIO_AUTH_TOKEN                 (Phase 1.4)
TWILIO_FROM                       (Phase 1.4)
GOOGLE_DOCUMENT_AI_PROJECT        (Phase 1.6)
GOOGLE_DOCUMENT_AI_PROCESSOR      (Phase 1.6)
GOOGLE_APPLICATION_CREDENTIALS_JSON (Phase 1.6)
OPENAI_API_KEY                    (Phase 1.7)
ETHEREUM_RPC_URL                  (Phase 1.8)
ETHEREUM_ANCHOR_PRIVATE_KEY       (Phase 1.8)
SENTRY_DSN                        (Phase 1.9)
NEXT_PUBLIC_SENTRY_DSN            (Phase 1.9)
NEXT_PUBLIC_MAPBOX_TOKEN          (Phase 1.10 - optional)
```

Plus the auth secrets you'll generate fresh:

```bash
# Run these on a trusted machine
openssl rand -hex 48   # → AGENT_JWT_SECRET
```

---

## Phase 2 — Provision the Hetzner host

**Goal**: a hardened Ubuntu host with Docker installed, ready to run
the compose stack.

**Time**: 30 minutes.

### Steps

1. **Create the cloud server** at https://console.hetzner.cloud:
   ```
   Image       : Ubuntu 24.04 LTS
   Type        : CCX23 (4 dedicated vCPU, 16 GB RAM, 240 GB SSD)
   Location    : Falkenstein, DE (closest to Supabase Frankfurt)
   SSH keys    : upload your team SSH keys; disable password auth
   Networking  : create a private network for future HA
   Firewall    : Hetzner Cloud Firewall - allow only:
                  port 22 from your office IP / VPN
                  ports 80 + 443 from Cloudflare IP ranges only
                  (https://www.cloudflare.com/ips-v4)
   ```

2. **SSH in and harden** (run as root, then create a sudo user):

   ```bash
   ssh root@<HETZNER_IP>
   ```

   Then:

   ```bash
   # System updates
   apt-get update && apt-get upgrade -y
   apt-get install -y ufw fail2ban unattended-upgrades curl jq

   # Create the openballot system user
   adduser --disabled-password --gecos "" openballot
   usermod -aG sudo openballot
   mkdir -p /home/openballot/.ssh
   cp /root/.ssh/authorized_keys /home/openballot/.ssh/
   chown -R openballot:openballot /home/openballot/.ssh
   chmod 700 /home/openballot/.ssh
   chmod 600 /home/openballot/.ssh/authorized_keys

   # SSH hardening
   sed -i 's/^#PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
   sed -i 's/^#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
   systemctl reload ssh

   # UFW
   ufw default deny incoming
   ufw default allow outgoing
   ufw allow from <YOUR_OFFICE_IP> to any port 22
   # Cloudflare-only on 80/443 - the actual allowlist lives in the
   # Caddyfile, but UFW gives a second layer.
   ufw allow 80
   ufw allow 443
   ufw --force enable

   # Unattended security upgrades
   dpkg-reconfigure -fnoninteractive unattended-upgrades

   # fail2ban
   systemctl enable --now fail2ban
   ```

3. **Install Docker** (as root):

   ```bash
   curl -fsSL https://get.docker.com | sh
   usermod -aG docker openballot
   systemctl enable --now docker
   ```

4. **Switch to the openballot user** for everything from here on:

   ```bash
   exit
   ssh openballot@<HETZNER_IP>
   ```

### Checkpoint

```bash
ssh openballot@<HETZNER_IP> 'docker version && ufw status verbose'
# Docker version should be 24+, UFW should show only your allowed ports.
```

---

## Phase 3 — Secrets + worker.env

**Goal**: `/etc/openballot/worker.env` contains every required env
var, with the right file permissions.

**Time**: 15 minutes.

### Steps

1. **Create the secrets directory** (as `openballot` with sudo):

   ```bash
   sudo mkdir -p /etc/openballot
   sudo chown openballot:openballot /etc/openballot
   chmod 700 /etc/openballot
   ```

2. **Create `/etc/openballot/worker.env`** by copying the template:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/vitalclick/Nigeria-Election-Results-Portal/main/.env.example \
     -o /etc/openballot/worker.env
   chmod 600 /etc/openballot/worker.env
   ```

3. **Fill in every value** from the Phase 1 password-manager list.
   Open the file with `nano` or `vim`. The structure is documented in
   `DEPLOYMENT_INFO.md` § Complete environment variable reference.

   **Critical values that must NOT be the .env.example defaults**:

   ```bash
   AGENT_JWT_SECRET=<openssl rand -hex 48 output>
   TWILIO_ENABLED=true
   ANCHOR_ENABLED=true
   ENVIRONMENT=production
   ```

4. **Verify file permissions**:

   ```bash
   ls -la /etc/openballot/worker.env
   # Expected: -rw------- 1 openballot openballot ... worker.env
   ```

   If the mode is anything other than `0600`, fix it:
   ```bash
   chmod 600 /etc/openballot/worker.env
   ```

### Checkpoint

The file exists, is owned by the `openballot` user, mode 600, and
contains real values (not the `.env.example` defaults).

```bash
# Sanity check (this prints just the variable names, not values)
grep -E '^[A-Z_]+=' /etc/openballot/worker.env | cut -d= -f1 | sort
```

You should see at least these keys present:

```
AGENT_JWT_SECRET
ANCHOR_ENABLED
DATABASE_URL
ETHEREUM_ANCHOR_PRIVATE_KEY
ETHEREUM_RPC_URL
GOOGLE_APPLICATION_CREDENTIALS_JSON
GOOGLE_DOCUMENT_AI_PROCESSOR
GOOGLE_DOCUMENT_AI_PROJECT
OPENAI_API_KEY
REDIS_URL
SENTRY_DSN
STORAGE_ACCESS_KEY
STORAGE_BUCKET
STORAGE_ENDPOINT
STORAGE_SECRET_KEY
SUPABASE_SERVICE_ROLE_KEY
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_ENABLED
TWILIO_FROM
```

---

## Phase 4 — First deploy

**Goal**: the production compose stack is running on the Hetzner host
and connected to Supabase + R2.

**Time**: 30 minutes.

### Steps

1. **Clone the repository** to `/srv/openballot`:

   ```bash
   sudo mkdir -p /srv/openballot
   sudo chown openballot:openballot /srv/openballot
   cd /srv/openballot
   git clone https://github.com/vitalclick/Nigeria-Election-Results-Portal.git .
   git checkout v0.1.0    # or the latest tag
   ```

2. **Pull the production images** from GHCR:

   ```bash
   docker compose -f infra/docker-compose.prod.yml pull
   ```

   If GHCR auth is required (private repo), authenticate first:
   ```bash
   echo $GITHUB_PAT | docker login ghcr.io -u <your-github-user> --password-stdin
   ```

3. **Apply migrations** explicitly the first time. The `migrate`
   service in compose runs them automatically on boot, but running
   manually gives you cleaner output if something is wrong:

   ```bash
   docker compose -f infra/docker-compose.prod.yml run --rm migrate
   ```

   Expected output:
   ```
   INFO:__main__:migrate.applying
   INFO:__main__:migrate.applied_n
   migrations applied: 11
   ```

   Or, if migrations were already applied (e.g. by a previous run):
   ```
   INFO:__main__:migrate.no_pending
   migrations applied: 0
   ```

4. **Bring up the full stack**:

   ```bash
   docker compose -f infra/docker-compose.prod.yml up -d
   ```

   Expected services running:
   - `worker`            FastAPI on :8000 (bound to 127.0.0.1)
   - `jobworker` ×2      background extraction consumer
   - `redis`             queue + pub/sub
   - `caddy`             reverse proxy on :80 + :443
   - `anchor`            Ethereum cron
   - `anomaly-sweep`     hourly anomaly batch
   - `recovery`          5-min crashed-worker recovery
   - (`web` optional)    Next.js — Hetzner-hosted in Shape A

5. **Tail the logs** for 60 seconds to confirm nothing is crashing:

   ```bash
   docker compose -f infra/docker-compose.prod.yml logs --tail 50
   ```

   Look for:
   - `worker.startup` from the worker service
   - `worker.ready` from each jobworker
   - `migrate.no_pending` or `migrate.applied_n`
   - No `ERROR` lines

### Checkpoint

```bash
# Health endpoint
curl -fsS http://localhost:8000/v1/health
# Expected: {"status":"ok","env":"production"}

# Audit chain genesis row should already exist
curl -fsS 'http://localhost:8000/v1/audit/verify?limit=10'
# Expected: {"ok":true,"events_checked":1,"first_broken_seq":null}
```

If either fails, see [Rollback](#rollback-procedures) before continuing.

---

## Phase 5 — Verify

**Goal**: the deploy is functioning end-to-end. Run the smoke test
that ships in the repo plus a couple of manual probes.

**Time**: 10 minutes.

### Steps

1. **Run the post-deploy smoke**:

   ```bash
   WEB_BASE=http://localhost:3000 \
   API_BASE=http://localhost:8000 \
   SKIP_OTP_CHECK=1 \
     bash scripts/post-deploy-smoke.sh
   ```

   All checks should pass. If any fail, the script tells you which.

2. **Verify the worker can reach Supabase**:

   ```bash
   docker compose -f infra/docker-compose.prod.yml exec worker \
     python -c "
   import asyncio, asyncpg, os
   async def main():
       conn = await asyncpg.connect(os.environ['DATABASE_URL'])
       print('rows in polling_units:', await conn.fetchval('SELECT count(*) FROM polling_units'))
       await conn.close()
   asyncio.run(main())
   "
   ```

3. **Verify the worker can reach R2**:

   ```bash
   docker compose -f infra/docker-compose.prod.yml exec worker \
     python -c "
   import boto3, os
   from botocore.config import Config
   c = boto3.client('s3',
       endpoint_url=os.environ['STORAGE_ENDPOINT'],
       aws_access_key_id=os.environ['STORAGE_ACCESS_KEY'],
       aws_secret_access_key=os.environ['STORAGE_SECRET_KEY'],
       region_name='auto',
       config=Config(signature_version='s3v4', s3={'addressing_style':'path'}))
   r = c.list_objects_v2(Bucket=os.environ['STORAGE_BUCKET'], MaxKeys=1)
   print('bucket reachable; KeyCount:', r.get('KeyCount', 0))
   "
   ```

4. **Verify the anchor wallet has gas**:

   ```bash
   docker compose -f infra/docker-compose.prod.yml run --rm worker \
     python -c "
   import asyncio, os
   from app.audit.ethereum_client import EthereumAnchorClient
   async def main():
       c = EthereumAnchorClient(
           rpc_url=os.environ['ETHEREUM_RPC_URL'],
           private_key=os.environ['ETHEREUM_ANCHOR_PRIVATE_KEY'])
       wei = await c.get_balance_wei()
       print(f'wallet {c.address} balance: {wei / 1e18:.4f} ETH')
   asyncio.run(main())
   "
   ```

   If the balance is under 0.1 ETH, top it up before continuing.

### Checkpoint

All four probes succeed. The post-deploy smoke exits 0.

---

## Phase 6 — Load real data

**Goal**: the polling-unit geography is loaded, state polygons are
real (not the demo bboxes), and (optionally) the 2023 IReV pilot has
run a verdict-passed report.

**Time**: 4-8 hours (most of it is the Polling-Units scraper running).

### Steps

1. **Load the polling-unit registry** by running the existing Node
   scraper:

   ```bash
   cd /srv/openballot/Polling-Units
   npm install
   node scraper.js
   # ~4 hours; produces results/<state>.json per state
   ```

   Once the scraper finishes, load the output into Postgres:

   ```bash
   docker compose -f infra/docker-compose.prod.yml exec worker \
     python /app/../scripts/load_polling_units.py \
     /srv/openballot/Polling-Units/results
   ```

   Expected: ~176,846 rows inserted.

2. **Refresh the tile-cache materialised views** so the map's
   choropleth has data:

   ```bash
   docker compose -f infra/docker-compose.prod.yml exec worker \
     python -c "
   import asyncio, asyncpg, os
   async def main():
       conn = await asyncpg.connect(os.environ['DATABASE_URL'])
       await conn.execute('SELECT refresh_tile_caches()')
       n = await conn.fetchval('SELECT count(*) FROM mv_state_centroids')
       print(f'state centroids refreshed: {n}')
       await conn.close()
   asyncio.run(main())
   "
   ```

   Should print `state centroids refreshed: 37` (36 states + FCT).

3. **Load real Nigerian state polygons**. Download an admin-boundary
   GeoJSON from OCHA HDX (https://data.humdata.org/dataset/cod-ab-nga)
   and run:

   ```bash
   docker compose -f infra/docker-compose.prod.yml exec worker \
     python /app/../scripts/load_state_polygons.py \
     /path/to/nga_admbnda_adm1.geojson
   ```

   Expected: `loaded 37 state polygons; skipped 0`

4. **Run the IReV pilot scrape** (one state, presidential only).
   Don't commit to the full multi-day scrape until the pilot's
   verdict is "ship":

   ```bash
   cd /srv/openballot/scrapers/irev-results
   npm install
   node scripts/discover-endpoints.js \
     --election presidential \
     --pu 25-11-04-007
   # Note the winning URL template; export IREV_RESULT_PATHS=... if it
   # differs from the defaults.

   node scripts/pilot.js \
     --state Lagos \
     --election presidential \
     --limit 200
   ```

   Inspect `pilot-output/pilot-report.md`. The verdict at the bottom
   should be **"ready to ship the full scrape"**. If it says
   "hold", read the issue list, fix the parser (`lib/parse.js`) for
   any unrecognised shapes captured under `fixtures/captured/`, and
   re-run.

5. **Run the full IReV scrape** (only after the pilot's verdict is
   green):

   ```bash
   nohup node scrape.js > /tmp/irev-scrape.log 2>&1 &
   tail -f /tmp/irev-scrape.log
   ```

   At conservative concurrency this takes ~3 days per ballot. Run in
   `tmux` or `screen` so you can detach.

### Checkpoint

```bash
docker compose -f infra/docker-compose.prod.yml exec worker \
  python -c "
import asyncio, asyncpg, os
async def main():
    c = await asyncpg.connect(os.environ['DATABASE_URL'])
    print('polling_units:    ', await c.fetchval('SELECT count(*) FROM polling_units'))
    print('state_boundaries: ', await c.fetchval('SELECT count(*) FROM state_boundaries'))
    print('ec8a (inec):      ', await c.fetchval(\"SELECT count(*) FROM ec8a_submissions WHERE source_type='inec_irev'\"))
    print('verified_results: ', await c.fetchval('SELECT count(*) FROM verified_results'))
    await c.close()
asyncio.run(main())
"
```

For a single-state-pilot state of completion you'd expect:

```
polling_units:     176846
state_boundaries:  37
ec8a (inec):       ~8000          (Lagos only, pilot)
verified_results:  ~8000
```

---

## Phase 7 — DNS cutover

**Goal**: `openballot.ng` and `api.openballot.ng` resolve to the
Hetzner host through Cloudflare. TLS works.

**Time**: 30 minutes including propagation.

### Steps

1. **Update the placeholder A records** in Cloudflare DNS to point at
   the Hetzner host's public IP:

   - `openballot.ng` → `<HETZNER_IP>` (Proxied)
   - `api.openballot.ng` → `<HETZNER_IP>` (Proxied)
   - `evidence.openballot.ng` → R2 public hostname (Proxied)
   - `status.openballot.ng` → `openballot.ng` CNAME (Proxied)

2. **Set Cloudflare SSL/TLS mode** to **Full (strict)** under SSL/TLS →
   Overview. Anything less is insecure and Caddy expects strict.

3. **Add the Cloudflare cache rules** under Rules → Cache Rules:

   | Match | Cache Eligibility | Edge TTL |
   |---|---|---|
   | `*openballot.ng/api/v1/tiles/*` | Eligible for cache | 60s |
   | `*openballot.ng/api/v1/elections/*/results` | Eligible | 5s |
   | `*openballot.ng/api/v1/audit/hashes*` | Eligible | 1h |
   | `evidence.openballot.ng/*` | Eligible | 1d |

4. **Wait for TLS provisioning**. Caddy obtains certs from Let's
   Encrypt automatically on first request to the new hostname. May
   take up to 60 seconds. Watch Caddy logs:

   ```bash
   docker compose -f infra/docker-compose.prod.yml logs caddy --tail 50 -f
   ```

   Look for `certificate obtained successfully` for `api.openballot.ng`.

### Checkpoint

```bash
# TLS cert chain valid?
echo | openssl s_client -servername api.openballot.ng \
  -connect api.openballot.ng:443 2>/dev/null \
  | openssl x509 -noout -dates -issuer

# Worker health through the public hostname?
curl -fsS https://api.openballot.ng/v1/health

# Smoke run against production URLs
WEB_BASE=https://openballot.ng API_BASE=https://api.openballot.ng \
  SKIP_OTP_CHECK=1 bash scripts/post-deploy-smoke.sh
```

All checks pass.

---

## Phase 8 — Pre-election switch (T-30 days)

**Goal**: move the web layer from Hetzner-self-hosted to Vercel for
the election cycle, upgrade Cloudflare to Pro for WAF + image-resize,
tighten the anchor cron cadence.

**Time**: 2 hours.

### Steps

1. **Provision the Vercel project**:

   - Sign in at https://vercel.com with the team GitHub account
   - New project → import `vitalclick/Nigeria-Election-Results-Portal`
   - Framework preset: **Next.js** (auto-detected)
   - Root directory: `web/`
   - Environment variables: set every `NEXT_PUBLIC_*` from your
     password manager, plus `SUPABASE_SERVICE_ROLE_KEY` (server-side
     only, mark it as such)
   - Add custom domain: `openballot.ng` (Vercel issues + renews the
     cert automatically)

2. **Move the apex DNS** in Cloudflare from the Hetzner IP to Vercel's
   anycast IP:

   - `openballot.ng` → Vercel CNAME target (Proxied OFF — Vercel
     handles its own edge)

   Leave `api.openballot.ng` pointing at Hetzner. Only the public
   read site moves; the worker stays.

3. **Stop the web service on Hetzner** (we keep the worker stack
   running; the web container is no longer the public surface):

   ```bash
   docker compose -f infra/docker-compose.prod.yml --profile self-hosted-web \
     stop web
   docker compose -f infra/docker-compose.prod.yml --profile self-hosted-web \
     rm -f web
   ```

   (The `self-hosted-web` profile means the web service does not auto-
   start, so the next `up -d` won't bring it back.)

4. **Upgrade Cloudflare to Pro** ($20/mo) under your account → Plans.
   New capabilities you'll use:
   - WAF custom rules (write a block rule for known bad agents)
   - Image Resizing
   - Higher rate limit threshold (Free is 10k req/10min; Pro is 1M)

5. **Tighten the anchor cron cadence** during the election window.
   Update `worker.env` on the Hetzner host:

   ```bash
   sudo sed -i 's/^ANCHOR_BATCH_INTERVAL_SECONDS=.*/ANCHOR_BATCH_INTERVAL_SECONDS=600/' \
     /etc/openballot/worker.env
   docker compose -f infra/docker-compose.prod.yml restart anchor
   ```

   30 min → 10 min during the election cycle. Returns to 30 min at
   Phase 10.

6. **Reduce DNS TTLs** in Cloudflare to 60 seconds for fast failover:

   - `openballot.ng`, `api.openballot.ng`, `evidence.openballot.ng`:
     TTL = Auto (Cloudflare picks an aggressive value when Proxied;
     unproxy to set explicit 60s if needed)

### Checkpoint

```bash
# Web served from Vercel now
curl -fsSI https://openballot.ng | grep -i 'server:'
# Expected: server: Vercel

# Worker still on Hetzner via Cloudflare
curl -fsSI https://api.openballot.ng/v1/health | grep -i 'server:'
# Expected: server: cloudflare

# Anchor is now on the 10-min cadence
docker compose -f infra/docker-compose.prod.yml exec anchor \
  cat /proc/1/cmdline | tr '\0' ' '
# Should include sleep 600
```

---

## Phase 9 — Election day operations

**Goal**: the platform stays up and produces accurate signals through
the election + collation window. This phase is people, not commands.

**Time**: 24-72 hours of operational watch.

### Pre-flight (T-24h)

- [ ] Schema migration freeze: no PRs land that change `db/migrations/`
- [ ] Hetzner snapshots: take a snapshot of the worker host (Hetzner
      console → Snapshots → Create)
- [ ] Supabase point-in-time recovery: verified working in
      Settings → Database
- [ ] Anchor wallet: 1.0+ ETH balance verified via the probe in Phase 5
- [ ] On-call rota: published to the consortium Slack with primary +
      secondary contact per 4-hour window
- [ ] Page setup: PagerDuty / Opsgenie wired to Sentry's alert webhook
- [ ] Translations: HA / YO / IG / PCM landing copy reviewed by native
      speakers within the last 7 days
- [ ] Status page: `https://status.openballot.ng` showing all green

### Election morning (T-0)

Open four browser tabs and leave them on the same monitor:

| Tab | URL | Watch for |
|---|---|---|
| Public map | `https://openballot.ng/en/map` | Map renders; tiles refresh |
| Grafana | `https://grafana.openballot.ng/d/elections` | Queue depth, ingestion rate |
| Sentry | `https://sentry.io/...` | New error groups |
| Anchor wallet | `https://etherscan.io/address/<addr>` | Each anchor TX confirms |

### Live operational decisions during the day

| Signal | Decision |
|---|---|
| Queue depth > 5 minutes' backlog | Scale `jobworker` replicas: `docker compose -f infra/docker-compose.prod.yml up -d --scale jobworker=8` |
| Ingestion error rate > 1% | Check Sentry for the recurring exception; if it's a known transient (Twilio 503, OpenAI rate limit), let retry handle it |
| Specific PU triggering `inec_conflict` | Surface to consortium press lead immediately; do NOT comment publicly until 2 independent sources have corroborated |
| Cloudflare DDoS in progress | Enable "I'm Under Attack" mode at the zone level (Security → Settings) |
| Anchor TX failing repeatedly | Check `ANCHOR_MAX_GAS_GWEI`; if Ethereum is genuinely congested, accept the temporary delay - the SQL chain stays valid |

### Pages that should NEVER trigger during the election

If any of these fire, page everyone:

- `worker /v1/health` returns non-200
- `audit chain` verifier returns `ok: false` for any election
- Sentry receives any `submission.audit_chain_broken` event
- Cloudflare reports the origin (Hetzner) as offline for > 5 minutes

### Post-poll (T+12 to T+72h)

- Collation continues; party agents may keep submitting late EC8As
- Discrepancy register grows as INEC IReV uploads land
- Reviewer queue staffing: 2 consortium reviewers per 4-hour shift,
  rotating

---

## Phase 10 — Post-election archive

**Goal**: the audit dataset is published, costs scale back down, the
operational footprint returns to steady-state.

**Time**: 1-2 days.

### Steps

1. **Publish the audit dataset** (the headline deliverable for the
   platform's transparency claim):

   ```bash
   # Generate the manifest CSV
   curl -fsS 'https://openballot.ng/api/v1/audit/hashes?election_id=2027-presidential' \
     > /tmp/openballot-2027-presidential-hashes.csv

   # Upload to a permanent public location (R2 bucket folder, or GitHub
   # release asset). The download URL goes into the consortium's public
   # statement.
   ```

2. **Tag a post-election release**:

   ```bash
   git tag -a "post-2027-presidential" -m "Audit dataset published"
   git push origin "post-2027-presidential"
   ```

3. **Return cost knobs to steady-state**:

   ```bash
   sudo sed -i 's/^ANCHOR_BATCH_INTERVAL_SECONDS=.*/ANCHOR_BATCH_INTERVAL_SECONDS=1800/' \
     /etc/openballot/worker.env
   docker compose -f infra/docker-compose.prod.yml restart anchor
   ```

4. **Downgrade Cloudflare to Free** (saves $20/mo until next election cycle).

5. **Move the web back to Hetzner** (saves Vercel Pro spend during
   the off-cycle period):

   ```bash
   # On the Hetzner host
   cd /srv/openballot
   docker compose -f infra/docker-compose.prod.yml --profile self-hosted-web \
     up -d web
   ```

   Then in Cloudflare, point `openballot.ng` back at the Hetzner IP
   (Proxied ON).

6. **Decommission excess worker capacity**:

   ```bash
   docker compose -f infra/docker-compose.prod.yml up -d --scale jobworker=2
   ```

### Checkpoint

```bash
# Off-cycle cost profile - should be ~$200/mo total now
# Verify via Hetzner + Supabase + R2 dashboards.
```

The platform is now in steady-state until the next election cycle.
The historical data + audit chain remain queryable; the public API
remains live.

---

## Rollback procedures

For each phase, the safest rollback path:

| Phase | If it goes wrong | Action |
|---|---|---|
| 0 (DNS) | Nameservers wrong at registrar | Revert at the registrar; wait for propagation |
| 1 (services) | Wrong region for Supabase / R2 | Recreate in the correct region BEFORE you load data; deleting is cheap pre-data |
| 2 (Hetzner) | Hardening locked you out | Hetzner console → Rescue mode; mount the disk; fix `/etc/ssh/sshd_config` |
| 3 (secrets) | Wrong values | Edit `/etc/openballot/worker.env`, `docker compose restart` |
| 4 (first deploy) | Migrations fail | Read `migrate` logs; the failure message names the migration file. Fix the migration or roll back the version |
| 5 (verify) | Probe fails | Each probe tests one boundary; fix that one without redoing earlier phases |
| 6 (data load) | Wrong polygons / scrape produces bad rows | `TRUNCATE` the affected table; re-load. The scraper is idempotent. |
| 7 (DNS cutover) | TLS not issuing | Wait 60s; check Caddy logs for the LE challenge attempt; verify CF Proxy is on |
| 8 (Vercel switch) | Vercel deploy failing | Leave DNS pointed at Hetzner; the self-hosted-web profile stays warm |
| 9 (election day) | Worker crashes | Hetzner snapshot restore (RTO 15 min); the recovery cron rehydrates stuck submissions |
| 10 (archive) | Manifest CSV truncated | Re-run the curl; the underlying audit_log is append-only and immutable |

For broader disaster scenarios — Hetzner host loss, Supabase
corruption, R2 outage — see `DEPLOYMENT_INFO.md` § Disaster recovery.

---

## Common gotchas

These have bitten previous deployments. Calling them out so you can
skip the time.

### 1. Cloudflare R2 SHA-256 header rejection

If presigned uploads fail with `XAmzContentSha256Mismatch`, the
PWA's `x-amz-checksum-sha256` header isn't reaching R2. Cloudflare
strips some headers by default; check Rules → Transform Rules and
ensure no rule is removing `x-amz-*`.

### 2. Supabase pooler vs. direct connection

Use the **session pooler** (port 5432) for `DATABASE_URL`, not the
transaction pooler. asyncpg uses prepared statements which the
transaction pooler doesn't support.

### 3. Caddy + Cloudflare strict mode

If Caddy fails to obtain a certificate, the most likely cause is
Cloudflare SSL mode set to "Flexible" instead of "Full (strict)".
Flexible re-encrypts at the Cloudflare edge with a self-signed cert
which fails Caddy's TLS validation. Use Full (strict) only.

### 4. Document AI region mismatch

If you provisioned the Document AI processor in `eu` but
`GOOGLE_DOCUMENT_AI_LOCATION` is set to `us` (or unset), every
extraction fails with a 404 on the processor URL. The location is in
the processor's full resource name; set it explicitly.

### 5. WhatsApp Business sender not approved

If WhatsApp messages fail with `21211` "From is not a valid WhatsApp
business sender", Meta hasn't approved your template yet. The Twilio
adapter falls back to SMS, but during the approval window you should
set `WHATSAPP_FROM` to empty so the factory returns SMS-only and
avoids the per-message error logs.

### 6. Ethereum anchor stuck at "pending"

If `audit_anchors.status` rows stay `pending` for more than an hour,
the gas-price ceiling is being hit. Check the actual gas price (e.g.
on Etherscan); if the network is genuinely congested, accept the
delay. The SQL audit chain remains valid; the on-chain witness is
just deferred.

### 7. Migration order

Migrations apply in **filename order**, not in git commit order. If
you create migrations out of order (e.g. branch off and merge later),
the auto-migrator may apply them in a way the application code does
not expect. Always number new migrations against the latest applied
version.

### 8. Hetzner Cloud firewall vs. UFW

Both layers are active. If your office IP gets blocked from SSH:
   - Hetzner Cloud console → Firewalls (modify the allowed IP)
   - SSH in, modify UFW (`ufw allow from <ip> to any port 22`)

Don't disable UFW just because the Hetzner firewall is in place. The
two-layer defence catches the case where the Hetzner firewall is
misconfigured.

### 9. Auto-migrator advisory lock contention

If two worker hosts boot simultaneously and both try to migrate, the
second blocks on `pg_advisory_lock(5101883)` until the first
finishes. This is correct behaviour, but if a previous migrate run
crashed without releasing the lock, the second hangs forever.
Manually release:

```sql
SELECT pg_advisory_unlock_all();  -- in a Postgres shell
```

### 10. Cloudflare cache returning stale tiles after an admin decision

A reviewer approves a submission; the consensus on a PU changes; the
public map shows the old colour for up to the edge TTL (60s by
default). This is intentional. If you need a faster invalidation,
add a `Cache-Tag` header to the tile response and purge by tag from
the Cloudflare dashboard. Day-to-day operations don't need this.

---

## Where to go from here

- For ad-hoc service questions: `DEPLOYMENT_INFO.md`
- For "why is the schema this shape": `docs/DATA_MODEL.md`
- For "is this safe": `docs/SECURITY.md` + `docs/THREAT_MODEL.md`
- For the post-launch roadmap: `docs/ROADMAP.md`
- For incident handling: `docs/RUNBOOK.md` (consortium draft)

If you got this far and the platform is live: **publish the audit
dataset address** so the public knows where to verify. That is the
single most important thing the project does, and it is the moment
the design becomes real.

---

*The form is the truth. The truth is public.*
