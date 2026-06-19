const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  INECPollingUnitsScraper,
  objectToArray,
  toKebabCase,
  buildQueryString,
} = require("../scraper");
const config = require("../config");

// ─── Helper Utilities Tests ─────────────────────────────────────────────────

describe("objectToArray", () => {
  it("converts numeric-keyed objects to arrays and injects _key", () => {
    const input = { "0": { name: "A" }, "1": { name: "B" }, "2": { name: "C" } };
    const result = objectToArray(input);
    assert.deepEqual(result, [
      { _key: "0", name: "A" },
      { _key: "1", name: "B" },
      { _key: "2", name: "C" },
    ]);
  });

  it("preserves order by numeric key", () => {
    const input = { "2": { id: 3 }, "0": { id: 1 }, "1": { id: 2 } };
    const result = objectToArray(input);
    assert.deepEqual(result, [
      { _key: "0", id: 1 },
      { _key: "1", id: 2 },
      { _key: "2", id: 3 },
    ]);
  });

  it("preserves numeric keys as state IDs for INEC format", () => {
    const input = { "0": { s_name: "ABIA" }, "1": { s_name: "ADAMAWA" } };
    const result = objectToArray(input);
    assert.equal(result[0]._key, "0");
    assert.equal(result[0].s_name, "ABIA");
    assert.equal(result[1]._key, "1");
    assert.equal(result[1].s_name, "ADAMAWA");
  });

  it("does not inject _key for non-object values", () => {
    const input = { "0": "hello", "1": "world" };
    const result = objectToArray(input);
    assert.deepEqual(result, ["hello", "world"]);
  });

  it("returns arrays as-is", () => {
    const input = [1, 2, 3];
    assert.deepEqual(objectToArray(input), [1, 2, 3]);
  });

  it("returns empty array for null/undefined", () => {
    assert.deepEqual(objectToArray(null), []);
    assert.deepEqual(objectToArray(undefined), []);
    assert.deepEqual(objectToArray(""), []);
  });

  it("returns empty array for empty object", () => {
    assert.deepEqual(objectToArray({}), []);
  });

  it("uses Object.values for non-numeric-keyed objects", () => {
    const input = { name: "Lagos", code: "25" };
    const result = objectToArray(input);
    assert.deepEqual(result, ["Lagos", "25"]);
  });
});

describe("toKebabCase", () => {
  it("converts state names to kebab-case", () => {
    assert.equal(toKebabCase("Lagos"), "lagos");
    assert.equal(toKebabCase("FEDERAL CAPITAL TERRITORY"), "federal-capital-territory");
    assert.equal(toKebabCase("Cross River"), "cross-river");
    assert.equal(toKebabCase("Akwa Ibom"), "akwa-ibom");
  });

  it("handles special characters", () => {
    assert.equal(toKebabCase("Nasarawa (Special)"), "nasarawa-special");
    assert.equal(toKebabCase("State/LGA"), "state-lga");
  });

  it("trims leading/trailing hyphens", () => {
    assert.equal(toKebabCase("  Lagos  "), "lagos");
    assert.equal(toKebabCase("-Lagos-"), "lagos");
  });
});

describe("buildQueryString", () => {
  it("builds query string from params", () => {
    const result = buildQueryString({ state_id: "25", lga_id: "10" });
    assert.equal(result, "?state_id=25&lga_id=10");
  });

  it("handles special characters", () => {
    const result = buildQueryString({ name: "Akwa Ibom" });
    assert.equal(result, "?name=Akwa%20Ibom");
  });

  it("returns empty string for empty params", () => {
    assert.equal(buildQueryString({}), "");
  });

  it("filters out null/undefined values", () => {
    const result = buildQueryString({ state_id: "25", lga_id: null, ward_id: undefined });
    assert.equal(result, "?state_id=25");
  });
});

// ─── Scraper Class Tests ────────────────────────────────────────────────────

