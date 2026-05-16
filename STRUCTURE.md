# Repository structure

```
OpenBallot/
├── README.md                          # Project overview (preserved from pre-scaffold)
├── COLLATION_VERIFICATION_ENGINE_SPEC.md  # Full technical specification
├── LICENSE                            # AGPL-3.0
├── SECURITY.md                        # Disclosure policy
├── CODE_OF_CONDUCT.md
├── STRUCTURE.md                       # This file
├── package.json                       # npm workspace root
├── .env.example                       # Environment template
├── .editorconfig
├── .gitignore
│
├── web/                               # Next.js 14 application
│   ├── app/
│   │   ├── layout.tsx                 # Root HTML shell
│   │   ├── page.tsx                   # → redirects to /en
│   │   ├── globals.css                # Tailwind
│   │   ├── [locale]/
│   │   │   ├── layout.tsx             # next-intl provider + header
│   │   │   ├── page.tsx               # Landing
│   │   │   ├── map/page.tsx           # Public results map
│   │   │   ├── discrepancies/page.tsx # Public discrepancy register
│   │   │   ├── agent/page.tsx         # Agent PWA (4-screen flow)
│   │   │   └── admin/page.tsx         # Party admin portal
│   │   ├── embed/                     # Iframeable widget
│   │   │   ├── layout.tsx
│   │   │   └── map/page.tsx
│   │   └── api/v1/                    # Public REST API
│   │       ├── health/route.ts
│   │       ├── elections/route.ts
│   │       ├── elections/[id]/results/route.ts
│   │       ├── elections/[id]/units/route.ts
│   │       ├── elections/[id]/stream/route.ts   # Server-Sent Events
│   │       ├── polling-units/[code]/submissions/route.ts
│   │       ├── discrepancies/route.ts
│   │       └── audit/hashes/route.ts            # Downloadable CSV manifest
│   ├── components/
│   │   ├── Header.tsx
│   │   ├── LiveCounters.tsx
│   │   ├── ResultsMap.tsx             # Mapbox + SVG fallback
│   │   ├── DiscrepancyRegister.tsx
│   │   ├── agent/
│   │   │   ├── AgentFlow.tsx          # Four screens: login → PU → capture → submit
│   │   │   └── queue.ts               # IndexedDB offline queue + SHA-256
│   │   └── admin/AdminDashboard.tsx   # Roster upload + coverage + review queue
│   ├── lib/
│   │   ├── i18n.ts                    # next-intl configuration
│   │   ├── types.ts                   # Wire types shared with worker
│   │   ├── api.ts                     # jsonOk / rateLimit helpers
│   │   ├── supabase.ts                # Client + admin Supabase clients
│   │   └── mock-data.ts               # Deterministic fallback when no backend
│   ├── messages/                      # i18n
│   │   ├── en.json
│   │   ├── ha.json                    # Hausa
│   │   ├── yo.json                    # Yoruba
│   │   ├── ig.json                    # Igbo
│   │   └── pcm.json                   # Nigerian Pidgin
│   ├── middleware.ts                  # Locale routing
│   ├── public/
│   │   ├── manifest.json              # PWA
│   │   └── robots.txt
│   ├── next.config.mjs                # PWA + i18n + headers
│   ├── tailwind.config.ts
│   ├── tsconfig.json
│   ├── package.json
│   └── Dockerfile
│
├── worker/                            # FastAPI service
│   ├── app/
│   │   ├── main.py                    # FastAPI app + /v1/ingest + /v1/audit/verify
│   │   ├── config.py                  # pydantic-settings
│   │   ├── db.py                      # asyncpg pool
│   │   ├── models.py                  # Pydantic wire types
│   │   ├── ingestion/
│   │   │   ├── pipeline.py            # Pure-function ingestion
│   │   │   ├── geofence.py            # Haversine + soft/hard fences
│   │   │   └── exif.py                # Metadata integrity flags
│   │   ├── extraction/
│   │   │   ├── engine.py              # Primary + fallback orchestration + stub
│   │   │   └── arithmetic.py          # EC8A consistency checks
│   │   ├── verification/
│   │   │   └── engine.py              # Multi-source consensus algorithm
│   │   └── audit/
│   │       ├── chain.py               # SHA-256 hash chain (matches SQL trigger)
│   │       ├── merkle.py              # Bitcoin-style Merkle root
│   │       └── anchor.py              # Ethereum OP_RETURN driver
│   ├── tests/
│   │   ├── test_verification.py       # 8 tests - all six map states
│   │   ├── test_audit_chain.py        # 6 tests - chain + tamper detection
│   │   └── test_ingestion_pipeline.py # 9 tests - GPS, EXIF, duplicates
│   ├── pyproject.toml
│   └── Dockerfile
│
├── db/
│   ├── migrations/
│   │   ├── 0001_core_schema.sql       # Geography, elections, agents, submissions
│   │   ├── 0002_audit_chain.sql       # Hash-chain trigger + Ethereum anchor table
│   │   └── 0003_views_and_aggregates.sql  # Public map views + state rollup
│   ├── policies/
│   │   └── rls.sql                    # Row-level security (Supabase + local-compatible)
│   └── seed/
│       └── 01_geo_seed.sql            # 12 PUs across 4 states for demo
│
├── infra/
│   └── docker-compose.yml             # Full stack: web + worker + db + redis + minio
│
├── scripts/
│   ├── verify_audit_chain.py          # Standalone chain verifier (zero deps)
│   └── load_polling_units.py          # Bulk-load scraper output into Postgres
│
├── docs/
│   ├── ARCHITECTURE.md
│   ├── DATA_MODEL.md
│   ├── DEPLOYMENT.md
│   ├── DEVELOPMENT.md
│   ├── INVESTOR_BRIEF.md
│   └── SECURITY.md
│
├── .github/workflows/
│   └── ci.yml                         # Tests + typecheck + DB migration smoke test
│
└── Polling-Units/                     # Pre-existing INEC scraper (Node.js)
    ├── scraper.js
    └── ...
```

## Numbers at a glance

| Layer | Files | Lines of code (excl. blank) |
|---|---|---|
| Database SQL | 5 | ~400 |
| Worker (Python) | 16 | ~1,200 |
| Worker tests | 3 | ~350 |
| Web (TS/TSX) | 28 | ~1,800 |
| Infra + CI | 3 | ~150 |
| Docs (markdown) | 6 | ~1,500 |
