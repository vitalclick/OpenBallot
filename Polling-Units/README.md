# INEC Polling Units Scraper

Scrapes all **176,846 polling units** in Nigeria from INEC's official API.

**Flow:** Select State → LGA → Ward → Returns Polling Units

## How It Works

Instead of using browser automation (Puppeteer), this scraper calls INEC's PHP API endpoints directly via HTTP. The INEC website at `inecnigeria.org/polling-units/` loads its dropdown data from these backend endpoints:

| Step | Endpoint | Method | Parameters |
|------|----------|--------|------------|
| 1. Get States | `getPollingState.php` | GET | — |
| 2. Get LGAs | `lgaView.php` | POST | `state_id` |
| 3. Get Wards | `wardView.php` | POST | `state_id`, `lga_id` |
| 4. Get Polling Units | `pollingView.php` | POST | `state_id`, `lga_id`, `ward_id` |

## Quick Start

```bash
# No npm install needed — zero dependencies (uses Node.js built-in https)

# Scrape all 37 states (resumes automatically if interrupted)
node scraper.js

# Scrape a single state
node scraper.js --state "Lagos"
node scraper.js --state "Kano"

# Test which API base URL is working
node scraper.js --detect-only

# Clear progress and start fresh
node scraper.js --reset

# Re-scrape ONLY the wards the full scrape missed, then refresh the
# reconciliation annotations and rebuild all-polling-units.json
node scraper.js --gap                 # all flagged states
node scraper.js --gap --state "Borno" # one state

# Offline: refresh reconciliation annotations from the INEC report
# baseline (no network requests)
node scraper.js --reconcile
```

## Reconciliation against the INEC 2023 report

The scrape is validated against the official figures in
`documents/2023-GENERAL-ELECTION-REPORT.pdf` (526-page INEC report). See
[`reconciliation/RECONCILIATION-2023.md`](reconciliation/RECONCILIATION-2023.md)
for the full analysis. In short, the scrape captured 174,175 of the report's
176,846 polling units (−2,671), with gaps in 20 states caused by 87 wards that
returned zero polling units and 10 wards entirely absent in Borno.

- `reconciliation/report-baseline.json` — the report's authoritative per-state
  LGA/ward/PU/registered-voter counts (the source of truth for annotations).
- `reconciliation/rescrape-targets.json` — exactly which wards `--gap` should refetch.
- `reconciliation/per-state-reconciliation.csv` — full per-state comparison.

`--gap` refetches **only** those flagged wards and merges real records into the
existing per-state files (it never fabricates records and never touches records
already present); `--reconcile` recomputes the annotations offline. Each state
file carries a `summary.reconciliation` block (`status`, gaps, `empty_wards_in_scrape`),
and zero-PU wards are tagged with `"reconciliation_flag": "no_polling_units_in_scrape"`.

**Requirements:** Node.js >= 18.0.0

## Features

- **Zero dependencies** — uses only Node.js built-in modules (`https`, `fs`, `path`)
- **Direct API calls** — no Puppeteer/browser needed, 10x faster than the old approach
- **Auto-detects API URL** — INEC changes their WordPress theme URL periodically; the scraper tries multiple known base URLs
- **Resume capability** — saves progress after each state; re-run to continue where you left off
- **Incremental saves** — each state saved as a separate JSON file immediately after scraping
- **Retry with exponential backoff** — retries failed requests up to 4 times (2s, 4s, 8s, 16s delays)
- **Concurrency control** — max 5 parallel requests with 800ms delay between them
- **Rate limiting** — respectful of INEC's servers
- **Failure tracking** — all failed requests logged with timestamps in summary.json
- **Merged output** — generates both per-state files and a single `all-polling-units.json`

## Output Structure

```
results/
├── abia.json                  # Per-state file with full hierarchy
├── adamawa.json
├── ...
├── lagos.json
├── ...
├── zamfara.json
├���─ summary.json               # Scrape metadata, totals, failures
└── all-polling-units.json     # Flat list of all 176,846 polling units
```

### Per-State File Format

```json
{
  "state_id": "25",
  "state_name": "Lagos",
  "summary": { "lgas": 20, "wards": 245, "polling_units": 9532 },
  "lgas": [
    {
      "lga_id": "1",
      "lga_name": "Alimosho",
      "wards": [
        {
          "ward_id": "01",
          "ward_name": "Ayobo 1",
          "polling_units": [
            {
              "pu_id": "001",
              "pu_code": "25/01/01/001",
              "pu_name": "Open Space, Beside Mosque, Ayobo",
              "delim": "",
              "registration_area": ""
            }
          ],
          "polling_unit_count": 15
        }
      ]
    }
  ]
}
```

### Merged File Format (`all-polling-units.json`)

```json
[
  {
    "state": "Lagos",
    "state_id": "25",
    "lga": "Alimosho",
    "lga_id": "1",
    "ward": "Ayobo 1",
    "ward_id": "01",
    "pu_code": "25/01/01/001",
    "pu_name": "Open Space, Beside Mosque, Ayobo",
    "pu_id": "001",
    "delim": ""
  }
]
```

## Running Tests

```bash
# Run all 36 tests
node --test test/scraper.test.js

# Verbose output
node --test --test-reporter=spec test/scraper.test.js
```

Tests cover:
- Utility functions (`objectToArray`, `toKebabCase`, `encodeFormData`)
- Scraper class initialization
- Concurrency control
- Progress save/load/clear/resume
- State result saving
- Summary generation with correct totals
- Merge logic across multiple state files
- Retry and failure tracking
- Config validation
- Full pipeline integration (scrape → save → merge)

## Configuration

Edit `config.js` to adjust:

| Setting | Default | Description |
|---------|---------|-------------|
| `MAX_CONCURRENT` | 5 | Max parallel HTTP requests |
| `RETRY_ATTEMPTS` | 4 | Retries per failed request |
| `RETRY_BASE_DELAY_MS` | 2000 | Base delay for exponential backoff |
| `DELAY_BETWEEN_REQUESTS_MS` | 800 | Delay between requests |
| `REQUEST_TIMEOUT_MS` | 30000 | HTTP request timeout |

## Troubleshooting

**"Could not find a working INEC API base URL"**
INEC periodically changes their WordPress theme, which changes the API URL path. Visit `https://www.inecnigeria.org/polling-units/`, open browser DevTools → Network tab, select a state from the dropdown, and look for the XHR request URL. Update `BASE_URLS` in `config.js` with the new theme path.

**Slow scraping**
Increase `MAX_CONCURRENT` in `config.js` (be respectful — don't exceed 10).

**Many failures**
The INEC server may be under load. Decrease `MAX_CONCURRENT` and increase `DELAY_BETWEEN_REQUESTS_MS`.

## Old Scraper

The previous `scrape_polling_units.js` used Puppeteer (headless browser) to navigate the INEC CVR portal. That approach was:
- Slow (browser rendering for every dropdown selection)
- Fragile (dependent on exact DOM selectors)
- Resource-heavy (full Chromium instance)
- Unable to resume after crashes

The new scraper replaces it entirely with direct API calls.
