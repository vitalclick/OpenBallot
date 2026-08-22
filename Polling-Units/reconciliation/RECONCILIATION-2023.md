# Polling-Unit Reconciliation — Scraped Data vs. INEC 2023 Report

**Date:** 2026-06-19
**Scraped data:** `Polling-Units/results/` (snapshot scraped 2026-05-16 from `inecnigeria.org`)
**Authoritative reference:** `documents/2023-GENERAL-ELECTION-REPORT.pdf` — *Report of the 2023 General Election*, Independent National Electoral Commission (INEC), published Feb 2024.

Per-state figures: `per-state-reconciliation.csv` · Re-scrape targets: `rescrape-targets.json`

> **Status (2026-06-20):** the gap-fill re-scrape was run live against INEC and **recovered 0 of the
> 2,671 missing polling units** — every flagged ward returns 0 from INEC's own API. The deficit is
> confirmed to be **missing upstream at INEC**, not a scraper defect. Full detail in §8.
>
> **Status (2026-08-22): the gap is closed — from CCIJ, not from INEC.**
> `scripts/load_pu_enrichment.py` (migration 0017) loaded the CCIJ 2023 roster, inserting the
> **2,671** missing polling units across **97** wards, plus the one missing LGA (Borno / Abadam,
> §3). The registry now holds 37 states / 774 LGAs / 8,809 wards / 176,846 polling units — every
> count matching INEC's own report exactly.
>
> The §8 finding below stands unchanged and is not superseded: **INEC's API still returns zero
> polling units for those wards.** Every inserted row carries `source = 'ccij_2023'` rather than
> `inec_scrape`, so the distinction survives in the registry. These units are attested by a third
> party, not by INEC, and a ward INEC cannot enumerate while 2,559 result documents exist for it
> remains a finding in its own right. Provenance: `data/pu-enrichment-2023/SOURCES.md`.

---

## 1. National totals

| Metric | Scraped | INEC Report | Difference |
|---|--:|--:|--:|
| States (incl. FCT) | 37 | 37 | 0 ✅ |
| LGAs | 774 | 774 | 0 ✅ |
| Wards (Registration Areas) | 8,799 | 8,809 | **−10** |
| Polling Units | 174,175 | 176,846 | **−2,671 (−1.51%)** |

> The figures above describe **the scrape**, and remain accurate as such. After the CCIJ
> enrichment load (see the status note above) the *registry* holds 8,809 wards and 176,846
> polling units — both differences now zero.

Report figures cross-checked against three independent tables in the PDF that all agree:
Table 3.2 (per-state PU comparison 2019 vs 2023), the Ch. 9 per-state RA table, and Table 12.1
(zonal delimitation). The report's per-state PU figures sum exactly to its stated 176,846 total;
the scraped per-state figures sum exactly to 174,175 — so neither side has an internal arithmetic
error. **The gap is real missing data, not a counting artifact** — and the 2026-06-20 live
re-scrape (§8) localised it to INEC's source: those wards return 0 PUs from INEC's own API.

## 2. Data-quality checks on the scrape

| Check | Result |
|---|---|
| `summary.json` totals vs. raw recount of nested JSON | ✅ Match exactly (174,175) — summary is trustworthy |
| Duplicate `pu_code` values | ✅ None (0) |
| Wards returning **0** polling units | ⚠️ **87 wards** across 19 states |
| Wards entirely absent vs. report | ⚠️ **10 wards, all in Borno** |

## 3. Where the 2,671 missing polling units are

- **17 of 37 states match the report exactly** (Anambra, Bayelsa, Cross River, Delta, Edo,
  Gombe, Kaduna, Kogi, Kwara, Nasarawa, Osun, Oyo, Plateau, Rivers, Sokoto, Yobe, Zamfara).
  The scraper logic is fundamentally correct.
- **No state ever has *more* PUs than the report** — every discrepancy is the scrape under-counting.
  This points to dropped pages/wards during scraping, not stale or inflated data.

Two distinct failure modes account for the deficit:

**(a) Empty wards** — a ward node was created but its polling-unit list came back empty.
87 wards. Worst: Ekiti (15), Katsina (11), Kebbi (9), Akwa Ibom (7), Niger (7). *Originally
hypothesised as a pagination/AJAX miss; the 2026-06-20 live re-scrape (§8) disproved this —
INEC's API itself returns 0 PUs for these wards, so the records are absent upstream.*

**(b) Partial / absent wards** — e.g. **Borno** has *no* empty wards yet is short 93 PUs, because
10 whole wards (likely in insecurity-affected LGAs) never appear at all (302 scraped vs 312 reported).

### Largest gaps (full list in CSV)

| State | Scraped PUs | Report PUs | Missing | % | Empty wards |
|---|--:|--:|--:|--:|--:|
| Lagos | 12,944 | 13,325 | −381 | −2.9% | 3 |
| Katsina | 6,327 | 6,652 | −325 | −4.9% | 11 |
| Ekiti | 2,132 | 2,445 | −313 | −12.8% | 15 |
| Akwa Ibom | 4,095 | 4,353 | −258 | −5.9% | 7 |
| Enugu | 4,000 | 4,145 | −145 | −3.5% | 5 |
| Kebbi | 3,599 | 3,743 | −144 | −3.8% | 9 |
| Benue | 4,960 | 5,102 | −142 | −2.8% | 4 |
| Niger | 4,812 | 4,950 | −138 | −2.8% | 7 |
| Ebonyi | 2,829 | 2,946 | −117 | −4.0% | 6 |
| Adamawa | 3,991 | 4,104 | −113 | −2.8% | 4 |
| Borno | 4,978 | 5,071 | −93 | −1.8% | 0 (10 wards absent) |

