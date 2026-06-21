# 2023 General Election — official results (extracted from the INEC report)

These files are produced by [`scripts/extract_2023_results.py`](../../scripts/extract_2023_results.py)
from `documents/2023-GENERAL-ELECTION-REPORT.pdf` — *Report of the 2023 General
Election*, Independent National Electoral Commission (INEC), Feb 2024, the same
526-page document the polling-unit scrape is reconciled against (see
[`Polling-Units/reconciliation/RECONCILIATION-2023.md`](../../Polling-Units/reconciliation/RECONCILIATION-2023.md)).

Regenerate with:

```bash
git checkout origin/main -- documents/2023-GENERAL-ELECTION-REPORT.pdf   # PDF lives on main
python scripts/extract_2023_results.py
```

Load into Postgres (after the geography is loaded — see `scripts/load_polling_units.py`):

```bash
DATABASE_URL=postgresql://... python scripts/load_2023_results.py
```

## What the report does and does not contain

The report carries results at three grains. This is **all** the machine-readable
results data in the document — nothing here is invented or interpolated.

| File | Source in report | Grain |
|---|---|---|
| `presidential_national.json` | Annexure 2 (printed p418) | **National** totals, all 18 candidates + turnout |
| `declared_winners.csv` | Annexures 3–6 (p458–523) | **Winning party** per constituency (1,490 seats) |
| `state_registration.csv` | Table 8.9 (p153–154) | Registered voters per state, by gender |

**Not in the report, so not here:**
- Per-state / per-LGA / per-constituency **vote tallies** — only the *winning
  party* is published for the legislative and governorship races, and the
  presidential tally exists **only at national level** (no per-state breakdown).
- Any **per-polling-unit** results — those live in INEC IReV, not this PDF.

## Provenance notes & known source-document issues

- **Presidential (`presidential_national.json`)** — Annexure 2 is an
  infographic **image**, not selectable text, so its 18 vote figures and the
  turnout box are transcribed by hand in the extractor and **checksummed**: the
  18 votes sum exactly to the report's stated valid-vote total (24,025,940).
- **Declared winners** are parsed from the annexure tables. Rows are keyed by a
  stable per-race sequence (`seq`, printed order) rather than the INEC
  constituency code, because the printed codes contain a few **source typos**
  that the extractor does **not** silently rewrite:
  - `SC/252/DT` is printed twice (the row for S/N 251, Ethiope East, should read
    `SC/251/DT`); both rows are retained with correct state/party.
  - A handful of codes were OCR-mangled (`/SC/20AB`, `SC/076GM`, `SC/762OD`) —
    only the missing/`/`-misplaced separators are normalised.
  - One state-assembly row (`SC/24/AB`, Umuahia East area) has **no party
    printed** in the source; `party_code` is left blank rather than guessed.
  - One reps party cell reads `PC`, an unambiguous OCR error for `APC`
    (no party named "PC" is registered); corrected in extraction.
- Winning-party seat totals reproduce the official as-declared composition
  (e.g. Senate APC 59 / PDP 36 / LP 8; Governorship APC 17 / PDP 9 / LP 1 /
  NNPP 1), a strong cross-check that the parse is faithful. Figures are
  *as declared in the report* and predate later tribunal/supplementary changes.
