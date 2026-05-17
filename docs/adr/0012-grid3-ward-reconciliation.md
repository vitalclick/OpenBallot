# ADR-0012: GRID3 ↔ INEC ward reconciliation strategy

- **Status**: Accepted
- **Date**: 2026-05-17
- **Deciders**: Engineering

## Context

INEC does not publish ward polygons. The de facto open dataset is
GRID3 Nigeria's "Operational Wards" layer, hosted at
<https://grid3.org/geospatial-data-nigeria>. GRID3 ships it in two
files that must both be loaded for full coverage:

- **v1.0 (Dec 2020)** — 9,410 features, all 37 states, OCHA COD-AB
  pre-PUC ward layout
- **v2.0 (Apr 2026)** — 4,044 features, 15 states only (the ones
  GRID3 has republished against current INEC names so far)

Two challenges:

1. **Names drift between GRID3 and INEC.** Single-letter spelling
   differences (`Damban` vs `Dambam`), historical renames (`Yewa
   North` vs colonial-era `Egbado North`), abbreviation conventions
   (GRID3 `Maiduguri` vs INEC `Maiduguri M. C.`), slash-vs-space
   punctuation (`Kala/Balge` vs `Kala Balge`), and even non-matching
   2-letter state codes (GRID3 `BR` vs INEC `BO` for Borno; GRID3
   `KB` vs INEC `KE` for Kebbi).

2. **The map paints each region by the leading party** (ADR-0013).
   A polygon bound to the wrong INEC ward visually misattributes a
   leader's color to the wrong piece of ground. So the
   reconciliation pipeline cannot be just "loosen the fuzzy
   threshold and call it done" — quality of match matters more than
   raw coverage.

## Decision

**A multi-pass reconciler with curated aliases, fuzzy and substring
LGA matching, fuzzy ward matching with confidence multiplication, a
0.80 default acceptance threshold, and graceful circle fallback for
wards that don't match. No correctness compromises to chase
coverage.**

The pipeline in `scripts/reconcile_ward_names.py` applies these
passes in order, falling through on miss:

1. **Override (per-ward CSV)** — `data/ward_boundaries/overrides.csv`
   lets operators force a specific GRID3 feature ID onto a specific
   INEC ward code. Used for one-off cases that escape every other
   pass. Confidence: 1.0.

2. **State-code alias** — `GRID3_TO_INEC_STATE_CODE` maps known
   mismatches like `BR -> BO`, `KB -> KE`. Applied to the source's
   `statecode` before the bucket lookup. Without this, 525 wards
   (310 Borno + 215 Kebbi) would be unreachable regardless of
   ward-name quality.

3. **Exact LGA + exact ward** — bucket key
   `(state_code, normalised_lga_name)`; exact-name match within the
   bucket. Confidence: 1.0.

4. **Exact LGA + alt-ward** — GRID3 v2's `ward_alt_names` column
   provides alternate ward names; if the primary name doesn't match
   but an alt does, accept as exact. Confidence: 1.0.

5. **LGA name alias + exact ward** —
   `LGA_NAME_ALIASES[(state_code, source_lga_norm)]` lets us
   manually pin known LGA renames (Yewa↔Egbado, Obi Nwga↔Obingwa,
   Kogi↔Kogi.K.K., Sabon Birni↔S/Birni, Dambatta↔Danbata). Curated;
   the seven current entries close 56 of the 76 remaining `no_lga`
   cases. Confidence: 1.0.

6. **LGA substring + exact ward** — if normalised source LGA fully
   contains or is contained by an INEC LGA (and shorter side ≥ 5
   chars), accept as a strong match. Catches `Maiduguri` ⊂
   `Maiduguri M. C.` cleanly. Confidence: max(length_ratio, 0.85).

7. **LGA fuzzy + exact ward** — within the same state, the highest
   `SequenceMatcher.ratio()` across all LGAs; accept if ≥ 0.82.
   Catches `Damban` vs `Dambam`. Confidence: the ratio itself.

8. **Fuzzy ward within matched LGA** — same `SequenceMatcher`
   approach. ≥ 0.90 accepts as `fuzzy`; 0.75–0.89 emits as
   `needs_review` for operator visibility; below 0.75 drops as
   `no_ward`. Final confidence multiplies the LGA pass's confidence
   by the ward ratio.

