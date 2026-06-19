const path = require("path");

module.exports = {
  // Fallback base URLs tried when auto-discovery fails.
  // The scraper first fetches the INEC polling-units page and parses
  // the current theme from CSS/JS links in the HTML.
  BASE_URLS: [
    "https://www.inecnigeria.org/wp-content/themes/rishi/custom/views",
    "https://www.inecnigeria.org/wp-content/themes/independent-national-electoral-commission/custom/views",
  ],

  ENDPOINTS: {
    states: "getPollingState.php",
    lgas: "lgaView.php",
    wards: "wardView.php",
    pollingUnits: "pollingView.php",
  },

  ENDPOINTS_ALT: {
    pollingUnits: "unitView.php",
  },

  MAX_CONCURRENT: 5,
  RETRY_ATTEMPTS: 4,
  RETRY_BASE_DELAY_MS: 2000,
  DELAY_BETWEEN_REQUESTS_MS: 800,
  REQUEST_TIMEOUT_MS: 30000,

  RESULTS_DIR: path.join(__dirname, "results"),
  PROGRESS_DIR: path.join(__dirname, "progress"),
  RECONCILIATION_DIR: path.join(__dirname, "reconciliation"),

  // Gap re-scrape inputs (see reconciliation/RECONCILIATION-2023.md).
  // RESCRAPE_TARGETS lists the wards the scrape missed; REPORT_BASELINE holds
  // the INEC report's authoritative per-state counts used to refresh the
  // reconciliation annotations after a gap fill.
  RESCRAPE_TARGETS_FILE: path.join(__dirname, "reconciliation", "rescrape-targets.json"),
  REPORT_BASELINE_FILE: path.join(__dirname, "reconciliation", "report-baseline.json"),

  HEADERS: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    Accept: "application/json, text/html, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://www.inecnigeria.org/polling-units/",
  },
};
