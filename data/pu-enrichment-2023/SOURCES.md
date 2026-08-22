# Polling-unit enrichment — 2023 (CCIJ)

Derived from the **Center for Collaborative Investigative Journalism (CCIJ)**
analysis of Nigeria's 2023 general election, published at
[`vitalclick/Nigeria-2023-election`](https://github.com/vitalclick/Nigeria-2023-election).

Licensing and attribution for this data were agreed with CCIJ before it was
loaded. Any figure derived from it must be attributed to CCIJ wherever it is
published — the API, the map, and any page that renders it.

CCIJ's dataset is itself built on three upstreams they credit, and the
attribution carries through:

- crowdsourced document collection by civic activist **Mark Essien**, who
  downloaded EC8A scans from IReV in March 2023
- **registered-voter data** originally published by INEC in early 2023 and
  later withdrawn from their platform
- **LGA-level results** obtained from INEC under a Freedom of Information Act
  request, answered eight months later

## Files

Both are derived from the CCIJ source by selecting the columns we use; no
value is recomputed, corrected or interpolated.

| File | Rows | From |
|---|--:|---|
| `pu_roster.csv` | 176,846 | `AllPollingUnitsInfo.csv` |
| `pu_results_2023.csv` | 176,846 | `voter_info.csv` |

`pu_roster.csv` columns: `polling_unit_code`, `status`, `state_name`,
`lga_name`, `ward_name`, `unit_name`, `lat`, `lng`, `document_slug`.

`document_slug` is the DocumentCloud path segment; the full URL is
`https://www.documentcloud.org/documents/{document_slug}`. Stored as the slug
rather than the URL because the 40-character prefix is identical on every row.
169,328 of 176,846 polling units (95.7%) have one.

> **Unverified:** DocumentCloud reachability has not been confirmed from a
> normal network. Check before depending on the mirror.

`pu_results_2023.csv` columns: `polling_unit_code`, `status`,
`Registered_num`, `Accredited_num`, `APC`, `PDP`, `LP`, `NNPP`, `total_use`.

Polling-unit codes are in INEC's slash form (`SS/LL/WW/PPP`); loaders
normalise to the bare `delim` form (`SS-LL-WW-PPP`) that `pu_code` uses.

## What this data closed

Loaded with `scripts/load_pu_enrichment.py` (migration 0017). After the load
the registry matches every count INEC publishes in
`documents/2023-GENERAL-ELECTION-REPORT.pdf`:

| Metric | Before | After | INEC report |
|---|--:|--:|--:|
| States | 37 | 37 | 37 |
| LGAs | 773 | **774** | 774 |
| Wards | 8,712 | **8,809** | 8,809 |
| Polling units | 174,175 | **176,846** | 176,846 |
| Registered voters | — | 93,299,647 | 93,469,008 |

The LGA is Borno / Abadam, whose polling units INEC's own roster omits
entirely — see `Polling-Units/reconciliation/RECONCILIATION-2023.md`.

Registered voters land 169,361 (0.18%) below INEC's published total. The
shortfall is in the source and is **not** smoothed over: the loader writes the
counts it is given and nothing else.

## Accuracy, and what this data may not be used for

CCIJ measure **~85% document-level OCR accuracy**: of 10,000 sampled
documents, 8,841 passed their three validation methods, and 247 of those were
later found wrong against crowdsourced ground truth. Over 96% of all papers
were ultimately resolved once crowdsourcing filled the remainder.

That is sound for baselining, anomaly detection and research. It is **not**
sound for presentation as authoritative results.

Accordingly:

- Every row loaded from here carries `source = 'ccij_2023'`, never
  `inec_scrape`, and results derived from it must never carry the
  `inec_published` verification status. INEC did not publish these.
- Coordinates carry `geog_precision`. 20,542 polling units (11.6% of those
  mapped) sit on a point shared with another polling unit, because co-located
  units resolve to one position in the source. Those are `shared_site` and
  the hard geofence does not act on them. See migration 0017.
- 320 polling units have no usable coordinate: 256 blank, 64 outside
  Nigeria's bounding box. Rejected rather than loaded, and reported by the
  loader's `--report` flag.

## Regenerating

The two files are a column-selection over the CCIJ source. To rebuild them,
clone `vitalclick/Nigeria-2023-election` and select the columns listed above
from `AllPollingUnitsInfo.csv` and `voter_info.csv`, converting the `URL`
column to `document_slug` by stripping the DocumentCloud prefix.

## Not loaded from here

- **Accredited voters and party tallies** in `pu_results_2023.csv` are facts
  about one election, not about a polling unit. They belong to the
  per-election baseline, not the election-agnostic registry.
- **`status`** is CCIJ's per-document condition classification (`blurred`,
  `wrong_election`, `collation_paper`, `ec40g`, and so on). Retained here as
  labelled data for form classification; not consumed by the registry loader.
