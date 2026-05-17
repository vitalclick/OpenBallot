# ADR-0011: Geographic identifiers derived from INEC's `delim` code

- **Status**: Accepted
- **Date**: 2026-05-17
- **Deciders**: Engineering

## Context

Loading INEC's 174,175 polling units into the `polling_units` /
`wards` / `lgas` / `states` tables required a code scheme for each
level of the geography. INEC publishes a hierarchical 4-segment
`delim` code on every polling unit (e.g. `25-11-04-007` = state /
LGA / ward / PU) but does not publish parent-level codes.

The schema in `0001_core_schema.sql` is permissive on format — every
code column is `TEXT PRIMARY KEY` — but the dev seed signals a
specific convention by example:

```sql
INSERT INTO states (code, ...) VALUES ('LA', ...);
INSERT INTO lgas   (code, ...) VALUES ('LA-SUR', ...);
INSERT INTO wards  (code, ...) VALUES ('LA-SUR-04', ...);
INSERT INTO polling_units (pu_code, ...) VALUES ('25-11-04-007', ...);
```

So the seed mixes two formats: 2-letter alpha for states, slug-style
hierarchy for LGAs/wards, raw 4-segment numeric for PUs. We had to
pick one consistent scheme that scaled from 4 seed rows to 174k real
rows.

A complication: the scraper that produces the per-state JSON files
constructs `pu_code` as `<state_name>-<delim>` (e.g.
`"ABIA-01-01-01-001"`), and its own source comment claims that
`delim` "repeats across states" — i.e. that the first numeric
segment is not actually a globally-unique state ID. The seed,
however, treats the bare delim as the canonical PU code.

## Decision

**State codes are 2-letter alpha (`LA`, `KN`, `BO`, `FC`); LGA and
ward codes are `<parent>-<delim_segment>` slices; PU codes are the
bare 4-segment delim. A pre-flight pass over all 37 state JSONs
verifies the bare-delim assumption before any DB writes happen.**

In concrete form:

| Level | Format | Derivation | Example |
|---|---|---|---|
| `states.code` | 2-letter alpha | `STATES` map keyed by INEC state name | `"BO"` for Borno |
| `lgas.code` | `<state_code>-<seg2>` | state_code + delim segment 2 | `"BO-15"` |
| `wards.code` | `<lga_code>-<seg3>` | lga_code + delim segment 3 | `"BO-15-01"` |
| `polling_units.pu_code` | bare 4-segment delim | `pu.delim` from scraper | `"25-11-04-001"` |

The 37-entry `STATES` map in `scripts/load_polling_units.py` lists
each state's 2-letter code, display name, and geopolitical zone
(NW/NE/NC/SW/SE/SS/FCT). This is the single source of truth for
state codes across the loader, the reconciler, and the API
endpoints. Adding a state means editing one map.

The pre-flight collision check in `preflight_delim_uniqueness()`
scans every PU's `delim` across all 37 files and aborts the load
(without opening a DB transaction) if any delim is claimed by more
than one state — defusing the scraper author's "delim repeats"
warning empirically. Across the full May 2026 INEC roster, all
174,175 delims were unique.

## Alternatives considered

**(A) Numeric all the way down** — `state_code = "25"`,
`lga_code = "25-11"`, etc. Rejected: the schema seed clearly assumes
2-letter state codes, and code like `web/components/ChoroplethMap.tsx`
already hard-codes `LA`/`KN`/`RI`/`FC`. Numeric codes would have
forced a cascading rename across the frontend.

**(B) Alpha all the way down** — `state_code = "LA"`,
`lga_code = "LA-SUR"`, slug LGA names. Rejected: requires
hand-curating ~774 LGA slugs and ~8,800 ward slugs. INEC's official
codes (the delim segments) are stabler than English spelling.

**(C) Prefix `pu_code` with the state code defensively** —
`"BO-15-01-01-001"`. Rejected once the pre-flight confirmed bare
delim is globally unique. The seed's format becomes our format with
no compatibility shim.

## Consequences

**Makes easy:**
- Joining polling unit results back to the geo hierarchy is a substring
  query: `pu_code LIKE '25-11-%'` gets all Lagos Surulere PUs.
- The dev seed in `01_geo_seed.sql` is forward-compatible — its PU
  codes are real INEC delims and slot into the loaded data without
  conflict.
- State-code-based reconciliation against external data sources
  (GRID3, GADM, OSM) keys on a stable 2-letter alpha that matches
  Nigerian postal convention.

**Makes hard:**
- The 2-letter state codes must agree across the frontend, the
  loader, the reconciler, and the seed. Renumbering is a multi-file
  refactor.
- Adding a 38th state (hypothetical) means updating the `STATES`
  map in `load_polling_units.py`, the `GRID3_TO_INEC_STATE_CODE`
  alias map in `reconcile_ward_names.py`, and any frontend
  hard-codings.

**Locks us into:**
- The assumption that INEC continues to publish a 4-segment delim.
  If they switch to a different ID scheme, every PU code in the
  database must be rewritten — but every result we record cites a
  specific delim, so a switch would also require the pre-flight to
  bridge the old and new schemes.

## References

- `scripts/load_polling_units.py:STATES`
- `scripts/load_polling_units.py:preflight_delim_uniqueness`
- `db/migrations/0001_core_schema.sql`
- `db/seed/01_geo_seed.sql`
