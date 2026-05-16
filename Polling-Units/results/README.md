# Polling-Units/results

Output directory for `scraper.js`. **Contents are gitignored** — the
files are large (~37 MB across 37 state JSONs, plus a ~48 MB merged
`all-polling-units.json`) and fully regenerable from INEC's public
roster at <https://www.inecnigeria.org/>.

## How to regenerate

From the repo root:

```bash
cd Polling-Units
node scraper.js --reset    # fresh scrape, ~60 minutes
# or
node scraper.js            # resumes from progress/scrape_progress.json
```

A clean run produces:

- `<state>.json` — one per state, e.g. `abia.json`, `lagos.json`
- `all-polling-units.json` — merged flat list of every polling unit
- `summary.json` — totals (states / LGAs / wards / PUs) and failure log

Expected national totals (May 2026 INEC roster): **37 states, 774 LGAs,
~8,800 wards, ~174,000 polling units**.

## How the data flows into the database

```
INEC web roster ──scraper.js──> Polling-Units/results/*.json
                                          │
                                          ▼
                  scripts/load_polling_units.py
                                          │
                                          ▼
                      Postgres: states / lgas / wards / polling_units
```

Once loaded, the **database is the source of truth**. Re-scrape only when
INEC publishes a roster update.