`WARD_LOAD_MIN_CONFIDENCE` (env-overridable, default 0.80) governs
which matches actually land in `ward_boundaries`. Below the
threshold goes to `load_report.csv` as `skipped_low_confidence` for
later override-CSV curation. 0.80 lets fuzzy-LGA + exact-ward (~0.83
typical) through while rejecting the noisier ≤ 0.75 fuzzy-ward
matches.

## Alternatives considered

**(A) Manual `overrides.csv` for every mismatch (full hand
curation).** Rejected. At ~2,700 unmatched wards × 30 seconds of
research each = ~22 hours of focused work. Plus most of those
"unmatched" wards in southern states are real data divergence —
INEC consolidated 3 pre-2020 wards into 1, or created new wards
that have no 2020 GRID3 equivalent — so the override would force a
2020 boundary onto a 2024 ward layout. Under ADR-0013's
"fill = leading party" rule, that's a misattribution risk worse
than no polygon at all.

**(B) Lower `WARD_LOAD_MIN_CONFIDENCE` to 0.70.** Rejected (after
trying it on paper). Would convert the `needs_review` bucket
(1,500 rows at 0.75-0.89) from circles to polygons but with
elevated risk of binding a ward to a similarly-named neighbour in
the same LGA. The choropleth's correctness contract makes this
trade unattractive.

**(C) Substring matching without a length floor.** Tested in
isolation, then rejected. `Aba` ⊂ `Abaji` would match any 3-char
substring against any longer name. Floor of 5 chars eliminates the
common false-positive surface without losing real matches.

**(D) Use OSM `admin_level=8` to fill gap states.** Investigated and
abandoned for Lagos specifically. The diagnostic
`admin_level=4: 1, admin_level=6: 20` (no ward-level boundaries in
OSM Lagos) shows the Nigerian OSM community hasn't mapped wards as
admin areas. Lagos's strong OSM coverage is for streets and
buildings, not the abstract election-administrative ward layer.

**(E) Use GADM v4.1 level-3 as a backup source.** Investigated. GADM
publishes level-3 only as Geopackage / Shapefile (requires a
conversion step), is based on the same pre-2020 official data as
GRID3 v1.0, and would inherit the same southern-state divergence.
Not worth the integration cost.

## Consequences

**Makes easy:**
- Adding a new state-code alias is a one-line edit to
  `GRID3_TO_INEC_STATE_CODE`.
- Curating LGA-level mismatches scales because each entry recovers
  every ward in the LGA (10-15 wards per row).
- Re-running the loader against new GRID3 vintages (v2.1, v2.2 ...)
  is idempotent: `ON CONFLICT (ward_code) DO UPDATE` swaps in the
  newer polygon.

**Makes hard:**
- The reconciler is a non-trivial pipeline. Adding a new matching
  strategy requires understanding the confidence-multiplication
  contract (LGA pass × ward pass = final).
- The `LGA_NAME_ALIASES` map needs occasional curation as INEC
  republishes its roster. Right now it's seven entries; over time
  could grow into the dozens.

**Locks us into:**
- GRID3 as the primary ward boundary source. Switching to OSM, GADM,
  or commissioned data means redoing the SOURCE_PROPS schema
  detection and likely the alias map.
- Confidence < 0.95 polygons render with a dashed stroke (ADR-0013)
  so the user sees provenance, not a clean line. Reverting that
  visual would require a different way to surface match uncertainty.

**Honest coverage numbers** (May 2026 snapshot):
- 6,170 of 8,712 INEC wards have polygons (~71%)
- Excellent (>90%): all 10 v2.0-covered states (Jigawa 100%,
  Kano 97%, etc.)
- Poor (<50%): southern states GRID3 hasn't republished yet —
  Rivers 12%, Akwa Ibom 26%, Lagos 31%, Anambra 45%
- The 29% gap renders as centroid circles, also leader-party
  coloured — strictly correct, just spatially less precise.

## References

- `scripts/reconcile_ward_names.py`
- `scripts/load_ward_boundaries.py`
- `scripts/fetch_osm_wards.py` (the abandoned-for-Lagos OSM fallback)
- `data/ward_boundaries/overrides.csv`
- `db/migrations/0012_ward_boundaries.sql`
- `docs/WARD_BOUNDARIES.md`
- ADR-0013 (the choropleth rule that drove the "accuracy over
  coverage" decision)
