#!/usr/bin/env node

/**
 * INEC Nigeria Polling Units Scraper
 *
 * Scrapes all 176,846 polling units via INEC's PHP API endpoints.
 * Flow: States -> LGAs -> Wards -> Polling Units
 *
 * Usage:
 *   node scraper.js                     # Scrape all states (resumes from progress)
 *   node scraper.js --state "Lagos"     # Scrape a single state
 *   node scraper.js --reset             # Clear progress and start fresh
 *   node scraper.js --gap               # Re-scrape ONLY the wards the full
 *                                       # scrape missed (from reconciliation/
 *                                       # rescrape-targets.json), merging into
 *                                       # existing per-state files
 *   node scraper.js --gap --state Borno # Gap re-scrape for one state
 *   node scraper.js --reconcile         # Offline: refresh reconciliation
 *                                       # annotations from the report baseline
 *                                       # (no network requests)
 *   node scraper.js --detect-only       # Only detect working API base URL
 *   node scraper.js --probe             # One-shot states->LGAs->wards->PUs
 *                                       # diagnostic; writes results/probe.json
 *   node scraper.js --debug             # Print every request URL + sample
 *                                       # response (use with --probe or --state)
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const config = require("./config");

// Provenance string stamped onto every reconciliation block.
const REPORT_SOURCE =
  "documents/2023-GENERAL-ELECTION-REPORT.pdf — INEC, Report of the 2023 General " +
  "Election (Feb 2024). Counts from Table 3.2 (PUs & registered voters) and the " +
  "Chapter 9 per-state RA/LGA table; cross-checked against Table 12.1.";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toKebabCase(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * INEC's PHP endpoints return objects with numeric keys instead of arrays.
 * e.g. { "0": {"s_name":"ABIA"}, "1": {"s_name":"ADAMAWA"} }
 * The numeric keys are the IDs used by subsequent API calls.
 * This converts them to arrays while injecting each key as `_key`.
 */
function objectToArray(obj) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== "object") return [];
  const keys = Object.keys(obj);
  if (keys.length === 0) return [];
  const allNumeric = keys.every((k) => /^\d+$/.test(k));
  if (allNumeric) {
    return keys
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => {
        const item = obj[k];
        if (item && typeof item === "object" && !Array.isArray(item)) {
          return { _key: k, ...item };
        }
        return item;
      });
  }
  return Object.values(obj);
}

function buildQueryString(params) {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null
  );
  if (entries.length === 0) return "";
  return (
    "?" +
    entries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&")
  );
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ─── HTTP Client ──────────────────────────────────────────────────────────────

