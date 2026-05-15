# Public roadmap

The OpenBallot Nigeria public roadmap. Order is approximate; priority
shifts as the consortium signs founding members and grant funding
lands.

## Now — completing the v0.1.0 launch foundation

| Item | Status |
|---|---|
| Multi-source consensus engine | ✅ Shipped |
| EC8A presigned upload + ingestion pipeline | ✅ Shipped |
| Audit chain (DB + Python + JS verifier) | ✅ Shipped |
| Ethereum anchor cron | ✅ Shipped |
| AI extraction (Document AI + GPT-4o adapters) | ✅ Shipped |
| Statistical anomaly detection (3 layers) | ✅ Shipped |
| Agent + observer + admin web flows | ✅ Shipped |
| 2023 IReV scraper + pilot harness | ✅ Shipped |
| Vector tiles with polygon choropleth | ✅ Shipped |
| Per-PU public detail page | ✅ Shipped |
| Operational instrumentation (Sentry + Prometheus) | ✅ Shipped |
| Five-language i18n scaffolding | ✅ Shipped |
| Deployment handbook + CD pipeline | ✅ Shipped |

## Next — pre-launch operational work (Q3-Q4 2026)

| Item | Driver |
|---|---|
| Provision production Cloudflare R2 + Supabase + Mapbox | Operations lead |
| Pilot scrape against live IReV (one state, presidential only) | Operations lead |
| Train custom Document AI processor on 2023 EC8A samples | Worker lead |
| Recruit + onboard founding CSO consortium | Consortium chair |
| Submit grant applications (MacArthur / Ford / EU EOM) | Consortium chair |
| Translate landing copy into HA / YO / IG / PCM | Translation working group |
| Load real Nigerian state + LGA polygons from OCHA / HDX | Geo working group |
| Independent penetration test | Security working group |

## Soon — 2027 election readiness

| Item | Notes |
|---|---|
| Party admin portal hardening | Bulk roster operations, agent transfer between PUs, deactivation flow |
| Observer file upload (INEC accreditation docs) | Presign exists; UI completion |
| Real-time queue depth + worker health dashboards | Grafana dashboards committed to repo |
| 2026 governorship pilot deployment | One state, full stack, real agents |
| Media partnership programme | Channels TV, TVC, The Punch, Premium Times |
| Multi-region read replica for Africa | Supabase add-on for low-latency reads |
| Mobile app store presence (optional) | PWA covers most cases; native apps possibly for outreach |

## Later — beyond 2027

| Item | Notes |
|---|---|
| Senate + Reps + Governorship + STHA full coverage | The 2027 cycle is 5 simultaneous elections |
| Historical archive (2003 forward) | Cooperative ingestion from existing CSO datasets |
| Custom OCR processor for collation forms (EC8B, EC8C, EC8D, EC8E) | Currently we cover EC8A; the higher levels are the manipulation surface that produced Rivers-2023 |
| Statistical Alert dashboards for journalists | Per-anomaly-type subscriptions |
| End-to-end zero-knowledge proofs for PU-level results | Research-track; would strengthen the audit story further |
| Inter-platform federation | Coordinate with similar platforms in Ghana / Senegal / Kenya |

## Things we have considered and decided NOT to do

- **Native iOS / Android apps as the agent surface.** The PWA covers
  every required capability without app-store gatekeeping. Native
  apps are on the "Later" list as outreach, not as the primary
  channel.
- **AI-generated commentary on results.** OpenBallot does not opine.
  Tribunals adjudicate; we present evidence.
- **Closed-source enterprise tier.** AGPL is non-negotiable. See
  ADR-0009.
- **Token / blockchain governance.** Ethereum is used as a witness
  layer (ADR-0004), nothing else. The platform has no token, no DAO,
  no on-chain governance.

## How priorities change

This roadmap is updated when:
1. A consortium-level decision shifts priorities (recorded as an ADR)
2. A grant lands (or doesn't) and capacity shifts
3. A new election cycle is announced

Suggestions welcome via GitHub Discussions or **consortium@openballot.ng**.
