'use strict';

// OpenBallot Nigeria - IReV scraper configuration.
//
// 2026-05-19: rewritten against the live API contract. See README.md
// "The traversal model" section for the full endpoint inventory.
//
// The election-first model means we no longer hardcode per-election
// IDs (presidential-2023 / senate-2023 / ...) up front — the scraper
// asks /elections at runtime and filters client-side via the --type,
// --year, --state, and --election-id CLI flags.

const path = require('path');

module.exports = {
  // ─── HTTP ────────────────────────────────────────────────────────────────
  // The live API. Cloudflare-fronted hostnames (irev.inecnigeria.org,
  // www.inecelectionresults.ng) serve only the Angular SPA shell.
  irevBase: process.env.IREV_BASE || 'https://dolphin-app-sleqh.ondigitalocean.app',
  apiPrefix: process.env.IREV_API_PREFIX || '/api/v1',
  userAgent: 'OpenBallotNG-IReVScraper/0.2 (+https://openballot.ng)',
  // Conservative on a public-good archive scrape.
  requestDelayMs: parseInt(process.env.IREV_DELAY_MS || '450', 10),
  maxConcurrent: parseInt(process.env.IREV_CONCURRENCY || '4', 10),
  maxRetries: 5,
  backoffBaseMs: 1000,
  requestTimeoutMs: 30_000,

  // ─── Storage ─────────────────────────────────────────────────────────────
  storage: {
    endpoint: process.env.STORAGE_ENDPOINT || 'http://localhost:9000',
    bucket:   process.env.STORAGE_BUCKET   || 'ec8a-evidence',
    accessKey: process.env.STORAGE_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.STORAGE_SECRET_KEY || 'minioadmin',
    region:    process.env.STORAGE_REGION    || 'auto',
    // {election_id} = our DB election_id ("irev:2919"); {pu_code} = INEC delim.
    keyTemplate: '{election_id}/{pu_code}.jpg',
  },

  // ─── Database ────────────────────────────────────────────────────────────
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgresql://openballot:openballot@localhost:5432/openballot',

  // ─── State ───────────────────────────────────────────────────────────────
  progressFile: path.resolve(__dirname, 'progress.json'),

  // ─── DB election_id format ───────────────────────────────────────────────
  // Tag IReV-sourced elections so downstream FK joins are unambiguous.
  // Format: "irev:{integer_election_id}" e.g. "irev:2919".
  electionIdPrefix: 'irev:',

  // Test / dry-run mode: do not write to DB or storage.
  dryRun: process.argv.includes('--dry-run'),
};
