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
    const stateId = this.extractId(
      state, "code", "id", "state_id", "s_id", "value", "state_code", "_key"
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
      const lgaId = this.extractId(
        lga, "abbreviation", "id", "lga_id", "code", "value", "_key"
      );
      const lgaName = this.extractName(
        lga, "name", "lga_name", "label", "text"
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
        const wardId = this.extractId(
          ward, "id", "ward_id", "abbreviation", "code", "value", "_key"
        );
        const wardName = this.extractName(
          ward, "name", "ward_name", "label", "text"
        ) || `Ward-${wardId}`;

        const rawPUs = await this.fetchPollingUnits(stateId, lgaId, wardId);

        const pollingUnits = rawPUs.map((pu) => ({
          pu_id: pu.id || pu.pu_id || pu.polling_unit_id,
          pu_code: pu.code || pu.pu_code || pu.polling_unit_code || "",
          pu_name:
            pu.name ||
            pu.pu_name ||
            pu.polling_unit ||
            pu.polling_unit_name ||
            "",
          delim: pu.delimitation || pu.abbreviation || pu.delim || "",
          registration_area:
            pu.registration_area || pu.registration_area_name || "",
        }));

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

  const lgas = await scraper.fetchLGAs(stateId);
  dump.lgas_count = lgas.length;
  dump.lgas_sample = lgas.slice(0, 3);
  console.log(`  LGAs: ${lgas.length}`);
  if (lgas.length === 0) {
    console.log("  ^ This is the failure point - lgaView.php returned empty.");
    console.log("  Open https://www.inecnigeria.org/polling-units/ in a browser,");
    console.log("  pick this state from the dropdown, watch DevTools Network tab.");
    console.log("  Compare the request the page makes vs. the URL above.");
  }

  if (lgas.length > 0) {
    const firstLga = lgas[0];
    const lgaId = scraper.extractId(
      firstLga, "abbreviation", "id", "lga_id", "code", "value", "_key"
    );
    dump.first_lga = { id: lgaId, raw: firstLga };
    const wards = await scraper.fetchWards(stateId, lgaId);
    dump.wards_count = wards.length;
    dump.wards_sample = wards.slice(0, 3);
    console.log(`  Wards in first LGA: ${wards.length}`);

    if (wards.length > 0) {
      const firstWard = wards[0];
      const wardId = scraper.extractId(
        firstWard, "id", "ward_id", "abbreviation", "code", "value", "_key"
      );
      dump.first_ward = { id: wardId, raw: firstWard };
      const pus = await scraper.fetchPollingUnits(stateId, lgaId, wardId);
      dump.pus_count = pus.length;
      dump.pus_sample = pus.slice(0, 3);
      console.log(`  PUs in first ward: ${pus.length}`);
    }
  }

  ensureDir(config.RESULTS_DIR);
  const dumpPath = path.join(config.RESULTS_DIR, "probe.json");
  fs.writeFileSync(dumpPath, JSON.stringify(dump, null, 2));
  console.log(`\nDiagnostic dump written to ${dumpPath}`);
  if ((dump.lgas_count || 0) === 0 || (dump.pus_count || 0) === 0) {
    console.log(
      "\nNon-zero state count but empty children -> the endpoint shape or " +
        "the id field name probably changed. Send probe.json + the DevTools " +
        "request you captured to update config.js / extractId() field lists."
    );
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
};

if (require.main === module) {
  main();
}