Ekiti is the worst proportionally (−12.8%); Lagos the worst in absolute terms (−381).

## 4. Caveats on the comparison

- **Like-for-like.** Report PU counts are the post-2021 expansion figures (119,974 → 176,846 PUs,
  after converting 56,872 Voting Points). The scrape clearly targets the same definition (17 exact
  matches confirm this), so the comparison is valid.
- **Relocations.** The report notes 749 PUs were *relocated* (not added/removed) and that voter
  migration was ongoing; a small number of single-unit differences could reflect post-publication
  edits on the live INEC site rather than scrape errors. This cannot explain whole empty/absent wards.
- **Registered voters not in scrape.** The report gives per-state registered-voter counts
  (national 93,469,008) — carried into the CSV for reference — but the scraped JSON stores only
  structural counts (LGA/ward/PU), so voter totals can't be reconciled from current data.

## 5. Dataset annotations applied (2026-06-19)

The INEC report contains **counts only** — it has no individual polling-unit codes/names
and no ward-name lists (results annexures are constituency-level). The missing records
therefore **cannot be filled from this document without fabricating data**, which was
deliberately avoided. Instead the dataset was annotated with the authoritative baseline:

- **`results/*.json` → `summary.reconciliation`**: each state now carries the report's
  expected `report_lgas / report_wards / report_polling_units / report_registered_voters_2023`,
  the gaps, a `status` (`complete` / `incomplete`), the list of `empty_wards_in_scrape`, and
  `wards_absent_from_scrape`.
- **Empty ward objects** are tagged in place with `"reconciliation_flag": "no_polling_units_in_scrape"`.
- **`results/summary.json` → `reconciliation`**: national totals, gaps, and counts.
- **No records were invented or altered** — the 174,175 real polling-unit records are unchanged,
  and `all-polling-units.json` was left untouched.

To obtain the *actual* missing records (names/codes/GPS), a targeted re-scrape using
`rescrape-targets.json` remains the only source.

## 6. Tooling (implemented)

The gap-fill workflow is wired into the scraper (`Polling-Units/scraper.js`):

- **`node scraper.js --gap`** — re-scrapes **only** the wards listed in `rescrape-targets.json`
  (87 empty wards + Borno's 10 absent wards), merging real records into the existing per-state
  files. It never re-pulls complete states, never fabricates records, and never overwrites
  records already present. `--gap --state "Borno"` scopes it to one state. After filling, it
  refreshes every reconciliation block and rebuilds `all-polling-units.json`.
- **`node scraper.js --reconcile`** — offline (no network); recomputes the per-state and national
  reconciliation annotations from `report-baseline.json`. Use it to re-derive gaps after any data
  change without hitting INEC.

`report-baseline.json` holds the report's authoritative per-state counts and is the single source
of truth both commands read from.

## 7. Remaining recommendations

1. ~~**Run `--gap`** once INEC's endpoints are reachable to recover the 2,671 missing units.~~
   **Done (2026-06-20) — recovered 0; the gap is upstream-empty, not scrape-side. See §8.**
2. **Borno's 10 absent wards are the same story** — the live re-scrape returned 0 for them too,
   so they are absent from INEC's current site listing rather than dropped by a fetch error.
3. **Add a validation gate to the full scrape** — fail/retry any ward returning 0 PUs, and assert
   per-state PU totals against `report-baseline.json` before declaring a state complete. (Still
   worth doing to catch *future* transient misses, even though the current gap is not one.)
4. Optionally **capture registered-voter counts** per PU/ward during scraping to enable a turnout/
   voter reconciliation against the report in future.
5. **To actually obtain the missing ~2,671 PUs**, look beyond the live scraper endpoint: a future
   INEC data restoration, INEC's separately-published constituency-level PU registers, or the
   GRID3/third-party PU datasets. The 2023 report PDF cannot supply them (counts only, no codes/names).

## 8. Live re-scrape result (2026-06-20) — the gap is upstream-empty, not a scrape defect

`node scraper.js --gap` was run against the live INEC site on 2026-06-20. Endpoint discovery
succeeded (theme auto-detected as `rishi`, base URL
`https://www.inecnigeria.org/wp-content/themes/rishi/custom/views`, 37 states enumerated), and it
targeted all 20 flagged states — 87 empty wards + Borno's 10 absent wards.

**Result: 0 polling units recovered.** Every targeted ward returned `API returned 0`; the merged
dataset is unchanged at 174,175 PUs. A single-state spot check on the worst gap
(`--gap --state "Ekiti"`, −12.8%) reproduced the same outcome — all 15 Ekiti wards returned 0.

This is decisive: the scraper, endpoint discovery, and ward targeting all work (the API enumerates
states and accepts each ward query), but **INEC's live API itself returns no polling units for these
wards.** The 2,671-unit deficit reflects data that is absent upstream on INEC's current site — not
records dropped during scraping. The 2026-05-16 snapshot already had these wards empty and they
remain empty on 2026-06-20, so the condition is stable, not a transient AJAX miss.

**Bottom line:** the gap cannot be closed by re-scraping the current INEC site. The 174,175 scraped
PUs are confirmed complete relative to what INEC currently publishes; the remaining ~1.51% exists only
in the 2023 report's aggregate counts and would need one of the alternative sources in §7.5 to recover.

*Sections 1–7 generated by analysis of the committed INEC report against the existing scrape; §8 records
the live re-scrape executed 2026-06-20. No real polling-unit records were invented or altered.*
