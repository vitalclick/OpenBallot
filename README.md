# OpenBallot Nigeria

> **Transparent. Verifiable. Irreversible.**
> Nigeria's first open, multi-source, document-first election results platform - powered by Form EC8A, built by civil society, accountable to the public.

---

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Languages](https://img.shields.io/badge/Languages-EN%20%7C%20HA%20%7C%20YO%20%7C%20IG%20%7C%20PCM-green.svg)]()
[![Elections Supported](https://img.shields.io/badge/Elections-LGA%20→%20Presidential-orange.svg)]()
[![Audit Trail](https://img.shields.io/badge/Audit%20Trail-Level%20C%20%7C%20Blockchain--Anchored-purple.svg)]()
[![Status](https://img.shields.io/badge/Status-Pre--Launch%20%7C%20Building%20for%202027-red.svg)]()

---

## Table of Contents

1. [What is OpenBallot Nigeria?](#what-is-openballot-nigeria)
2. [The Problem We Are Solving](#the-problem-we-are-solving)
3. [How It Works](#how-it-works)
4. [Why OpenBallot Is Different](#why-openballot-is-different)
5. [Platform Architecture](#platform-architecture)
6. [The EC8A Pipeline](#the-ec8a-pipeline)
7. [Multi-Source Verification Engine](#multi-source-verification-engine)
8. [Discrepancy Detection & Escalation](#discrepancy-detection--escalation)
9. [The Audit Trail - Level C](#the-audit-trail--level-c)
10. [Election Types Supported](#election-types-supported)
11. [Interactive Results Map](#interactive-results-map)
12. [Agent & Observer Onboarding](#agent--observer-onboarding)
13. [Multi-Language Support](#multi-language-support)
14. [Public API & Media Embed](#public-api--media-embed)
15. [Historical Data Layer](#historical-data-layer)
16. [Tech Stack](#tech-stack)
17. [Data Model Overview](#data-model-overview)
18. [Security Architecture](#security-architecture)
19. [Governance](#governance)
20. [Funding & Partners](#funding--partners)
21. [Roadmap](#roadmap)
22. [Contributing](#contributing)
23. [License](#license)

---

## What is OpenBallot Nigeria?

**OpenBallot Nigeria** is an open-source, civic technology platform that enables the real-time collection, verification, and public display of Nigerian election results - directly from Form EC8A, the legally binding result sheet signed by the Presiding Officer and all party agents at every polling unit.

It is owned and governed by a consortium of civil society organisations (CSOs), open to all INEC-registered political parties and accredited election observers, and free for any citizen to access.

OpenBallot does not compete with INEC. It runs **in parallel** - providing an independent, multi-source, document-anchored view of results that can be publicly compared to the official INEC IReV portal the moment INEC uploads its own EC8A scans.

**Built for the 2027 Nigerian General Elections - and every election after.**

---

## The Problem We Are Solving

In the 2023 Nigerian Presidential Election, the INEC Result Viewing portal (IReV) - designed to show real-time polling unit results - experienced failures that prevented timely uploads of presidential election results. The fundamental question of whether the results declared matched the forms signed at polling units was never fully resolved in the public mind. Trust collapsed. Litigation followed.

The structural problem was not merely technical. It was architectural: **a single official source, under pressure, with no independent verification layer.**

OpenBallot solves this by design:

- **No single source of truth.** Multiple independent parties and observers upload EC8A simultaneously. Results emerge from consensus, not from a single upload.
- **No manually entered numbers.** The form itself is the data. Nobody types tallies into OpenBallot. The physical signed document is photographed, uploaded, and read by AI - eliminating the manipulation surface entirely.
- **No closed system.** Every document, every extracted figure, every reconciliation decision, and every discrepancy is visible to the public and downloadable as open data.
- **No black box.** The entire evidentiary chain - who submitted what, when, from where, what the AI extracted, and what the verification engine decided - is published as a permanent open dataset after every election.

---

## How It Works

```
Election Day
     │
     ├── Party Agents at Polling Unit
     │       └── Photograph signed EC8A
     │           → Upload via OpenBallot PWA (offline-capable)
     │               → GPS-tagged, timestamped, agent-credentialed
     │
     ├── Accredited Election Observers
     │       └── Same upload flow, independent credential
     │
     └── INEC IReV (official channel, monitored separately)
             └── OpenBallot ingests IREV uploads for cross-reference

                          ↓

              Document Ingestion Service
          (quality check, form classification,
           geolocation validation, tamper detection)

                          ↓

              AI Extraction Engine
          (Google Document AI + GPT-4o Vision)
          Extracts: candidate votes, PU code,
          signatures, stamp, arithmetic consistency

                          ↓

         Multi-Source Verification Engine
         (consensus across party + observer submissions)

                          ↓

    ┌─────────────────────────────────────────┐
    │         Public Results Map              │
    │  Real-time · Ward → State → National   │
    │  EC8A image always visible              │
    │  Discrepancy page for flagged units     │
    │  Public API · Embeddable widget         │
    └─────────────────────────────────────────┘

                          ↓

        Immutable Audit Log
  (SHA-256 hashes + blockchain-anchored)
  Full evidentiary chain published as open dataset
```

---

## Why OpenBallot Is Different

| Feature | IEC South Africa Dashboard | OpenBallot Nigeria |
|---|---|---|
| **Data source** | Single official source | Multi-source: parties + observers + INEC |
| **What is displayed** | Numbers only | EC8A source document always visible |
| **Discrepancy detection** | None | Active reconciliation engine with public page |
| **Numbers origin** | Official aggregate | AI-extracted from signed physical form |
| **Audit trail** | None | SHA-256 hashes + blockchain-anchored, full log published |
| **API access** | None | Open REST API + embeddable widget |
| **Languages** | English only | English, Hausa, Yoruba, Igbo, Nigerian Pidgin |
| **Agent accountability** | N/A | Full identity chain per submission |
| **Historical data** | Yes (2004–present) | Yes - from 2023 forward, expanding |
| **Between elections** | Static archive | Live platform, always auditable |
| **Legal document basis** | No | Yes - EC8A is primary legal evidence |
| **Open source** | No | Yes - fully open, community auditable |

---

## Platform Architecture

OpenBallot is composed of six core services, each independently deployable:

```
┌──────────────────────────────────────────────────────────┐
│                    OpenBallot Nigeria                     │
│                                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │  Agent PWA  │  │ Party Admin │  │  Observer Portal│  │
│  │(Mobile-first│  │   Portal    │  │                 │  │
│  │offline-cap.)│  │             │  │                 │  │
│  └──────┬──────┘  └──────┬──────┘  └────────┬────────┘  │
│         └────────────────┼──────────────────┘           │
│                          ↓                              │
│             ┌────────────────────────┐                  │
│             │   Ingestion Service    │                  │
│             │  (validation, geo,     │                  │
│             │   quality, tamper)     │                  │
│             └────────────┬───────────┘                  │
│                          ↓                              │
│             ┌────────────────────────┐                  │
│             │   AI Extraction Engine │                  │
│             │  (Document AI + GPT-4o)│                  │
│             └────────────┬───────────┘                  │
│                          ↓                              │
│  ┌───────────────────────────────────────────────────┐  │
│  │              Supabase (PostGIS + Realtime)        │  │
│  │  polling_units · ec8a_submissions · verified_     │  │
│  │  results · discrepancies · audit_log              │  │
│  └───────────────────────┬───────────────────────────┘  │
│                          ↓                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │  Public Map │  │  Public API │  │ Discrepancy Page│  │
│  │  Dashboard  │  │  + Embeds   │  │                 │  │
│  └─────────────┘  └─────────────┘  └─────────────────┘  │
│                          ↓                              │
│             ┌────────────────────────┐                  │
│             │   Audit Trail Service  │                  │
│             │  (SHA-256 + blockchain │                  │
│             │   + open dataset pub.) │                  │
│             └────────────────────────┘                  │
└──────────────────────────────────────────────────────────┘
```

---

## The EC8A Pipeline

Form EC8A is the **legally binding result sheet** signed by the Presiding Officer and all party agents at every polling unit in Nigeria. It is the primary evidence document in every election tribunal and Supreme Court case involving disputed results. OpenBallot makes it the foundation - not a supplement - of the results record.

### Submission Flow

1. **Agent photographs EC8A** at the polling unit using the OpenBallot PWA
2. **GPS coordinates are locked** at the moment of capture - stored in image metadata
3. **Submission is queued** - the app works fully offline; uploads automatically when connectivity resumes
4. **Ingestion Service receives the image** and runs:
   - Blur and lighting quality check
   - Whole-form visibility check (no cutoff edges)
   - Form classification - confirms this is EC8A, not another INEC form
   - Duplicate detection - has this polling unit code already been submitted by this party?
   - Geolocation validation - GPS coordinates must fall within 100 metres of the polling unit's registered location (flagged, not hard-blocked, to account for GPS drift)
   - EXIF metadata integrity check - flags if metadata has been stripped or altered
5. **AI Extraction Engine** processes the image:
   - Google Document AI (primary) extracts structured fields
   - GPT-4o Vision (secondary) verifies low-confidence extractions
   - Extracts: Polling Unit Code, Candidate Names + Vote Tallies, Total Registered Voters, Total Accredited Voters, Total Valid Votes, Rejected Ballots, Total Votes Cast
   - Detects: Presiding Officer signature, Party Agent signatures, Official stamp
   - Runs arithmetic consistency check: `sum(candidate votes) == Total Valid Votes`
   - Assigns a **confidence score** to each field
6. **Human Review Queue** - any extraction below confidence threshold is routed to a human reviewer before publication
7. **Structured result object** written to database
8. **Verification Engine** cross-references with other party submissions for the same polling unit

### What Is Always Published Alongside Numbers

Every result displayed on OpenBallot - no matter how high the confidence score - is accompanied by:
- The actual EC8A photograph submitted
- The name and credential type of the submitting agent/observer
- The confidence score of each extracted field
- The timestamp and GPS coordinates of the submission
- The names of all signatures detected on the form

**You never see a number without seeing the document it came from.**

---

## Multi-Source Verification Engine

When multiple parties and observers submit EC8A for the same polling unit, the Verification Engine computes a consensus status:

| Status | Condition | Map Colour |
|---|---|---|
| **No Data** | No submissions yet | ⬜ White |
| **Unverified - Single Source** | Only one party/observer has submitted | 🟡 Yellow |
| **Consensus** | Multiple independent sources agree on figures | 🟢 Green |
| **Discrepancy Detected** | Submissions exist but figures differ | 🟠 Orange |
| **INEC Confirmed** | INEC IReV upload matches consensus | 🔵 Blue |
| **INEC Conflict** | INEC IReV figures differ from multi-source consensus | 🔴 Red |

The **Red state** - where INEC's official upload conflicts with independent multi-source consensus - is the most powerful accountability signal the platform produces. It is publicly visible, permanently recorded, and immediately escalated.

---

## Discrepancy Detection & Escalation

### Public Discrepancy Page

OpenBallot maintains a permanently visible, real-time **Discrepancy Register** on the public dashboard. Every polling unit in a discrepancy state is listed with:
- Both (or all) EC8A images displayed side by side
- The specific fields that differ, highlighted
- The submitting party/observer for each version
- The timestamp difference between submissions
- The arithmetic consistency status of each form
- The GPS coordinates of each submission

This page is not hidden, not minimised, and not post-election. It is live, during the election, for every citizen to see.

### Escalation Protocol

| Trigger | Action |
|---|---|
| Discrepancy detected (any source) | Logged to Discrepancy Register immediately |
| Discrepancy persists > 2 hours | Automated notification to registered party legal contacts |
| INEC IReV conflicts with consensus | Escalation flag raised; notification sent to INEC official contact, accredited observer bodies, and registered CSO partners |
| Statistical anomaly detected (votes > registered voters, extreme outlier vs. historical pattern) | Separate "Statistical Alert" flag, publicly visible |

OpenBallot does not adjudicate. It presents the evidence and escalates to the appropriate authorities. The platform is a transparency tool, not a tribunal.

---

## The Audit Trail - Level C

OpenBallot implements the highest level of evidentiary accountability:

### Level C Audit Trail

**1. Cryptographic Image Hashing**
Every EC8A image uploaded to OpenBallot is immediately hashed using SHA-256. The hash is stored in the database and published in a publicly downloadable manifest file. This means anyone - today, or ten years from now - can verify that the EC8A image OpenBallot displays is byte-for-byte identical to what was submitted on election day. Any alteration changes the hash.

**2. Blockchain Anchoring**
Batches of hashes (every 30 minutes during active elections) are anchored to the Ethereum mainnet via an OP_RETURN transaction. This creates a permanent, third-party-verifiable record that the batch of hashes existed at that point in time - without any dependence on OpenBallot's own infrastructure.

**3. Full Evidentiary Chain Publication**
After each election concludes, OpenBallot publishes the complete evidentiary dataset as open data:
- Every EC8A image (or its hash + reference URL)
- Every extracted result object with per-field confidence scores
- Every verification engine decision and the inputs that produced it
- Every discrepancy record with both source documents
- Every escalation event and its timestamp
- The complete agent submission log (anonymised to credential type, not personal identity)

This dataset is released under a Creative Commons Attribution licence. Any researcher, journalist, political party, or citizen can download and independently audit the entire election result record.

**4. Tamper-Evidence for OpenBallot Itself**
The full audit log is append-only. No record can be deleted or altered - only flagged. Any attempt to modify historical records is detectable via hash chain verification. This protects against the "insider threat" scenario - even someone with database access cannot rewrite history without detection.

---

## Election Types Supported

OpenBallot supports all INEC election types, with the same EC8A-based pipeline applied at the polling unit level for each:

| Election Type | Scope | Polling Units |
|---|---|---|
| **Presidential** | National | 176,846 |
| **Senate** | 109 Senatorial Districts | Per district |
| **House of Representatives** | 360 Federal Constituencies | Per constituency |
| **Governorship** | 36 States | Per state |
| **State House of Assembly** | ~993 State Constituencies | Per constituency |
| **FCT Area Council** | 6 Area Councils | Per council |
| **LGA Chairmanship & Councillorship** | 774 LGAs | Per LGA |

On days when multiple elections run concurrently (as in a general election), OpenBallot handles simultaneous result streams for each election type from the same polling unit, since agents submit one EC8A per election type.

Party agents and observers select the election type at the point of submission. The system validates the form content against the expected election type before accepting it.

---

## Interactive Results Map

The public-facing map is the primary interface for citizens, journalists, and observers.

### Map Layers

- **National view** - choropleth by state, showing lead party and completion percentage
- **State view** - choropleth by LGA
- **LGA view** - choropleth by Ward
- **Ward view** - individual polling unit dots, colour-coded by verification status
- **Polling Unit detail** - full result card with EC8A image, extracted figures, all submissions, reconciliation status

### Controls

- Election type selector (Presidential / Senate / Reps / Gov / STHA / LGA)
- Party filter (highlight a party's performance across the map)
- Status filter (show only Green / Orange / Red units)
- Search by polling unit code, ward name, LGA, or state
- Historical comparison toggle (compare live results to 2023 at the same unit)

### Live Counters (Header Bar)

```
Polling Units Reporting: 12,847 / 176,846 (7.3%)
Consensus Reached: 9,204   Discrepancies: 143   INEC Confirmed: 6,891
Last updated: 14 seconds ago
```

### Embeddable Widget

Any media organisation, journalist, or civil society website can embed the OpenBallot live map with a single line of HTML:

```html
<iframe src="https://openballot.ng/embed/map?election=presidential&state=lagos"
        width="100%" height="600" frameborder="0"></iframe>
```

Customisable parameters: election type, geographic scope, colour scheme, language.

---

## Agent & Observer Onboarding

### Design Principle

OpenBallot is designed to be accessible to any Nigerian who can use a smartphone. No app installation required. No technical knowledge required. The entire agent experience is a mobile-optimised Progressive Web App (PWA) accessed via a URL.

### Party Onboarding Flow

1. Party applies to OpenBallot consortium (any INEC-registered party is eligible - no exclusions)
2. Consortium verifies INEC registration status
3. Party receives access to the **Party Admin Portal**
4. Party uploads agent roster (CSV: agent name, phone number, assigned polling unit code)
5. System sends each agent a WhatsApp/SMS OTP with their login link
6. Agent accesses PWA, completes a 3-minute interactive walkthrough
7. Agent is assigned to exactly one polling unit

### Observer Onboarding Flow

Accredited election observers (domestic and international) can register independently:
1. Observer submits accreditation credential (INEC observer ID)
2. Verified by consortium team
3. Observer can submit EC8A for any polling unit they are deployed to (not locked to a single unit, since observers may cover multiple units)
4. Observer submissions are labelled separately from party agent submissions in the public record

### The Agent App - Core UX Flow

The agent app has exactly four screens:

```
Screen 1: Login (phone number + OTP)
Screen 2: Your polling unit details (pre-loaded, read-only)
Screen 3: Take photo of EC8A (camera opens directly)
Screen 4: Confirm & submit (shows GPS status, queues if offline)
```

That is the entire flow. Four screens, no forms to fill, no numbers to type.

---

## Multi-Language Support

The full platform - agent PWA, public dashboard, party admin portal, and all system notifications - is available in:

| Language | Code | Region Coverage |
|---|---|---|
| English | `en` | National |
| Hausa | `ha` | North West, North East, North Central |
| Yoruba | `yo` | South West |
| Igbo | `ig` | South East |
| Nigerian Pidgin | `pcm` | Cross-regional, youth-accessible |

Language is auto-detected from device settings and manually switchable at any time. All OCR extraction and AI processing is language-agnostic (operates on form structure and numbers, not text language).

SMS and WhatsApp notifications to agents are sent in the agent's selected language.

---

## Public API & Media Embed

OpenBallot exposes a fully open REST API. No authentication required for read access. Rate limits apply to prevent abuse.

### Base URL

```
https://api.openballot.ng/v1
```

### Key Endpoints

```
GET /elections
  → List all elections in the database

GET /elections/{election_id}/results
  → Aggregate results for an election (national level)

GET /elections/{election_id}/results/{state_code}
  → State-level breakdown

GET /elections/{election_id}/results/{state_code}/{lga_code}
  → LGA-level breakdown

GET /elections/{election_id}/results/{state_code}/{lga_code}/{ward_code}
  → Ward-level breakdown

GET /polling-units/{pu_code}/submissions
  → All EC8A submissions for a specific polling unit
  → Includes image URLs, extracted figures, confidence scores, verification status

GET /discrepancies?election_id={id}&state={code}
  → All active discrepancy flags

GET /audit/hashes?election_id={id}
  → Downloadable CSV of all image hashes for an election

GET /audit/chain?election_id={id}
  → Full evidentiary chain dataset (post-election publication)
```

### Response Format

All endpoints return JSON. Example polling unit response:

```json
{
  "pu_code": "25/11/04/007",
  "pu_name": "Surulere Ward 4, Unit 007",
  "ward": "Surulere Ward 4",
  "lga": "Surulere",
  "state": "Lagos",
  "coordinates": { "lat": 6.4969, "lng": 3.3515 },
  "election_type": "presidential",
  "election_id": "2027-pres",
  "verification_status": "consensus",
  "submissions": [
    {
      "source": "party_agent",
      "party": "APC",
      "submitted_at": "2027-02-27T17:43:22Z",
      "gps_at_capture": { "lat": 6.4971, "lng": 3.3517 },
      "gps_distance_from_pu_metres": 24,
      "image_url": "https://cdn.openballot.ng/ec8a/2027/25-11-04-007-apc.jpg",
      "image_sha256": "e3b0c44298fc1c149afb...",
      "confidence": 0.97,
      "extracted": {
        "registered_voters": 412,
        "accredited_voters": 287,
        "candidate_votes": {
          "Candidate A (APC)": 142,
          "Candidate B (PDP)": 89,
          "Candidate C (LP)": 203
        },
        "total_valid_votes": 434,
        "rejected_ballots": 12,
        "total_votes_cast": 446
      },
      "validation": {
        "arithmetic_consistent": true,
        "presiding_officer_signed": true,
        "agent_signatures_detected": 3,
        "official_stamp_present": true
      }
    }
  ],
  "inec_irev_status": "uploaded",
  "inec_irev_match": true
}
```

---

## Historical Data Layer

OpenBallot is designed as a **permanent archive**, not a one-election tool.

### Data from 2023 Forward

The 2023 General Election results are available on INEC's IReV portal as EC8A images. OpenBallot will ingest and process these as a historical baseline, enabling:
- Polling unit level comparison between 2023 and 2027 results
- Statistical anomaly detection using historical turnout patterns
- Long-term research on Nigerian electoral trends

### Schema Design for Permanence

Every table in the database is scoped by `election_id`, enabling any number of elections to coexist. The polling unit register (master geo table) is election-agnostic - elections reference it, not the reverse.

### Between Elections

The platform remains live and useful between election cycles:
- Historical results are always browsable and downloadable
- The public API remains active
- Researchers and journalists can query the full dataset at any time
- New elections are added to the same platform - agents simply re-register for the next cycle

---

## Tech Stack

| Layer | Technology | Rationale |
|---|---|---|
| **Frontend** | Next.js 14 (App Router) | SSR for SEO and shareability; React ecosystem |
| **Map** | Mapbox GL JS | Best-in-class choropleth at polling unit granularity |
| **Charts** | Recharts + D3.js | Flexible, real-time capable |
| **Agent PWA** | Next.js PWA (next-pwa) | No app store, offline-first |
| **Backend API** | Next.js API Routes + FastAPI (Python) | Next.js for web layer; FastAPI for ingestion/AI workers |
| **Database** | Supabase (PostgreSQL + PostGIS) | Geo queries, Realtime subscriptions, Row-level security |
| **Real-time** | Supabase Realtime | Map updates as submissions arrive |
| **OCR - Primary** | Google Document AI (Form Parser) | Purpose-built for structured form extraction |
| **OCR - Secondary** | GPT-4o Vision API | Fallback and verification for low-confidence extractions |
| **Image Storage** | Supabase Storage + Cloudflare R2 | Redundant storage; CDN-delivered EC8A images |
| **Queue** | BullMQ + Redis | Async processing of ingestion pipeline |
| **Blockchain** | Ethereum (OP_RETURN via Infura) | Hash anchoring for immutability proof |
| **Infrastructure** | Docker + Hetzner VPS + Cloudflare | European hosting for low latency; DDoS protection |
| **Notifications** | Twilio (SMS) + WhatsApp Business API | Agent onboarding and alerts in 5 languages |
| **Styling** | Tailwind CSS | Consistent, accessible, fast |
| **i18n** | next-intl | Five-language support with RTL-ready architecture |

---

## Data Model Overview

```sql
-- Core geography (election-agnostic master table)
polling_units (
  pu_code          TEXT PRIMARY KEY,   -- INEC official code
  pu_name          TEXT,
  ward_code        TEXT,
  ward_name        TEXT,
  lga_code         TEXT,
  lga_name         TEXT,
  state_code       TEXT,
  state_name       TEXT,
  geog             GEOGRAPHY(POINT),   -- PostGIS
  registered_voters_2023  INTEGER,
  registered_voters_2027  INTEGER
)

-- Elections registry
elections (
  id               TEXT PRIMARY KEY,   -- e.g. "2027-presidential"
  election_type    TEXT,               -- presidential | senate | reps | gov | stha | lga
  election_date    DATE,
  status           TEXT                -- upcoming | active | concluded
)

-- EC8A submissions (one per party/observer per PU per election)
ec8a_submissions (
  id               UUID PRIMARY KEY,
  election_id      TEXT REFERENCES elections,
  pu_code          TEXT REFERENCES polling_units,
  submitted_by     UUID REFERENCES agents,
  party_code       TEXT,
  source_type      TEXT,              -- party_agent | observer
  image_url        TEXT,
  image_sha256     TEXT,
  blockchain_tx    TEXT,              -- Ethereum TX hash
  gps_lat          DOUBLE PRECISION,
  gps_lng          DOUBLE PRECISION,
  gps_distance_metres  INTEGER,
  submitted_at     TIMESTAMPTZ,
  confidence_score DECIMAL(4,3),
  extracted_data   JSONB,
  validation_flags JSONB,
  review_status    TEXT               -- auto_approved | pending_review | reviewed
)

-- Computed consensus results (materialised view + manual override log)
verified_results (
  election_id      TEXT,
  pu_code          TEXT,
  verification_status  TEXT,          -- no_data | single_source | consensus | discrepancy | inec_confirmed | inec_conflict
  consensus_data   JSONB,
  submission_count INTEGER,
  last_updated     TIMESTAMPTZ
)

-- Discrepancy register
discrepancies (
  id               UUID PRIMARY KEY,
  election_id      TEXT,
  pu_code          TEXT,
  detected_at      TIMESTAMPTZ,
  conflicting_submissions  UUID[],
  discrepancy_fields  TEXT[],
  escalation_status   TEXT,           -- open | notified | resolved
  resolved_at      TIMESTAMPTZ,
  resolution_note  TEXT
)

-- Full audit log (append-only)
audit_log (
  id               BIGSERIAL PRIMARY KEY,
  event_type       TEXT,
  entity_id        TEXT,
  actor_id         UUID,
  event_data       JSONB,
  event_at         TIMESTAMPTZ,
  log_hash         TEXT               -- chained hash for tamper-evidence
)
```

---

## Security Architecture

### Threat Model

| Threat | Mitigation |
|---|---|
| **DDoS on election day** | Cloudflare Enterprise-tier protection; auto-scaling via Docker Swarm; CDN-cached read endpoints |
| **Coordinated fake EC8A submissions** | Geo-fencing (GPS must match PU); multi-party cross-verification (hard to fake agreement); image metadata integrity; public scrutiny via visible EC8A images |
| **Agent account takeover** | Phone OTP authentication; device binding; anomaly detection (same agent submitting from multiple locations) |
| **Party admin account compromise** | 2FA enforced on all admin accounts; all admin actions logged and auditable |
| **Insider threat (platform team)** | Append-only audit log; blockchain-anchored hashes; full dataset published after election - any alteration is externally verifiable |
| **AI hallucination in OCR** | Confidence scoring; human review queue; source image always publicly visible; arithmetic consistency checks |
| **Malicious form uploads (non-EC8A)** | Form classification model; format validation before any data extraction |
| **EXIF stripping / metadata manipulation** | Flagged as "metadata integrity warning" in submission record; does not block submission but is publicly visible |

### Data Privacy

- Agent personal information (name, phone number) is never exposed publicly
- Public submission records reference credential type and party only
- Full agent identity is available to the consortium governance committee and to INEC on formal request
- All data is processed and stored in compliance with Nigeria's Data Protection Act (NDPA) 2023

---

## Governance

OpenBallot Nigeria is owned and governed by a consortium of civil society organisations. No single organisation controls the platform.

### Consortium Responsibilities

- Approving political party and observer organisation onboarding
- Reviewing and resolving human review queue submissions
- Overseeing discrepancy escalations
- Publishing the post-election evidentiary dataset
- Managing funder relationships and financial reporting
- Approving changes to the platform's editorial and display policies

### What the Consortium Does NOT Do

- Declare election results
- Adjudicate disputes between parties
- Characterise any discrepancy as fraud (only as a factual difference requiring investigation)
- Take positions on election outcomes

### Consortium Membership

We are actively building the founding consortium. Organisations with a mandate in Nigerian election observation, civic data, or media freedom are invited to apply for founding membership. Contact: **consortium@openballot.ng**

---

## Funding & Partners

OpenBallot Nigeria is a civic public good, operated on a not-for-profit basis. The platform is funded through grants and does not carry advertising, accept paid placements, or charge citizens for access.

### Funding Approach

We are approaching the following funders ahead of the 2027 election cycle:

- **MacArthur Foundation** - Nigeria-focused civic and democratic governance grants
- **Ford Foundation** - Civic technology, transparency, and human rights
- **European Union Election Observation Missions** - Digital infrastructure for election integrity

### For Funders

The full grant documentation package - including platform architecture, governance structure, budget breakdown, and risk assessment - is available on request at **grants@openballot.ng**

The OpenBallot codebase is fully open source (AGPL v3). Funders, partners, and the public can audit every line of code at any time.

---

## Roadmap

### Phase 1 - Foundation (Months 1–4)
- [ ] Core data model and Supabase schema
- [ ] Agent PWA (four-screen offline-first upload flow)
- [ ] OCR pipeline (Google Document AI + GPT-4o) - tested against 2023 EC8A samples
- [ ] Basic public map (national and state level)
- [ ] Pilot deployment: one off-cycle governorship election (single state)
- [ ] Founding CSO consortium established
- [ ] Grant applications submitted

### Phase 2 - Multi-Party & Multi-State (Months 5–9)
- [ ] Party Admin Portal with bulk agent onboarding
- [ ] Multi-source Verification Engine
- [ ] Discrepancy Register (public page)
- [ ] Discrepancy escalation notifications
- [ ] Public REST API v1
- [ ] Embeddable media widget
- [ ] Multi-language support (all five languages)
- [ ] Blockchain hash anchoring
- [ ] Deployment: multi-state off-cycle elections

### Phase 3 - National Scale (Months 10–18)
- [ ] Scale testing at 176,846 polling unit load
- [ ] Observer onboarding portal
- [ ] Historical data ingestion (2023 IReV EC8A images)
- [ ] Full Level C audit trail publication pipeline
- [ ] Statistical anomaly detection engine
- [ ] Media partnership programme (Channels TV, TVC, The Punch, etc.)
- [ ] Security audit by independent third party
- [ ] Full deployment: 2027 General Elections

---

## Contributing

OpenBallot Nigeria is open source and community contributions are welcome.

### Ways to Contribute

- **Code** - See open issues tagged `good-first-issue` and `help-wanted`
- **Language** - Help translate or review UI strings in Hausa, Yoruba, Igbo, or Pidgin
- **OCR Testing** - Help build and label the EC8A training dataset
- **GeoData** - Help verify and improve polling unit coordinates
- **Documentation** - Improve technical and user-facing docs
- **Security** - Responsible disclosure: **security@openballot.ng**

### Development Setup

```bash
# Clone the repository
git clone https://github.com/vitalclick/OpenBallot

# Install dependencies
cd OpenBallot
npm install

# Copy environment variables
cp .env.example .env.local
# Configure Supabase, Google Document AI, and OpenAI keys

# Run development server
npm run dev
```

Full setup documentation is in [`/docs/DEVELOPMENT.md`](/docs/DEVELOPMENT.md).

### Mock Mode vs. Real Data

On a fresh clone with no environment variables configured, the web app runs in **mock mode**. The Discrepancy Register, Map, and other data-driven pages render fixtures generated by `web/lib/mock-data.ts` so the UI is browsable end-to-end without provisioning any backend services.

In mock mode the EC8A images shown on the Discrepancy Register are placeholders served by `placehold.co` (e.g. the grey `EC8A APC` / `EC8A B` panels). They are not real ballot forms — they exist so the layout and the surrounding fields (extracted votes, SHA-256, confidence, etc.) can be reviewed visually.

Mock mode is triggered by the absence of `NEXT_PUBLIC_SUPABASE_URL` (see `isMockMode()` in `web/lib/mock-data.ts`). To pull real submissions and their stored EC8A images instead:

1. Provision Supabase and run the SQL migrations under `db/migrations/`.
2. Populate `.env.local` with:
   ```
   NEXT_PUBLIC_SUPABASE_URL=...
   NEXT_PUBLIC_SUPABASE_ANON_KEY=...
   SUPABASE_SERVICE_ROLE_KEY=...
   ```
3. Ingest EC8A images via the agent app, the scrapers in `scrapers/`, or by inserting submission rows directly. Images are uploaded to Supabase Storage; `image_url` on each submission must resolve to that stored object.
4. Restart `npm run dev`. The `/api/v1/discrepancies` endpoint will now read from the `v_discrepancy_register` view instead of `mockDiscrepancies()`, and the Mapbox renderer will activate once `NEXT_PUBLIC_MAPBOX_TOKEN` is also set.

### Map Data

The SVG fallback map (rendered when `NEXT_PUBLIC_MAPBOX_TOKEN` is unset) draws Nigeria's country outline and the 36 state + FCT boundaries from `web/public/nigeria.geo.json`. That file is extracted from [Natural Earth](https://www.naturalearthdata.com/) (public domain) — country outline from the 1:50m admin-0 layer, state boundaries from the 1:10m admin-1 layer, with coordinates rounded to 4 decimal places (~11 m precision) for compactness. It is ~116 KB raw / ~37 KB gzipped.

To regenerate from upstream Natural Earth (e.g. to pick up corrected borders):

```bash
curl -sL https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson -o /tmp/admin0.geojson
curl -sL https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson -o /tmp/admin1.geojson
# Filter to Nigeria features, round coords, merge — see commit history for the exact jq + node pipeline.
```

When the real Mapbox renderer is active, country/state geometry is served as vector tiles by `/api/v1/tiles` and this static GeoJSON is not used.

### Code of Conduct

OpenBallot Nigeria is committed to a welcoming, inclusive contributor community. All contributors are expected to adhere to our [Code of Conduct](/CODE_OF_CONDUCT.md).

---

## License

OpenBallot Nigeria is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

This means:
- Anyone can use, study, modify, and distribute the code freely
- Any modified version that is deployed as a public service must also be released under AGPL-3.0
- You cannot take this code, make it proprietary, and run it as a closed service

This licence was chosen deliberately: it ensures that any government body, political party, or commercial entity that deploys a version of OpenBallot must keep their version open and auditable. The transparency principle is enforced at the licence level.

See [LICENSE](/LICENSE) for the full licence text.

---

*OpenBallot Nigeria - The form is the truth. The truth is public.*

---

**Website:** https://openballot.ng  
**API:** https://api.openballot.ng  
**GitHub:** https://github.com/vitalclick/OpenBallot  
**Contact:** hello@openballot.ng  
**Press:** press@openballot.ng  
**Grants:** grants@openballot.ng  
**Security:** security@openballot.ng  
**Consortium membership:** consortium@openballot.ng