function httpGet(url, { headers = {}, timeout = config.REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const transport = urlObj.protocol === "https:" ? https : http;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      headers: {
        "User-Agent": config.HEADERS["User-Agent"],
        Accept: config.HEADERS.Accept,
        "Accept-Language": config.HEADERS["Accept-Language"],
        Referer: config.HEADERS.Referer,
        ...headers,
      },
      timeout,
      rejectUnauthorized: false,
    };

    const req = transport.request(options, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        return httpGet(redirectUrl, { headers, timeout }).then(resolve, reject);
      }

      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, data, headers: res.headers });
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timeout after ${timeout}ms`));
    });
    req.end();
  });
}

// ─── Scraper Class ────────────────────────────────────────────────────────────

class INECPollingUnitsScraper {
  constructor({ debug = false } = {}) {
    this.baseUrl = null;
    this.useAltPollingEndpoint = false;
    this.debug = debug;
    this.failures = [];
    this.stats = {
      states: 0,
      lgas: 0,
      wards: 0,
      pollingUnits: 0,
      startTime: null,
    };
  }

  // Debug logger - prints when --debug is on. Used by fetchWithRetry to
  // surface the exact URL and response shape so an empty scrape (the
  // 2026-04-17 failure mode) shows itself in one line per call.
  _log(...args) {
    if (this.debug) console.log("  [debug]", ...args);
  }

  // ── Auto-Discover Theme URL ───────────────────────────────────────────────

  async discoverThemeUrl() {
    console.log("  Auto-discovering INEC WordPress theme...");
    try {
      const res = await httpGet("https://www.inecnigeria.org/polling-units/", {
        timeout: 20000,
      });

      const themes = new Set();

      // Pattern 1: absolute URLs with theme path
      const absRegex =
        /https?:\/\/[^"'\s]*?inecnigeria\.org\/wp-content\/themes\/([^/"'\s]+)\//gi;
      let match;
      while ((match = absRegex.exec(res.data)) !== null) {
        themes.add(match[1]);
      }

      // Pattern 2: relative URLs (/wp-content/themes/...)
      const relRegex =
        /["'\/]wp-content\/themes\/([^/"'\s]+)\//gi;
      while ((match = relRegex.exec(res.data)) !== null) {
        themes.add(match[1]);
      }

      // Pattern 3: look for AJAX/API endpoint URLs in inline scripts
      const ajaxRegex =
        /["']([^"']*(?:getPollingState|lgaView|wardView|pollingView|unitView)[^"']*\.php)["']/gi;
      const ajaxUrls = [];
      while ((match = ajaxRegex.exec(res.data)) !== null) {
        ajaxUrls.push(match[1]);
      }

      if (themes.size > 0) {
        const themeNames = [...themes];
        console.log(`  Discovered theme(s): ${themeNames.join(", ")}`);
        const urls = themeNames.map(
          (t) =>
            `https://www.inecnigeria.org/wp-content/themes/${t}/custom/views`
        );
        // Also add any direct AJAX URLs found (strip filename to get base)
        for (const ajaxUrl of ajaxUrls) {
          const base = ajaxUrl.replace(/\/[^/]+\.php$/, "");
          const fullBase = base.startsWith("http")
            ? base
            : `https://www.inecnigeria.org${base.startsWith("/") ? "" : "/"}${base}`;
          if (!urls.includes(fullBase)) urls.push(fullBase);
        }
        return urls;
      }

      if (ajaxUrls.length > 0) {
        console.log(`  Found API URLs in page: ${ajaxUrls.join(", ")}`);
        return ajaxUrls.map((u) => {
          const base = u.replace(/\/[^/]+\.php$/, "");
          return base.startsWith("http")
            ? base
            : `https://www.inecnigeria.org${base.startsWith("/") ? "" : "/"}${base}`;
        });
      }

      console.log("  No theme URLs found in page HTML");
    } catch (err) {
      console.log(`  Auto-discovery failed: ${err.message}`);
    }
    return [];
  }

  // ── API Base URL Detection ────────────────────────────────────────────────

  async detectBaseUrl() {
    console.log("Detecting working INEC API base URL...\n");

    // First: try auto-discovering from the live site
    const discoveredUrls = await this.discoverThemeUrl();

    // Combine discovered + fallback URLs, deduplicating
    const allUrls = [...new Set([...discoveredUrls, ...config.BASE_URLS])];

    for (const baseUrl of allUrls) {
      const url = `${baseUrl}/${config.ENDPOINTS.states}`;
      try {
        const res = await httpGet(url, { timeout: 15000 });
        let parsed;
        try {
          parsed = JSON.parse(res.data);
        } catch {
          console.log(`  Tried: ${baseUrl}`);
          console.log(`  Result: Response is not JSON: ${res.data.slice(0, 150)}\n`);
          continue;
        }
        const states = objectToArray(parsed);
        if (states.length > 0) {
          // Accept any response with state-like objects
          const first = states[0];
          if (first.code || first.id || first.state_id || first.s_name || first.name) {
            console.log(`  Working base URL: ${baseUrl}`);
            console.log(`  States found: ${states.length}`);
            console.log(`  Sample: ${JSON.stringify(first).slice(0, 200)}\n`);
            this.baseUrl = baseUrl;
            return states;
          }
          console.log(`  Tried: ${baseUrl}`);
          console.log(`  Result: Got ${states.length} items but unexpected format:`);
          console.log(`  Sample: ${JSON.stringify(first).slice(0, 200)}\n`);
        } else {
          console.log(`  Tried: ${baseUrl}`);
          console.log(`  Result: Empty response\n`);
        }
      } catch (err) {
        console.log(`  Tried: ${baseUrl}`);
        console.log(`  Result: ${err.message}\n`);
      }
    }

    throw new Error(
      "Could not find a working INEC API base URL.\n" +
        "The INEC website may have changed its WordPress theme or endpoint structure.\n\n" +
        "To fix: open https://www.inecnigeria.org/polling-units/ in your browser,\n" +
        "open DevTools (F12) -> Network tab, select a state from the dropdown,\n" +
        "and look for the XHR request URL. Update BASE_URLS in config.js with the new theme path."
    );
  }

  // ── Fetch with Retry (GET with query params) ─────────────────────────────

  async fetchWithRetry(endpoint, params = {}, label = "") {
    const qs = buildQueryString(params);
    const url = `${this.baseUrl}/${endpoint}${qs}`;
    this._log(`GET ${url}`);

    for (let attempt = 1; attempt <= config.RETRY_ATTEMPTS; attempt++) {
      try {
        const res = await httpGet(url);
        let parsed;
        try {
          parsed = JSON.parse(res.data);
        } catch {
          parsed = res.data;
        }
        const items = objectToArray(parsed);
        this._log(
          `  -> ${label}: ${items.length} items` +
            (items.length === 0
              ? `, raw response: ${String(res.data).slice(0, 200)}`
              : `, sample: ${JSON.stringify(items[0]).slice(0, 200)}`)
        );
        return items;
      } catch (err) {
        if (attempt < config.RETRY_ATTEMPTS) {
          const backoff = config.RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          console.log(
            `    Retry ${attempt}/${config.RETRY_ATTEMPTS} for ${label}: ${err.message} (waiting ${backoff}ms)`
          );
          await delay(backoff);
        } else {
          this.failures.push({
            type: endpoint,
            label,
            params,
            error: err.message,
            timestamp: new Date().toISOString(),
          });
          return [];
        }
      }
    }
    return [];
  }

  // ── Concurrency Limiter ───────────────────────────────────────────────────

  async runWithConcurrency(tasks, concurrency = config.MAX_CONCURRENT) {
    const results = [];
    let index = 0;

    async function worker() {
      while (index < tasks.length) {
        const currentIndex = index++;
        results[currentIndex] = await tasks[currentIndex]();
        await delay(config.DELAY_BETWEEN_REQUESTS_MS);
      }
    }

    const workers = Array.from(
      { length: Math.min(concurrency, tasks.length) },
      () => worker()
    );
    await Promise.all(workers);
    return results;
  }

  // ── Data Fetchers (all use GET with query parameters) ─────────────────────

  async fetchStates() {
    return this.fetchWithRetry(config.ENDPOINTS.states, {}, "states");
  }

  async fetchLGAs(stateId) {
    return this.fetchWithRetry(
      config.ENDPOINTS.lgas,
      { state_id: stateId },
      `LGAs for state ${stateId}`
    );
  }

  async fetchWards(stateId, lgaId) {
    return this.fetchWithRetry(
      config.ENDPOINTS.wards,
      { state_id: stateId, lga_id: lgaId },
      `Wards for LGA ${lgaId}`
    );
  }

  async fetchPollingUnits(stateId, lgaId, wardId) {
    const endpoint = this.useAltPollingEndpoint
      ? config.ENDPOINTS_ALT.pollingUnits
      : config.ENDPOINTS.pollingUnits;

    let results = await this.fetchWithRetry(
      endpoint,
      { state_id: stateId, lga_id: lgaId, ward_id: wardId },
      `PUs for ward ${wardId}`
    );

    if (results.length === 0 && !this.useAltPollingEndpoint) {
      results = await this.fetchWithRetry(
        config.ENDPOINTS_ALT.pollingUnits,
        { state_id: stateId, lga_id: lgaId, ward_id: wardId },
        `PUs for ward ${wardId} (alt)`
      );
      if (results.length > 0) {
        console.log("  Switching to alternate polling units endpoint");
        this.useAltPollingEndpoint = true;
      }
    }

    return results;
  }

  // ── Normalize raw polling-unit objects into our stored shape ──────────────
  // pollingView.php returns {id, state, lga, ward, pu, delim, remark} where
  // `pu` is the human name and `delim` is INEC's hierarchical code
  // (e.g. "01-01-01-001"). We construct a globally-unique pu_code by
  // prefixing with the state name because `delim` repeats across states.
  mapPollingUnits(rawPUs, stateName) {
    return rawPUs.map((pu) => {
      const delim = pu.delim || pu.delimitation || pu.abbreviation || "";
      const constructed = delim ? `${stateName}-${delim}` : "";
      return {
        pu_id: pu.id || pu.pu_id || pu.polling_unit_id,
        pu_code: pu.pu_code || pu.code || pu.polling_unit_code || constructed,
        pu_name:
          pu.pu ||
          pu.name ||
          pu.pu_name ||
          pu.polling_unit ||
          pu.polling_unit_name ||
          "",
        delim,
        registration_area:
          pu.registration_area || pu.registration_area_name || pu.remark || "",
      };
    });
  }

  // ── Progress Management ───────────────────────────────────────────────────

  getProgressPath() {
    return path.join(config.PROGRESS_DIR, "scrape_progress.json");
  }

  loadProgress() {
    try {
      const data = fs.readFileSync(this.getProgressPath(), "utf8");
      return JSON.parse(data);
    } catch {
      return { completedStates: [], inProgress: null };
    }
  }

  saveProgress(progress) {
    ensureDir(config.PROGRESS_DIR);
    fs.writeFileSync(this.getProgressPath(), JSON.stringify(progress, null, 2));
  }

  clearProgress() {
    const p = this.getProgressPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  // ── Extract ID from API response objects ───────────────────────────────────

  extractId(obj, ...fieldNames) {
    for (const f of fieldNames) {
      if (obj[f] !== undefined && obj[f] !== null && obj[f] !== "") return obj[f];
    }
    // Last resort: find the first field that looks like a numeric ID
    for (const [key, val] of Object.entries(obj)) {
      if (typeof val === "number" || (typeof val === "string" && /^\d+$/.test(val))) {
        return val;
      }
    }
    return undefined;
  }

  extractName(obj, ...fieldNames) {
    for (const f of fieldNames) {
      if (obj[f] !== undefined && obj[f] !== null && obj[f] !== "") return obj[f];
    }
    // Last resort: find the first field that looks like a name (non-numeric string)
    for (const [key, val] of Object.entries(obj)) {
      if (typeof val === "string" && val.length > 1 && !/^\d+$/.test(val)) {
        return val;
      }
    }
    return undefined;
  }

  // ── Scrape a Single State ─────────────────────────────────────────────────

  async scrapeState(state) {
    // INEC's getPollingState.php now returns {s_name: "ABIA"} only
    // (no numeric IDs) and lgaView.php expects state_id=<NAME>. So
    // the "id" for downstream calls IS the state name. Keep the
    // numeric-ID fallback for historical compatibility.
    const stateId = this.extractId(
      state, "s_name", "name", "state_name", "code", "id", "state_id",
      "s_id", "value", "state_code", "_key"
    );
    const stateName = this.extractName(
      state, "s_name", "name", "state_name", "state", "label", "text"
    ) || `State-${stateId}`;
    console.log(`\n${"=".repeat(60)}`);
    console.log(`STATE: ${stateName} (ID: ${stateId})`);
    if (stateId === undefined) {
      console.log(`  WARNING: Could not extract state ID from: ${JSON.stringify(state).slice(0, 300)}`);
    }
    console.log("=".repeat(60));

    const stateData = {
      state_id: stateId,
      state_name: stateName,
      lgas: [],
    };

    const rawLGAs = await this.fetchLGAs(stateId);
    if (rawLGAs.length === 0) {
      console.log(`  No LGAs found for ${stateName}`);
      return stateData;
    }
    console.log(`  Found ${rawLGAs.length} LGAs`);
    if (rawLGAs[0]) {
      console.log(`  LGA sample keys: ${Object.keys(rawLGAs[0]).join(", ")}`);
    }

    let statePollingUnitCount = 0;

    for (let i = 0; i < rawLGAs.length; i++) {
      const lga = rawLGAs[i];
      // Same shape change as states: lgaView.php returns {lga: "ABA NORTH"}
      // and wardView.php expects lga_id=<NAME>. Prefer the name as the id.
      const lgaId = this.extractId(
        lga, "lga", "lga_name", "name", "abbreviation", "id", "lga_id",
        "code", "value", "_key"
      );
      const lgaName = this.extractName(
        lga, "lga", "name", "lga_name", "label", "text"
      ) || `LGA-${lgaId}`;
      console.log(`\n  LGA ${i + 1}/${rawLGAs.length}: ${lgaName} (ID: ${lgaId})`);

      const lgaData = {
        lga_id: lgaId,
        lga_name: lgaName,
        wards: [],
      };

      const rawWards = await this.fetchWards(stateId, lgaId);
      if (rawWards.length === 0) {
        console.log(`    No wards found for ${lgaName}`);
        stateData.lgas.push(lgaData);
        continue;
      }
      console.log(`    Found ${rawWards.length} wards`);

      const wardTasks = rawWards.map((ward) => async () => {
        // wardView.php returns {ward: "EZIAMA"}; pollingView.php expects
        // ward_id=<NAME>. Same name-as-id pattern as states + LGAs.
        const wardId = this.extractId(
          ward, "ward", "ward_name", "name", "id", "ward_id",
          "abbreviation", "code", "value", "_key"
        );
        const wardName = this.extractName(
          ward, "ward", "name", "ward_name", "label", "text"
        ) || `Ward-${wardId}`;

        const rawPUs = await this.fetchPollingUnits(stateId, lgaId, wardId);
        const pollingUnits = this.mapPollingUnits(rawPUs, stateName);

        return {
          ward_id: wardId,
          ward_name: wardName,
          polling_units: pollingUnits,
          polling_unit_count: pollingUnits.length,
        };
      });

      const wardResults = await this.runWithConcurrency(wardTasks);

      for (const wardData of wardResults) {
        lgaData.wards.push(wardData);
        statePollingUnitCount += wardData.polling_unit_count;
        this.stats.pollingUnits += wardData.polling_unit_count;
        this.stats.wards++;
      }

      this.stats.lgas++;
      stateData.lgas.push(lgaData);
    }

    this.stats.states++;
    console.log(
      `\n  ${stateName} complete: ${rawLGAs.length} LGAs, ${statePollingUnitCount} polling units`
    );

    return stateData;
  }

  // ── Save State Results ────────────────────────────────────────────────────

  saveStateResult(stateData) {
    ensureDir(config.RESULTS_DIR);
    const filename = `${toKebabCase(stateData.state_name)}.json`;
    const filepath = path.join(config.RESULTS_DIR, filename);

    const lgaCount = stateData.lgas.length;
    let wardCount = 0;
    let puCount = 0;
    for (const lga of stateData.lgas) {
      wardCount += lga.wards.length;
      for (const ward of lga.wards) {
        puCount += ward.polling_units.length;
      }
    }

    const output = {
      state_id: stateData.state_id,
      state_name: stateData.state_name,
      summary: { lgas: lgaCount, wards: wardCount, polling_units: puCount },
      lgas: stateData.lgas,
    };

    fs.writeFileSync(filepath, JSON.stringify(output, null, 2));
    const sizeKB = (fs.statSync(filepath).size / 1024).toFixed(1);
    console.log(`  Saved: ${filename} (${sizeKB} KB)`);
    return { filename, lgas: lgaCount, wards: wardCount, pollingUnits: puCount };
  }

  // ── Save Summary ──────────────────────────────────────────────────────────

  saveSummary(stateResults) {
    ensureDir(config.RESULTS_DIR);

    let totalLGAs = 0;
    let totalWards = 0;
    let totalPUs = 0;

    const states = stateResults.map((s) => {
      totalLGAs += s.lgas;
      totalWards += s.wards;
      totalPUs += s.pollingUnits;
      return s;
    });

    const summary = {
      scraped_at: new Date().toISOString(),
      base_url: this.baseUrl,
      totals: {
        states: states.length,
        lgas: totalLGAs,
        wards: totalWards,
        polling_units: totalPUs,
      },
      duration_seconds: Math.round(
        (Date.now() - this.stats.startTime) / 1000
      ),
      failures: this.failures.length,
      failure_details: this.failures,
      states,
    };

    const filepath = path.join(config.RESULTS_DIR, "summary.json");
    fs.writeFileSync(filepath, JSON.stringify(summary, null, 2));
    console.log(`\nSummary saved: ${filepath}`);
    return summary;
  }

  // ── Merge All State Files into One ────────────────────────────────────────

  mergeResults() {
    ensureDir(config.RESULTS_DIR);
    const files = fs.readdirSync(config.RESULTS_DIR).filter(
      (f) =>
        f.endsWith(".json") &&
        f !== "summary.json" &&
        f !== "all-polling-units.json"
    );

    const allPollingUnits = [];
    for (const file of files) {
      const data = JSON.parse(
        fs.readFileSync(path.join(config.RESULTS_DIR, file), "utf8")
      );
      for (const lga of data.lgas || []) {
        for (const ward of lga.wards || []) {
          for (const pu of ward.polling_units || []) {
            allPollingUnits.push({
              state: data.state_name,
              state_id: data.state_id,
              lga: lga.lga_name,
              lga_id: lga.lga_id,
              ward: ward.ward_name,
              ward_id: ward.ward_id,
              pu_code: pu.pu_code,
              pu_name: pu.pu_name,
              pu_id: pu.pu_id,
              delim: pu.delim,
            });
          }
        }
      }
    }

    const filepath = path.join(config.RESULTS_DIR, "all-polling-units.json");
    fs.writeFileSync(filepath, JSON.stringify(allPollingUnits, null, 2));
    const sizeMB = (fs.statSync(filepath).size / (1024 * 1024)).toFixed(1);
    console.log(
      `\nMerged file: all-polling-units.json (${allPollingUnits.length} polling units, ${sizeMB} MB)`
    );
    return allPollingUnits.length;
  }

  // ── Reconciliation against the INEC 2023 report ───────────────────────────

  loadReportBaseline() {
    try {
      return JSON.parse(fs.readFileSync(config.REPORT_BASELINE_FILE, "utf8"));
    } catch (err) {
      console.log(`  Could not load report baseline: ${err.message}`);
      return { states: {} };
    }
  }

  loadRescrapeTargets() {
    try {
      return JSON.parse(fs.readFileSync(config.RESCRAPE_TARGETS_FILE, "utf8"));
    } catch (err) {
      console.log(`  Could not load rescrape targets: ${err.message}`);
      return { states: [] };
    }
  }

  // Recompute a state's summary counts and its reconciliation block from the
  // current data + the report baseline. Mutates `data` in place. Pure/offline
  // (no network), so it can run standalone via --reconcile.
  buildStateReconciliation(stateKey, data, baseline) {
    let wards = 0;
    let pus = 0;
    const empty = [];
    for (const lga of data.lgas || []) {
      for (const ward of lga.wards || []) {
        wards++;
        const n = (ward.polling_units || []).length;
        pus += n;
        if (n === 0) {
          ward.reconciliation_flag = "no_polling_units_in_scrape";
          empty.push(`${lga.lga_name} / ${ward.ward_name}`);
        } else if (ward.reconciliation_flag) {
          delete ward.reconciliation_flag;
        }
      }
    }
    data.summary = data.summary || {};
    data.summary.lgas = (data.lgas || []).length;
    data.summary.wards = wards;
    data.summary.polling_units = pus;

    const rep = baseline.states && baseline.states[stateKey];
    if (rep) {
      const wardGap = rep.wards - wards;
      data.summary.reconciliation = {
        source: REPORT_SOURCE,
        reconciled_at: new Date().toISOString().slice(0, 10),
        report_lgas: rep.lgas,
        report_wards: rep.wards,
        report_polling_units: rep.polling_units,
        report_registered_voters_2023: rep.registered_voters_2023,
        scraped_lgas: data.summary.lgas,
        scraped_wards: wards,
        scraped_polling_units: pus,
        ward_gap: wardGap,
        polling_unit_gap: rep.polling_units - pus,
        status: wards === rep.wards && pus === rep.polling_units ? "complete" : "incomplete",
        empty_wards_in_scrape: empty,
        wards_absent_from_scrape: Math.max(wardGap, 0),
        note:
          "Report provides authoritative COUNTS only; it contains no individual " +
          "polling-unit records, so missing PU/ward records are flagged, not filled.",
      };
    }
    return { lgas: data.summary.lgas, wards, pollingUnits: pus };
  }

  // Rebuild every state's reconciliation block and the national summary.json
  // reconciliation from the report baseline. Offline; safe to run anytime.
  refreshAllReconciliation(baseline) {
    const files = fs
      .readdirSync(config.RESULTS_DIR)
      .filter(
        (f) =>
          f.endsWith(".json") &&
          f !== "summary.json" &&
          f !== "all-polling-units.json" &&
          f !== "probe.json"
      );

    let totalLGAs = 0;
    let totalWards = 0;
    let totalPUs = 0;
    let emptyWards = 0;
    let absentWards = 0;
    let matching = 0;
    let incomplete = 0;
    const absentStates = [];
    const states = [];

    for (const file of files.sort()) {
      const filepath = path.join(config.RESULTS_DIR, file);
      const data = JSON.parse(fs.readFileSync(filepath, "utf8"));
      const stateKey = file.replace(/\.json$/, "");
      const counts = this.buildStateReconciliation(stateKey, data, baseline);
      fs.writeFileSync(filepath, JSON.stringify(data, null, 2));

      totalLGAs += counts.lgas;
      totalWards += counts.wards;
      totalPUs += counts.pollingUnits;
      const r = data.summary.reconciliation;
      if (r) {
        emptyWards += r.empty_wards_in_scrape.length;
        absentWards += r.wards_absent_from_scrape;
        if (r.wards_absent_from_scrape > 0) absentStates.push(stateKey);
        if (r.status === "complete") matching++;
        else incomplete++;
      }
      states.push({
        filename: file,
        lgas: counts.lgas,
        wards: counts.wards,
        pollingUnits: counts.pollingUnits,
      });
    }

    // Update summary.json, preserving scrape metadata where present.
    const summaryPath = path.join(config.RESULTS_DIR, "summary.json");
    let summary = {};
    try {
      summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    } catch {
      summary = {};
    }
    summary.totals = {
      states: states.length,
      lgas: totalLGAs,
      wards: totalWards,
      polling_units: totalPUs,
    };
    summary.states = states;
    const nat = (baseline._national) || {};
    summary.reconciliation = {
      source: REPORT_SOURCE,
      reconciled_at: new Date().toISOString().slice(0, 10),
      method:
        "Report provides authoritative counts only (no individual PU/ward records). " +
        "Per-state files annotated with report baselines and gap flags; no records fabricated.",
      report_totals: nat,
      scraped_totals: summary.totals,
      gaps: {
        wards: (nat.wards || 0) - totalWards,
        polling_units: (nat.polling_units || 0) - totalPUs,
        polling_units_pct: nat.polling_units
          ? Number((100 * ((nat.polling_units - totalPUs) / nat.polling_units)).toFixed(2))
          : null,
        states_matching_exactly: matching,
        states_incomplete: incomplete,
        empty_wards_in_scrape: emptyWards,
        wards_absent_from_scrape: absentWards,
        wards_absent_states: absentStates,
      },
      details:
        "See Polling-Units/reconciliation/ (RECONCILIATION-2023.md, " +
        "per-state-reconciliation.csv, rescrape-targets.json)",
    };
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    return summary;
  }

  // ── Gap Re-Scrape ─────────────────────────────────────────────────────────
  // Re-fetches ONLY the wards the full scrape missed (zero-PU "empty" wards and
  // wards entirely absent vs. the report), merging real records into the
  // existing per-state files without touching records already present.

  async scrapeGaps({ filterState = null } = {}) {
    this.stats.startTime = Date.now();
    console.log("INEC Polling Units — GAP RE-SCRAPE");
    console.log("==================================\n");

    const targets = this.loadRescrapeTargets();
    const baseline = this.loadReportBaseline();
    let targetStates = targets.states || [];
    if (targetStates.length === 0) {
      console.log("No gap targets found — nothing to re-scrape.");
      console.log("(Run a full scrape + reconciliation first to generate rescrape-targets.json.)");
      return;
    }
    if (filterState) {
      const f = filterState.toLowerCase();
      targetStates = targetStates.filter(
        (t) => (t.state || "").toLowerCase() === f || (t.file || "").replace(/\.json$/, "") === f
      );
      if (targetStates.length === 0) {
        console.log(`No gap target matches state "${filterState}".`);
        return;
      }
    }

    console.log(
      `Targets: ${targetStates.length} state(s), ` +
        `${targetStates.reduce((a, t) => a + (t.empty_wards_count || 0), 0)} empty ward(s), ` +
        `${targetStates.reduce((a, t) => a + (t.missing_wards || 0), 0)} absent ward(s).\n`
    );

    await this.detectBaseUrl();

    const changeLog = [];
    for (const t of targetStates) {
      const filepath = path.join(config.RESULTS_DIR, t.file);
      if (!fs.existsSync(filepath)) {
        console.log(`  Skipping ${t.state}: ${t.file} not found.`);
        continue;
      }
      const data = JSON.parse(fs.readFileSync(filepath, "utf8"));
      const stateName = data.state_name;
      const stateId = data.state_id;
      console.log(`\n${"=".repeat(60)}\nSTATE: ${stateName}\n${"=".repeat(60)}`);

      let filledWards = 0;
      let addedWards = 0;
      let gainedPUs = 0;

      // 1) Refill wards that currently have zero polling units.
      for (const lga of data.lgas) {
        for (const ward of lga.wards) {
          if ((ward.polling_units || []).length > 0) continue;
          const rawPUs = await this.fetchPollingUnits(stateId, lga.lga_id, ward.ward_id);
          const pus = this.mapPollingUnits(rawPUs, stateName);
          if (pus.length > 0) {
            ward.polling_units = pus;
            ward.polling_unit_count = pus.length;
            delete ward.reconciliation_flag;
            filledWards++;
            gainedPUs += pus.length;
            console.log(`  Filled ${lga.lga_name} / ${ward.ward_name}: +${pus.length} PUs`);
          } else {
            console.log(`  Still empty: ${lga.lga_name} / ${ward.ward_name} (API returned 0)`);
          }
        }
      }

      // 2) Discover wards entirely absent from the scrape (e.g. Borno).
      if ((t.missing_wards || 0) > 0) {
        for (const lga of data.lgas) {
          const existing = new Set(lga.wards.map((w) => String(w.ward_id)));
          const rawWards = await this.fetchWards(stateId, lga.lga_id);
          for (const rw of rawWards) {
            const wardId = this.extractId(
              rw, "ward", "ward_name", "name", "id", "ward_id",
              "abbreviation", "code", "value", "_key"
            );
            if (wardId === undefined || existing.has(String(wardId))) continue;
            const wardName =
              this.extractName(rw, "ward", "name", "ward_name", "label", "text") ||
              `Ward-${wardId}`;
            const rawPUs = await this.fetchPollingUnits(stateId, lga.lga_id, wardId);
            const pus = this.mapPollingUnits(rawPUs, stateName);
            const wardObj = {
              ward_id: wardId,
              ward_name: wardName,
              polling_units: pus,
              polling_unit_count: pus.length,
            };
            if (pus.length === 0) wardObj.reconciliation_flag = "no_polling_units_in_scrape";
            lga.wards.push(wardObj);
            addedWards++;
            gainedPUs += pus.length;
            console.log(`  Added absent ward ${lga.lga_name} / ${wardName}: +${pus.length} PUs`);
          }
        }
      }

      const stateKey = t.file.replace(/\.json$/, "");
      this.buildStateReconciliation(stateKey, data, baseline);
      fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
      const status = (data.summary.reconciliation || {}).status || "unknown";
      changeLog.push({ state: stateName, filledWards, addedWards, gainedPUs, status });
      console.log(
        `  ${stateName}: filled ${filledWards} ward(s), added ${addedWards} ward(s), ` +
          `+${gainedPUs} PUs → status: ${status}`
      );
    }

    // Refresh national reconciliation + rebuild the merged export.
    this.refreshAllReconciliation(baseline);
    this.mergeResults();

    const duration = Math.round((Date.now() - this.stats.startTime) / 1000);
    console.log("\n" + "=".repeat(60));
    console.log("GAP RE-SCRAPE COMPLETE");
    console.log("=".repeat(60));
    let totalGained = 0;
    for (const c of changeLog) {
      console.log(
        `  ${c.state}: +${c.gainedPUs} PUs ` +
          `(${c.filledWards} filled, ${c.addedWards} added) [${c.status}]`
      );
      totalGained += c.gainedPUs;
    }
    console.log(`  Total polling units recovered: ${totalGained}`);
    console.log(`  Duration: ${duration}s`);
    if (this.failures.length > 0) {
      console.log(`  Failures: ${this.failures.length}`);
    }
    return changeLog;
  }

  // ── Main Entry Point ──────────────────────────────────────────────────────

  async scrapeAll({ filterState = null, reset = false } = {}) {
    this.stats.startTime = Date.now();
    console.log("INEC Nigeria Polling Units Scraper");
    console.log("==================================\n");

    if (reset) {
      this.clearProgress();
      console.log("Progress cleared. Starting fresh.\n");
    }

    const rawStates = await this.detectBaseUrl();
    console.log(`Total states from API: ${rawStates.length}\n`);

    let statesToScrape = rawStates;
    if (filterState) {
      const filter = filterState.toLowerCase();
      statesToScrape = rawStates.filter((s) => {
        const name = this.extractName(s, "s_name", "name", "state_name", "label") || "";
        const id = this.extractId(s, "code", "id", "state_id", "s_id", "value");
        return name.toLowerCase() === filter ||
          (id !== undefined && id.toString() === filterState.toString());
      });
      if (statesToScrape.length === 0) {
        console.log(`State "${filterState}" not found. Available states:`);
        rawStates.forEach((s) => {
          const name = this.extractName(s, "s_name", "name", "state_name", "label");
          const id = this.extractId(s, "code", "id", "state_id", "s_id", "value");
          console.log(`  - ${name} (ID: ${id})`);
        });
        process.exit(1);
      }
    }

    const progress = this.loadProgress();
    const stateResults = [];

    for (const state of statesToScrape) {
      const stateName = this.extractName(
        state, "s_name", "name", "state_name", "label"
      ) || "Unknown";

      if (!filterState && progress.completedStates.includes(stateName)) {
        console.log(`\nSkipping ${stateName} (already completed)`);
        const filename = `${toKebabCase(stateName)}.json`;
        const filepath = path.join(config.RESULTS_DIR, filename);
        if (fs.existsSync(filepath)) {
          const existing = JSON.parse(fs.readFileSync(filepath, "utf8"));
          let wc = 0;
          let pc = 0;
          for (const lga of existing.lgas || []) {
            wc += lga.wards.length;
            for (const w of lga.wards) pc += w.polling_units.length;
          }
          stateResults.push({
            filename,
            lgas: existing.lgas.length,
            wards: wc,
            pollingUnits: pc,
          });
        }
        continue;
      }

      progress.inProgress = stateName;
      this.saveProgress(progress);

      const stateData = await this.scrapeState(state);
      const result = this.saveStateResult(stateData);
      stateResults.push(result);

      progress.completedStates.push(stateName);
      progress.inProgress = null;
      this.saveProgress(progress);
    }

    const summary = this.saveSummary(stateResults);
    this.mergeResults();

    const duration = Math.round((Date.now() - this.stats.startTime) / 1000);
    const minutes = Math.floor(duration / 60);
    const seconds = duration % 60;

    console.log("\n" + "=".repeat(60));
    console.log("SCRAPE COMPLETE");
    console.log("=".repeat(60));
    console.log(`  States:        ${summary.totals.states}`);
    console.log(`  LGAs:          ${summary.totals.lgas}`);
    console.log(`  Wards:         ${summary.totals.wards}`);
    console.log(`  Polling Units: ${summary.totals.polling_units}`);
    console.log(`  Duration:      ${minutes}m ${seconds}s`);
    console.log(`  Failures:      ${this.failures.length}`);

    if (this.failures.length > 0) {
      console.log("\nFailed requests:");
      this.failures.forEach((f) =>
        console.log(`  - ${f.label}: ${f.error}`)
      );
    }

    return summary;
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function probe(scraper) {
  // One-shot diagnostic that hits states -> first state's LGAs ->
  // first LGA's wards -> first ward's PUs and dumps everything to
  // results/probe.json. Designed for offline debugging when a full
  // scrape silently returned zero (see 2026-04-17 incident).
  console.log("INEC Probe (states -> LGAs -> wards -> polling units)");
  console.log("=====================================================\n");

  const dump = { steps: [] };
  const states = await scraper.detectBaseUrl();
  dump.base_url = scraper.baseUrl;
  dump.states_count = states.length;
  dump.states_sample = states.slice(0, 3);
  console.log(`States: ${states.length}`);
  if (states.length === 0) {
    fs.writeFileSync(
      path.join(config.RESULTS_DIR, "probe.json"),
      JSON.stringify(dump, null, 2)
    );
    throw new Error("No states - INEC endpoint returned empty.");
  }

  const firstState = states[0];
  const stateId = scraper.extractId(
    firstState, "code", "id", "state_id", "s_id", "value", "state_code", "_key"
  );
  const stateName = scraper.extractName(firstState, "s_name", "name", "state_name");
  console.log(`\nProbing state: ${stateName} (id=${stateId})`);
  dump.first_state = { id: stateId, name: stateName, raw: firstState };

  // Try several common parameter spellings + value sources. The
  // historical scraper assumed ?state_id=<numeric_id>; if INEC dropped
  // numeric IDs from the response (the 2026-05 failure mode) we can
  // often unblock by sending the state NAME under a different param key.
  const candidates = [
    { params: { state_id: stateId }, label: "state_id=<id>" },
    { params: { state_id: stateName }, label: "state_id=<name>" },
    { params: { state_name: stateName }, label: "state_name=<name>" },
    { params: { state: stateName }, label: "state=<name>" },
    { params: { s_name: stateName }, label: "s_name=<name>" },
    { params: { code: stateName }, label: "code=<name>" },
    { params: { state_code: stateName }, label: "state_code=<name>" },
  ].filter((c) => Object.values(c.params).every((v) => v !== undefined && v !== null));

  dump.lga_probe_attempts = [];
  let workingLgaParams = null;
  let lgas = [];
  for (const attempt of candidates) {
    console.log(`\n  Trying lgaView.php with ${attempt.label}`);
    const result = await scraper.fetchWithRetry(
      config.ENDPOINTS.lgas,
      attempt.params,
      `LGAs (${attempt.label})`
    );
    dump.lga_probe_attempts.push({
      params: attempt.params,
      label: attempt.label,
      count: result.length,
      sample: result.slice(0, 2),
    });
    if (result.length > 0) {
      console.log(`  ✓ ${result.label || attempt.label} returned ${result.length} LGAs`);
      workingLgaParams = attempt;
      lgas = result;
      break;
    }
  }

  dump.lgas_count = lgas.length;
  dump.lgas_sample = lgas.slice(0, 3);
  dump.working_lga_params = workingLgaParams;
  console.log(`\n  LGAs: ${lgas.length}` +
    (workingLgaParams ? ` (via ${workingLgaParams.label})` : ""));

  if (lgas.length === 0) {
    console.log("\n  All param variations returned empty - INEC's contract");
    console.log("  changed beyond simple renaming. Capture from DevTools:");
    console.log("    1. Open https://www.inecnigeria.org/polling-units/");
    console.log("    2. F12 -> Network -> Fetch/XHR filter");
    console.log("    3. Pick 'ABIA' from the state dropdown");
    console.log("    4. Send me the request URL, method, and request body");
  }

  if (lgas.length > 0) {
    const firstLga = lgas[0];
    const lgaId = scraper.extractId(
      firstLga, "abbreviation", "id", "lga_id", "code", "value", "_key"
    );
    const lgaName = scraper.extractName(firstLga, "name", "lga_name", "label", "text");
    dump.first_lga = { id: lgaId, name: lgaName, raw: firstLga };

    // Build ward params by mirroring whatever worked for LGAs, plus
    // common lga_* spellings.
    const wardCandidates = [
      { params: { ...workingLgaParams.params, lga_id: lgaId }, label: "lga_id=<id>" },
      { params: { ...workingLgaParams.params, lga_id: lgaName }, label: "lga_id=<name>" },
      { params: { ...workingLgaParams.params, lga_name: lgaName }, label: "lga_name=<name>" },
      { params: { ...workingLgaParams.params, lga: lgaName }, label: "lga=<name>" },
      { params: { ...workingLgaParams.params, lga_code: lgaName }, label: "lga_code=<name>" },
    ].filter((c) => Object.values(c.params).every((v) => v !== undefined && v !== null));

    dump.ward_probe_attempts = [];
    let workingWardParams = null;
    let wards = [];
    for (const attempt of wardCandidates) {
      console.log(`\n  Trying wardView.php with ${attempt.label}`);
      const result = await scraper.fetchWithRetry(
        config.ENDPOINTS.wards,
        attempt.params,
        `Wards (${attempt.label})`
      );
      dump.ward_probe_attempts.push({
        params: attempt.params,
        label: attempt.label,
        count: result.length,
        sample: result.slice(0, 2),
      });
      if (result.length > 0) {
        workingWardParams = attempt;
        wards = result;
        break;
      }
    }

    dump.wards_count = wards.length;
    dump.wards_sample = wards.slice(0, 3);
    dump.working_ward_params = workingWardParams;
    console.log(`  Wards: ${wards.length}` +
      (workingWardParams ? ` (via ${workingWardParams.label})` : ""));

    if (wards.length > 0) {
      const firstWard = wards[0];
      const wardId = scraper.extractId(
        firstWard, "id", "ward_id", "abbreviation", "code", "value", "_key"
      );
      const wardName = scraper.extractName(firstWard, "name", "ward_name");
      dump.first_ward = { id: wardId, name: wardName, raw: firstWard };

      const puCandidates = [
        { params: { ...workingWardParams.params, ward_id: wardId }, label: "ward_id=<id>" },
        { params: { ...workingWardParams.params, ward_id: wardName }, label: "ward_id=<name>" },
        { params: { ...workingWardParams.params, ward_name: wardName }, label: "ward_name=<name>" },
        { params: { ...workingWardParams.params, ward: wardName }, label: "ward=<name>" },
        { params: { ...workingWardParams.params, ward_code: wardName }, label: "ward_code=<name>" },
      ].filter((c) => Object.values(c.params).every((v) => v !== undefined && v !== null));

      dump.pu_probe_attempts = [];
      let workingPuParams = null;
      let pus = [];
      for (const attempt of puCandidates) {
        console.log(`\n  Trying pollingView.php with ${attempt.label}`);
        const result = await scraper.fetchWithRetry(
          config.ENDPOINTS.pollingUnits,
          attempt.params,
          `PUs (${attempt.label})`
        );
        dump.pu_probe_attempts.push({
          params: attempt.params,
          label: attempt.label,
          count: result.length,
          sample: result.slice(0, 2),
        });
        if (result.length > 0) {
          workingPuParams = attempt;
          pus = result;
          break;
        }
      }
      dump.pus_count = pus.length;
      dump.pus_sample = pus.slice(0, 3);
      dump.working_pu_params = workingPuParams;
      console.log(`  PUs: ${pus.length}` +
        (workingPuParams ? ` (via ${workingPuParams.label})` : ""));
    }
  }

  ensureDir(config.RESULTS_DIR);
  const dumpPath = path.join(config.RESULTS_DIR, "probe.json");
  fs.writeFileSync(dumpPath, JSON.stringify(dump, null, 2));
  console.log(`\nDiagnostic dump written to ${dumpPath}`);

  if (dump.working_lga_params && dump.working_ward_params && dump.working_pu_params) {
    console.log("\n✓ Full chain works. Send me probe.json and I'll patch the");
    console.log("  scraper's static param names to match.");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const debug = args.includes("--debug");
  const scraper = new INECPollingUnitsScraper({ debug });

  const stateIndex = args.indexOf("--state");
  const filterState =
    stateIndex !== -1 && args[stateIndex + 1] ? args[stateIndex + 1] : null;
  const reset = args.includes("--reset");
  const detectOnly = args.includes("--detect-only");
  const probeOnly = args.includes("--probe");
  const gapOnly = args.includes("--gap");
  const reconcileOnly = args.includes("--reconcile");

  if (reconcileOnly) {
    try {
      const baseline = scraper.loadReportBaseline();
      const summary = scraper.refreshAllReconciliation(baseline);
      const g = summary.reconciliation.gaps;
      console.log("Reconciliation refreshed from report baseline.");
      console.log(
        `  Scraped ${summary.totals.polling_units} / report ${
          summary.reconciliation.report_totals.polling_units
        } PUs (gap ${g.polling_units}); ` +
          `${g.states_matching_exactly} states complete, ${g.states_incomplete} incomplete.`
      );
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    return;
  }

  if (gapOnly) {
    try {
      await scraper.scrapeGaps({ filterState });
    } catch (err) {
      console.error(`\nGap re-scrape failed: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (detectOnly) {
    try {
      const states = await scraper.detectBaseUrl();
      console.log("States found:");
      states.forEach((s) =>
        console.log(`  ${s.code}: ${s.s_name || s.name}`)
      );
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    return;
  }

  if (probeOnly) {
    try {
      await probe(scraper);
    } catch (err) {
      console.error(`\nProbe failed: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  try {
    await scraper.scrapeAll({ filterState, reset });
  } catch (err) {
    console.error(`\nFatal error: ${err.message}`);
    console.error(
      "The scraper saves progress automatically. Re-run to resume.\n"
    );
    process.exit(1);
  }
}

// Export for testing
module.exports = {
  INECPollingUnitsScraper,
  objectToArray,
  toKebabCase,
  buildQueryString,
  REPORT_SOURCE,
};

if (require.main === module) {
  main();
}
