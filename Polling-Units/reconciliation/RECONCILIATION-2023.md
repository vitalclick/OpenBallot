# Polling-Unit Reconciliation — Scraped Data vs. INEC 2023 Report

**Date:** 2026-06-19
**Scraped data:** `Polling-Units/results/` (snapshot scraped 2026-05-16 from `inecnigeria.org`)
**Authoritative reference:** `documents/2023-GENERAL-ELECTION-REPORT.pdf` — *Report of the 2023 General Election*, Independent National Electoral Commission (INEC), published Feb 2024.

Per-state figures: `per-state-reconciliation.csv` · Re-scrape targets: `rescrape-targets.json`

---

## 1. National totals

| Metric | Scraped | INEC Report | Difference |
|---|--:|--:|--:|
| States (incl. FCT) | 37 | 37 | 0 ✅ |
| LGAs | 774 | 774 | 0 ✅ |
| Wards (Registration Areas) | 8,799 | 8,809 | **−10** |
| Polling Units | 174,175 | 176,846 | **−2,671 (−1.51%)** |

Report figures cross-checked against three independent tables in the PDF that all agree:
Table 3.2 (per-state PU comparison 2019 vs 2023), the Ch. 9 per-state RA table, and Table 12.1
(zonal delimitation). The report's per-state PU figures sum exactly to its stated 176,846 total;
the scraped per-state figures sum exactly to 174,175 — so neither side has an internal arithmetic
error. **The gap is real missing data in the scrape, not a counting artifact.**

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

**(a) Empty wards** — a ward node was created but its polling-unit list came back empty
(pagination/AJAX miss). 87 wards. Worst: Ekiti (15), Katsina (11), Kebbi (9), Akwa Ibom (7), Niger (7).

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

1. **Run `--gap`** once INEC's endpoints are reachable to recover the 2,671 missing units.
2. **Investigate Borno separately** — its 10 missing wards look structural (whole RAs absent
   from the site listing), so confirm they exist on INEC's site rather than assuming a fetch error.
3. **Add a validation gate to the full scrape** — fail/retry any ward returning 0 PUs, and assert
   per-state PU totals against `report-baseline.json` before declaring a state complete.
4. Optionally **capture registered-voter counts** per PU/ward during scraping to enable a turnout/
   voter reconciliation against the report in future.

*Generated by analysis of the committed INEC report against the existing scrape. No scraper code or
results were modified.*
