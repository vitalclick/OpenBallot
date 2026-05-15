# Threat model

This document is what an external security auditor expects on a
platform of this kind. It enumerates the actors who might attack
OpenBallot Nigeria, the assets they would target, the realistic attack
paths, and the controls in place. It is updated whenever the
architecture changes; the current version corresponds to commit on
which the file lives.

## Assets ranked by sensitivity

| Rank | Asset | If lost / corrupted |
|---|---|---|
| 1 | Audit chain integrity | The platform's central trust claim collapses |
| 2 | EC8A image archive | Evidence of every result; the canonical record |
| 3 | Agent + observer PII | Phone numbers, names; NDPA-protected |
| 4 | Verified results data | Public-facing claims about election outcomes |
| 5 | Service availability | Tribunals and journalists rely on it during disputes |

## Adversaries

### A1 — A party operative
**Goal**: inflate own party's tally or suppress rival's tally.
**Capability**: an issued JWT; a phone with the PWA installed.

### A2 — A coordinated party (sybil)
**Goal**: same as A1, but at scale across many PUs.
**Capability**: control over multiple agent accounts.

### A3 — A platform insider
**Goal**: quietly edit historical results post-declaration.
**Capability**: database write access.

### A4 — A DDoS actor
**Goal**: take the platform offline at the moment of declaration to
break the public ability to compare INEC's upload against the
audit-anchored consensus.
**Capability**: rented attack infrastructure.

### A5 — A network adversary
**Goal**: intercept or modify submissions in transit.
**Capability**: AS-level routing influence; rogue mobile-network
operator.

### A6 — An OCR confuser
**Goal**: submit a doctored image that reads as a valid EC8A but
encodes false numbers.
**Capability**: ability to produce a doctored image; an issued JWT.

### A7 — A credential stuffer
**Goal**: hijack agent accounts.
**Capability**: phishing infrastructure; access to leaked credential
dumps.

### A8 — A misinformation actor
**Goal**: claim the platform has been compromised even when it hasn't.
**Capability**: social-media reach.

## Attack paths and controls

| Path | Adversary | Controls |
|---|---|---|
| Submit fake EC8A for own party's PU | A1 | Geofence (GPS must match registered PU); SHA-256 bound at upload; multi-source consensus (a fake submission shows as `single_source` until other sources corroborate or contradict) |
| Submit fake EC8As across many PUs | A2 | Same as A1 + per-party uniqueness constraint (`uq_party_submission_per_pu`); a party can only have one submission per PU; collusion across parties is detected by the multi-source consensus algorithm |
| Quietly rewrite verified_results | A3 | SQL trigger chains audit_log; Merkle root anchored to Ethereum mainnet every 30 min. Any rewrite breaks the chain at the point of tampering and is externally verifiable. |
| Delete an EC8A image | A3 | R2 object versioning enabled; Supabase Storage mirror as secondary; SHA-256 manifest published, so re-uploading bytes that don't hash to the manifest value is detectable. |
| Saturate /v1/ingest with submissions | A4 | Cloudflare DDoS protection; per-agent rate limit at the auth boundary; OTP + IP rate limits prevent the submission-step volume from exceeding the OTP-step volume |
| MITM the agent->R2 upload | A5 | TLS to R2; SHA-256 hash bound to the presigned URL — bytes that don't match are rejected by storage |
| Inject doctored EC8A image | A6 | AI confidence floor (low-confidence -> review queue); arithmetic consistency checks; multi-source consensus across independent agents; image is publicly visible so reviewers + the public can compare against the form's content |
| Phish an agent for OTP | A7 | OTP is single-use, 5-minute TTL, attempts limited; device binding means a stolen OTP from a different device is rejected at verify-otp; phone OTP delivered via SMS or WhatsApp registered to the agent's phone, not email |
| Claim the platform was hacked | A8 | Every claim of corruption is independently testable: download the audit dataset, run scripts/verify_audit_chain.py, check the Ethereum TX hashes. The witness layer is not us. |

## Controls in detail

### Audit chain integrity
- `db/migrations/0002_audit_chain.sql` — BEFORE INSERT trigger
- ADR-0003 — design rationale
- `worker/app/audit/chain.py` — Python verifier
- `scripts/verify_audit_chain.py` — standalone, zero-dependency verifier
- Ethereum anchor (ADR-0004) — external witness

### Identity + access
- Phone OTP (5-min TTL, attempts capped, SHA-256-hashed at rest with per-row salt)
- JWT (HS256, 24h TTL, device-fingerprint-bound — ADR-0010)
- Twilio + WhatsApp adapters; auditable SMS log per agent
- RLS on every operational table; service-role key never client-side
- `auth_events` table; every OTP + login attempt logged

### Upload + storage integrity
- Presigned PUT URLs with size + content-type + SHA-256 binding
- R2 versioning + Supabase Storage mirror for redundancy
- Hash manifest published per election
- ADR-0006 — design rationale

### Observability
- Sentry on every unhandled exception (worker + web)
- Prometheus metrics on ingestion / extraction / auth / anchor / anomaly
- Structlog JSON output
- `/status` public dashboard surfaces operational health

### Compliance
- NDPA 2023 — PII residency in Frankfurt / accessed only via service role
- Data retention: agent PII purged one cycle after election; PII never exposed in public payloads
- AGPL-3.0 prevents closed redeployment

## Out of scope

- **Pre-election misinformation about the platform**: outside our
  controls. Mitigated by transparency: the audit dataset and the
  Ethereum anchor make corruption claims independently testable.
- **State-level adversaries with infrastructure access at Cloudflare /
  Supabase / Hetzner**: these are providers' security posture. We
  trust them at the level any major infrastructure user does.
- **Hardware compromise of an agent's phone**: a phone with
  rootkit-level malware can compromise an agent's submissions. Not
  defendable from our side; mitigated by multi-source consensus
  (one corrupted agent does not move a PU into `consensus`).

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md). Email
**security@openballot.ng**.