describe("INECPollingUnitsScraper", () => {
  let scraper;
  let tempDir;

  beforeEach(() => {
    scraper = new INECPollingUnitsScraper();
    tempDir = path.join(__dirname, `temp-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("constructor", () => {
    it("initializes with null baseUrl", () => {
      assert.equal(scraper.baseUrl, null);
    });

    it("initializes empty failures array", () => {
      assert.deepEqual(scraper.failures, []);
    });

    it("initializes stats counters at 0", () => {
      assert.equal(scraper.stats.states, 0);
      assert.equal(scraper.stats.lgas, 0);
      assert.equal(scraper.stats.wards, 0);
      assert.equal(scraper.stats.pollingUnits, 0);
    });
  });

  describe("runWithConcurrency", () => {
    it("executes all tasks", async () => {
      const results = [];
      const tasks = [1, 2, 3, 4, 5].map(
        (n) => () =>
          new Promise((resolve) => {
            results.push(n);
            resolve(n);
          })
      );

      const output = await scraper.runWithConcurrency(tasks, 2);
      assert.equal(results.length, 5);
      assert.deepEqual(output, [1, 2, 3, 4, 5]);
    });

    it("respects concurrency limit", async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      const tasks = Array.from({ length: 10 }, () => async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 50));
        concurrent--;
        return true;
      });

      await scraper.runWithConcurrency(tasks, 3);
      assert.ok(maxConcurrent <= 3, `Max concurrent was ${maxConcurrent}, expected <= 3`);
    });

    it("handles empty task list", async () => {
      const results = await scraper.runWithConcurrency([]);
      assert.deepEqual(results, []);
    });
  });

  describe("progress management", () => {
    it("loads empty progress when no file exists", () => {
      const originalDir = config.PROGRESS_DIR;
      config.PROGRESS_DIR = tempDir;

      const progress = scraper.loadProgress();
      assert.deepEqual(progress, { completedStates: [], inProgress: null });

      config.PROGRESS_DIR = originalDir;
    });

    it("saves and loads progress", () => {
      const originalDir = config.PROGRESS_DIR;
      config.PROGRESS_DIR = tempDir;

      const progress = {
        completedStates: ["Lagos", "Kano"],
        inProgress: "Ogun",
      };
      scraper.saveProgress(progress);

      const loaded = scraper.loadProgress();
      assert.deepEqual(loaded, progress);

      config.PROGRESS_DIR = originalDir;
    });

    it("clears progress", () => {
      const originalDir = config.PROGRESS_DIR;
      config.PROGRESS_DIR = tempDir;

      scraper.saveProgress({ completedStates: ["Lagos"], inProgress: null });
      scraper.clearProgress();

      const loaded = scraper.loadProgress();
      assert.deepEqual(loaded, { completedStates: [], inProgress: null });

      config.PROGRESS_DIR = originalDir;
    });
  });

  describe("saveStateResult", () => {
    it("saves state data as JSON file", () => {
      const originalDir = config.RESULTS_DIR;
      config.RESULTS_DIR = tempDir;

      const stateData = {
        state_id: "25",
        state_name: "Lagos",
        lgas: [
          {
            lga_id: "1",
            lga_name: "Alimosho",
            wards: [
              {
                ward_id: "01",
                ward_name: "Ayobo 1",
                polling_units: [
                  { pu_id: "001", pu_code: "25/01/01/001", pu_name: "Unit 1", delim: "" },
                  { pu_id: "002", pu_code: "25/01/01/002", pu_name: "Unit 2", delim: "" },
                ],
                polling_unit_count: 2,
              },
            ],
          },
        ],
      };

      const result = scraper.saveStateResult(stateData);

      assert.equal(result.filename, "lagos.json");
      assert.equal(result.lgas, 1);
      assert.equal(result.wards, 1);
      assert.equal(result.pollingUnits, 2);

      const filepath = path.join(tempDir, "lagos.json");
      assert.ok(fs.existsSync(filepath));

      const saved = JSON.parse(fs.readFileSync(filepath, "utf8"));
      assert.equal(saved.state_name, "Lagos");
      assert.equal(saved.summary.polling_units, 2);

      config.RESULTS_DIR = originalDir;
    });
  });

  describe("saveSummary", () => {
    it("generates summary with correct totals", () => {
      const originalDir = config.RESULTS_DIR;
      config.RESULTS_DIR = tempDir;

      scraper.stats.startTime = Date.now() - 5000;
      scraper.baseUrl = "https://example.com";

      const stateResults = [
        { filename: "lagos.json", lgas: 20, wards: 245, pollingUnits: 9532 },
        { filename: "kano.json", lgas: 44, wards: 484, pollingUnits: 15487 },
      ];

      const summary = scraper.saveSummary(stateResults);

      assert.equal(summary.totals.states, 2);
      assert.equal(summary.totals.lgas, 64);
      assert.equal(summary.totals.wards, 729);
      assert.equal(summary.totals.polling_units, 25019);

      const filepath = path.join(tempDir, "summary.json");
      assert.ok(fs.existsSync(filepath));

      config.RESULTS_DIR = originalDir;
    });

    it("includes failure details", () => {
      const originalDir = config.RESULTS_DIR;
      config.RESULTS_DIR = tempDir;

      scraper.stats.startTime = Date.now();
      scraper.baseUrl = "https://example.com";
      scraper.failures = [
        { type: "ward", label: "test", error: "timeout" },
      ];

      const summary = scraper.saveSummary([]);
      assert.equal(summary.failures, 1);
      assert.equal(summary.failure_details[0].error, "timeout");

      config.RESULTS_DIR = originalDir;
    });
  });

  describe("mergeResults", () => {
    it("merges multiple state files into flat polling unit list", () => {
      const originalDir = config.RESULTS_DIR;
      config.RESULTS_DIR = tempDir;

      const lagosData = {
        state_id: "25",
        state_name: "Lagos",
        lgas: [
          {
            lga_id: "1",
            lga_name: "Alimosho",
            wards: [
              {
                ward_id: "01",
                ward_name: "Ayobo 1",
                polling_units: [
                  { pu_id: "001", pu_code: "25/01/01/001", pu_name: "Unit 1", delim: "" },
                ],
              },
            ],
          },
        ],
      };

      const kanoData = {
        state_id: "20",
        state_name: "Kano",
        lgas: [
          {
            lga_id: "2",
            lga_name: "Dala",
            wards: [
              {
                ward_id: "02",
                ward_name: "Kantudu",
                polling_units: [
                  { pu_id: "010", pu_code: "20/02/02/010", pu_name: "Unit 10", delim: "" },
                  { pu_id: "011", pu_code: "20/02/02/011", pu_name: "Unit 11", delim: "" },
                ],
              },
            ],
          },
        ],
      };

      fs.writeFileSync(path.join(tempDir, "lagos.json"), JSON.stringify(lagosData));
      fs.writeFileSync(path.join(tempDir, "kano.json"), JSON.stringify(kanoData));

      const total = scraper.mergeResults();

      assert.equal(total, 3);

      const merged = JSON.parse(
        fs.readFileSync(path.join(tempDir, "all-polling-units.json"), "utf8")
      );
      assert.equal(merged.length, 3);
      const states = merged.map((pu) => pu.state);
      assert.equal(states.filter((s) => s === "Lagos").length, 1);
      assert.equal(states.filter((s) => s === "Kano").length, 2);

      config.RESULTS_DIR = originalDir;
    });

    it("excludes summary.json and all-polling-units.json from merge", () => {
      const originalDir = config.RESULTS_DIR;
      config.RESULTS_DIR = tempDir;

      const stateData = {
        state_id: "1",
        state_name: "Abia",
        lgas: [{
          lga_id: "1",
          lga_name: "Aba North",
          wards: [{
            ward_id: "01",
            ward_name: "Eziama",
            polling_units: [{ pu_id: "1", pu_code: "01/01/01/001", pu_name: "Unit 1", delim: "" }],
          }],
        }],
      };

      fs.writeFileSync(path.join(tempDir, "abia.json"), JSON.stringify(stateData));
      fs.writeFileSync(path.join(tempDir, "summary.json"), JSON.stringify({ test: true }));
      fs.writeFileSync(path.join(tempDir, "all-polling-units.json"), JSON.stringify([]));

      const total = scraper.mergeResults();
      assert.equal(total, 1);

      config.RESULTS_DIR = originalDir;
    });
  });
});

// ─── Reconciliation + Gap Re-Scrape Tests ───────────────────────────────────

describe("buildStateReconciliation", () => {
  let scraper;
  const baseline = {
    _national: { states: 1, lgas: 1, wards: 2, polling_units: 5 },
    states: {
      testland: { lgas: 1, wards: 2, polling_units: 5, registered_voters_2023: 100 },
    },
  };

  beforeEach(() => {
    scraper = new INECPollingUnitsScraper();
  });

  it("computes counts, flags empty wards, and marks status incomplete", () => {
    const data = {
      state_name: "Testland",
      lgas: [
        {
          lga_name: "LGA1",
          lga_id: "LGA1",
          wards: [
            { ward_id: "W1", ward_name: "Ward A", polling_units: [{ pu_id: "1" }, { pu_id: "2" }, { pu_id: "3" }] },
            { ward_id: "W2", ward_name: "Ward B", polling_units: [] },
          ],
        },
      ],
    };

    const counts = scraper.buildStateReconciliation("testland", data, baseline);

    assert.equal(counts.wards, 2);
    assert.equal(counts.pollingUnits, 3);
    assert.equal(data.summary.polling_units, 3);
    const r = data.summary.reconciliation;
    assert.equal(r.report_polling_units, 5);
    assert.equal(r.polling_unit_gap, 2);
    assert.equal(r.status, "incomplete");
    assert.deepEqual(r.empty_wards_in_scrape, ["LGA1 / Ward B"]);
    // empty ward gets flagged in place
    assert.equal(data.lgas[0].wards[1].reconciliation_flag, "no_polling_units_in_scrape");
    // populated ward stays unflagged
    assert.equal(data.lgas[0].wards[0].reconciliation_flag, undefined);
  });

  it("clears the flag and marks complete once counts match the report", () => {
    const data = {
      state_name: "Testland",
      lgas: [
        {
          lga_name: "LGA1",
          lga_id: "LGA1",
          wards: [
            { ward_id: "W1", ward_name: "Ward A", polling_units: [{ pu_id: "1" }, { pu_id: "2" }, { pu_id: "3" }] },
            {
              ward_id: "W2",
              ward_name: "Ward B",
              reconciliation_flag: "no_polling_units_in_scrape",
              polling_units: [{ pu_id: "4" }, { pu_id: "5" }],
            },
          ],
        },
      ],
    };

    scraper.buildStateReconciliation("testland", data, baseline);

    assert.equal(data.summary.polling_units, 5);
    assert.equal(data.summary.reconciliation.status, "complete");
    assert.equal(data.summary.reconciliation.polling_unit_gap, 0);
    assert.equal(data.lgas[0].wards[1].reconciliation_flag, undefined);
  });

  it("skips the reconciliation block for states absent from the baseline", () => {
    const data = {
      state_name: "Unknownland",
      lgas: [{ lga_name: "L", lga_id: "L", wards: [{ ward_id: "W", ward_name: "Wd", polling_units: [{ pu_id: "1" }] }] }],
    };
    scraper.buildStateReconciliation("unknownland", data, baseline);
    assert.equal(data.summary.polling_units, 1);
    assert.equal(data.summary.reconciliation, undefined);
  });
});

describe("scrapeGaps", () => {
  let scraper;
  let tempResults;
  let tempRecon;
  let originalResults;
  let originalTargets;
  let originalBaseline;

  const baseline = {
    _national: { states: 1, lgas: 1, wards: 2, polling_units: 5 },
    states: {
      testland: { lgas: 1, wards: 2, polling_units: 5, registered_voters_2023: 100 },
    },
  };

  beforeEach(() => {
    scraper = new INECPollingUnitsScraper();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    tempResults = path.join(__dirname, `temp-gap-results-${stamp}`);
    tempRecon = path.join(__dirname, `temp-gap-recon-${stamp}`);
    fs.mkdirSync(tempResults, { recursive: true });
    fs.mkdirSync(tempRecon, { recursive: true });

    originalResults = config.RESULTS_DIR;
    originalTargets = config.RESCRAPE_TARGETS_FILE;
    originalBaseline = config.REPORT_BASELINE_FILE;
    config.RESULTS_DIR = tempResults;
    config.RESCRAPE_TARGETS_FILE = path.join(tempRecon, "rescrape-targets.json");
    config.REPORT_BASELINE_FILE = path.join(tempRecon, "report-baseline.json");
    fs.writeFileSync(config.REPORT_BASELINE_FILE, JSON.stringify(baseline));

    // No network during tests.
    scraper.detectBaseUrl = async () => {
      scraper.baseUrl = "https://mock.test";
      return [];
    };
  });

  afterEach(() => {
    config.RESULTS_DIR = originalResults;
    config.RESCRAPE_TARGETS_FILE = originalTargets;
    config.REPORT_BASELINE_FILE = originalBaseline;
    fs.rmSync(tempResults, { recursive: true, force: true });
    fs.rmSync(tempRecon, { recursive: true, force: true });
  });

  it("fills an empty ward and preserves existing records", async () => {
    fs.writeFileSync(
      path.join(tempResults, "testland.json"),
      JSON.stringify({
        state_id: "Testland",
        state_name: "Testland",
        summary: { lgas: 1, wards: 2, polling_units: 3 },
        lgas: [
          {
            lga_id: "LGA1",
            lga_name: "LGA1",
            wards: [
              { ward_id: "W1", ward_name: "Ward A", polling_units: [{ pu_id: "1" }, { pu_id: "2" }, { pu_id: "3" }] },
              { ward_id: "W2", ward_name: "Ward B", reconciliation_flag: "no_polling_units_in_scrape", polling_units: [] },
            ],
          },
        ],
      })
    );
    fs.writeFileSync(
      config.RESCRAPE_TARGETS_FILE,
      JSON.stringify({
        states: [
          { state: "Testland", file: "testland.json", missing_wards: 0, empty_wards_count: 1 },
        ],
      })
    );

    // The empty ward (W2) now returns 2 PUs.
    scraper.fetchPollingUnits = async (stateId, lgaId, wardId) => {
      if (wardId === "W2") {
        return [
          { id: "4", delim: "01-01-02-001", pu: "Unit 4" },
          { id: "5", delim: "01-01-02-002", pu: "Unit 5" },
        ];
      }
      return [];
    };

    const log = await scraper.scrapeGaps();

    const saved = JSON.parse(fs.readFileSync(path.join(tempResults, "testland.json"), "utf8"));
    const wardB = saved.lgas[0].wards[1];
    assert.equal(wardB.polling_units.length, 2);
    assert.equal(wardB.polling_units[0].pu_code, "Testland-01-01-02-001");
    assert.equal(wardB.reconciliation_flag, undefined);
    // existing Ward A records untouched
    assert.equal(saved.lgas[0].wards[0].polling_units.length, 3);
    // counts + status refreshed
    assert.equal(saved.summary.polling_units, 5);
    assert.equal(saved.summary.reconciliation.status, "complete");
    assert.equal(log[0].gainedPUs, 2);

    // merged export rebuilt
    const merged = JSON.parse(fs.readFileSync(path.join(tempResults, "all-polling-units.json"), "utf8"));
    assert.equal(merged.length, 5);
  });

  it("discovers and adds a ward entirely absent from the scrape", async () => {
    fs.writeFileSync(
      path.join(tempResults, "testland.json"),
      JSON.stringify({
        state_id: "Testland",
        state_name: "Testland",
        summary: { lgas: 1, wards: 1, polling_units: 3 },
        lgas: [
          {
            lga_id: "LGA1",
            lga_name: "LGA1",
            wards: [
              { ward_id: "W1", ward_name: "Ward A", polling_units: [{ pu_id: "1" }, { pu_id: "2" }, { pu_id: "3" }] },
            ],
          },
        ],
      })
    );
    fs.writeFileSync(
      config.RESCRAPE_TARGETS_FILE,
      JSON.stringify({
        states: [
          { state: "Testland", file: "testland.json", missing_wards: 1, empty_wards_count: 0 },
        ],
      })
    );

    // wardView now lists two wards; W2 was previously absent.
    scraper.fetchWards = async () => [
      { ward: "W1", ward_name: "Ward A" },
      { ward: "W2", ward_name: "Ward B" },
    ];
    scraper.fetchPollingUnits = async (stateId, lgaId, wardId) => {
      if (wardId === "W2") return [{ id: "4", delim: "01-01-02-001", pu: "Unit 4" }, { id: "5", delim: "01-01-02-002", pu: "Unit 5" }];
      return [];
    };

    const log = await scraper.scrapeGaps();

    const saved = JSON.parse(fs.readFileSync(path.join(tempResults, "testland.json"), "utf8"));
    assert.equal(saved.lgas[0].wards.length, 2);
    const added = saved.lgas[0].wards.find((w) => w.ward_id === "W2");
    assert.ok(added, "absent ward W2 should be added");
    assert.equal(added.polling_units.length, 2);
    assert.equal(saved.summary.wards, 2);
    assert.equal(saved.summary.polling_units, 5);
    assert.equal(saved.summary.reconciliation.status, "complete");
    assert.equal(log[0].addedWards, 1);
  });

  it("filters to a single state when --state is given", async () => {
    fs.writeFileSync(
      config.RESCRAPE_TARGETS_FILE,
      JSON.stringify({ states: [{ state: "Testland", file: "testland.json", missing_wards: 0, empty_wards_count: 1 }] })
    );
    let called = false;
    scraper.fetchPollingUnits = async () => {
      called = true;
      return [];
    };
    const log = await scraper.scrapeGaps({ filterState: "Nowhere" });
    assert.equal(log, undefined);
    assert.equal(called, false);
  });
});

// ─── Integration-style Tests (mocked HTTP) ──────────────────────────────────

describe("INECPollingUnitsScraper - fetchWithRetry", () => {
  let scraper;

  beforeEach(() => {
    scraper = new INECPollingUnitsScraper();
    scraper.baseUrl = "https://www.inecnigeria.org/wp-content/themes/rishi/custom/views";
  });

  it("records failures after exhausting retries", async () => {
    const originalRetries = config.RETRY_ATTEMPTS;
    const originalDelay = config.RETRY_BASE_DELAY_MS;
    config.RETRY_ATTEMPTS = 1;
    config.RETRY_BASE_DELAY_MS = 10;

    const result = await scraper.fetchWithRetry(
      "nonexistent.php",
      { state_id: "99" },
      "test failure"
    );

    assert.deepEqual(result, []);
    assert.equal(scraper.failures.length, 1);
    assert.equal(scraper.failures[0].label, "test failure");

    config.RETRY_ATTEMPTS = originalRetries;
    config.RETRY_BASE_DELAY_MS = originalDelay;
  });
});

// ─── Config Validation Tests ────────────────────────────────────────────────

describe("config", () => {
  it("has required base URLs", () => {
    assert.ok(Array.isArray(config.BASE_URLS));
    assert.ok(config.BASE_URLS.length >= 2);
    assert.ok(config.BASE_URLS.every((url) => url.startsWith("https://")));
  });

  it("has all required endpoints", () => {
    assert.ok(config.ENDPOINTS.states);
    assert.ok(config.ENDPOINTS.lgas);
    assert.ok(config.ENDPOINTS.wards);
    assert.ok(config.ENDPOINTS.pollingUnits);
  });

  it("has alt polling units endpoint", () => {
    assert.ok(config.ENDPOINTS_ALT.pollingUnits);
  });

  it("has reasonable concurrency and retry settings", () => {
    assert.ok(config.MAX_CONCURRENT >= 1 && config.MAX_CONCURRENT <= 20);
    assert.ok(config.RETRY_ATTEMPTS >= 1 && config.RETRY_ATTEMPTS <= 10);
    assert.ok(config.RETRY_BASE_DELAY_MS >= 100);
    assert.ok(config.DELAY_BETWEEN_REQUESTS_MS >= 100);
  });

  it("has browser-like headers", () => {
    assert.ok(config.HEADERS["User-Agent"]);
    assert.ok(config.HEADERS.Referer.includes("inecnigeria.org"));
  });

  it("has valid directory paths", () => {
    assert.ok(config.RESULTS_DIR);
    assert.ok(config.PROGRESS_DIR);
    assert.ok(path.isAbsolute(config.RESULTS_DIR));
    assert.ok(path.isAbsolute(config.PROGRESS_DIR));
  });
});

// ─── Data Flow Tests ────────────────────────────────────────────────────────

describe("scraper data flow", () => {
  let scraper;
  let tempResults;
  let tempProgress;

  beforeEach(() => {
    scraper = new INECPollingUnitsScraper();
    tempResults = path.join(__dirname, `temp-results-${Date.now()}`);
    tempProgress = path.join(__dirname, `temp-progress-${Date.now()}`);
    fs.mkdirSync(tempResults, { recursive: true });
    fs.mkdirSync(tempProgress, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempResults, { recursive: true, force: true });
    fs.rmSync(tempProgress, { recursive: true, force: true });
  });

  it("scrapeState produces correct structure for mocked data", async () => {
    const originalDir = config.RESULTS_DIR;
    config.RESULTS_DIR = tempResults;

    scraper.baseUrl = "https://mock.test";
    scraper.fetchLGAs = async () => [
      { id: "1", name: "Test LGA" },
    ];
    scraper.fetchWards = async () => [
      { id: "01", name: "Test Ward" },
    ];
    scraper.fetchPollingUnits = async () => [
      { id: "001", code: "01/01/01/001", name: "Test PU 1" },
      { id: "002", code: "01/01/01/002", name: "Test PU 2" },
    ];

    const state = { code: "1", name: "Test State" };
    const result = await scraper.scrapeState(state);

    // INEC dropped numeric IDs; downstream calls use the name as the id,
    // so state_id resolves to the state name (name-as-id).
    assert.equal(result.state_id, "Test State");
    assert.equal(result.state_name, "Test State");
    assert.equal(result.lgas.length, 1);
    assert.equal(result.lgas[0].lga_name, "Test LGA");
    assert.equal(result.lgas[0].wards.length, 1);
    assert.equal(result.lgas[0].wards[0].polling_units.length, 2);
    assert.equal(result.lgas[0].wards[0].polling_units[0].pu_code, "01/01/01/001");

    assert.equal(scraper.stats.states, 1);
    assert.equal(scraper.stats.lgas, 1);
    assert.equal(scraper.stats.wards, 1);
    assert.equal(scraper.stats.pollingUnits, 2);

    config.RESULTS_DIR = originalDir;
  });

  it("scrapeState uses s_name field from INEC API response", async () => {
    const originalDir = config.RESULTS_DIR;
    config.RESULTS_DIR = tempResults;

    scraper.baseUrl = "https://mock.test";
    scraper.fetchLGAs = async () => [];

    // s_name is preferred for both the name and the id (name-as-id).
    const state = { code: "25", s_name: "LAGOS" };
    const result = await scraper.scrapeState(state);

    assert.equal(result.state_name, "LAGOS");
    assert.equal(result.state_id, "LAGOS");

    config.RESULTS_DIR = originalDir;
  });

  it("scrapeState falls back to _key as state ID when no name field exists", async () => {
    const originalDir = config.RESULTS_DIR;
    config.RESULTS_DIR = tempResults;

    scraper.baseUrl = "https://mock.test";
    scraper.fetchLGAs = async () => [];

    // No s_name/name/code: the numeric _key is the only id-like field.
    const state = { _key: "24" };
    const result = await scraper.scrapeState(state);

    assert.equal(result.state_id, "24");
    assert.equal(result.state_name, "State-24");

    config.RESULTS_DIR = originalDir;
  });

  it("scrapeState uses the lga name as lgaId (name-as-id)", async () => {
    const originalDir = config.RESULTS_DIR;
    config.RESULTS_DIR = tempResults;

    scraper.baseUrl = "https://mock.test";
    // lgaView.php returns {lga: "AGEGE"}; the name doubles as the id.
    scraper.fetchLGAs = async () => [{ lga: "Alimosho" }];
    scraper.fetchWards = async () => [];

    const state = { s_name: "LAGOS" };
    const result = await scraper.scrapeState(state);

    assert.equal(result.lgas[0].lga_id, "Alimosho");
    assert.equal(result.lgas[0].lga_name, "Alimosho");

    config.RESULTS_DIR = originalDir;
  });

  it("resume skips completed states", () => {
    const originalDir = config.PROGRESS_DIR;
    config.PROGRESS_DIR = tempProgress;

    const progress = {
      completedStates: ["Lagos", "Kano"],
      inProgress: null,
    };
    scraper.saveProgress(progress);

    const loaded = scraper.loadProgress();
    assert.ok(loaded.completedStates.includes("Lagos"));
    assert.ok(loaded.completedStates.includes("Kano"));
    assert.equal(loaded.completedStates.length, 2);

    config.PROGRESS_DIR = originalDir;
  });

  it("full pipeline: scrape -> save -> merge", async () => {
    const originalResults = config.RESULTS_DIR;
    const originalProgress = config.PROGRESS_DIR;
    config.RESULTS_DIR = tempResults;
    config.PROGRESS_DIR = tempProgress;

    scraper.baseUrl = "https://mock.test";
    // stateId is the state name (name-as-id), so key the mock off the name.
    scraper.fetchLGAs = async (stateId) => {
      if (stateId === "Alpha State") return [{ id: "L1", name: "LGA One" }];
      if (stateId === "Beta State") return [{ id: "L2", name: "LGA Two" }];
      return [];
    };
    scraper.fetchWards = async () => [{ id: "W1", name: "Ward One" }];
    scraper.fetchPollingUnits = async () => [
      { id: "P1", code: "X/Y/Z/001", name: "PU Alpha" },
    ];

    const state1 = await scraper.scrapeState({ code: "1", name: "Alpha State" });
    scraper.saveStateResult(state1);

    const state2 = await scraper.scrapeState({ code: "2", name: "Beta State" });
    scraper.saveStateResult(state2);

    const total = scraper.mergeResults();
    assert.equal(total, 2);

    const merged = JSON.parse(
      fs.readFileSync(path.join(tempResults, "all-polling-units.json"), "utf8")
    );
    assert.equal(merged.length, 2);
    assert.equal(merged[0].state, "Alpha State");
    assert.equal(merged[0].lga, "LGA One");
    assert.equal(merged[0].ward, "Ward One");
    assert.equal(merged[0].pu_name, "PU Alpha");
    assert.equal(merged[1].state, "Beta State");

    config.RESULTS_DIR = originalResults;
    config.PROGRESS_DIR = originalProgress;
  });
});
