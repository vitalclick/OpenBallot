'use strict';

// Resumable progress tracking.
//
// The scrape is a 4-day job at conservative concurrency. It WILL be
// interrupted - by network blips, by deploys, by SIGTERM. Progress is
// flushed atomically every 50 PUs and at clean exit, so a re-run picks
// up where the previous one left off without re-fetching what is
// already in the database.

const fs = require('fs');
const path = require('path');

const config = require('./../config');

const EMPTY = {
  started_at: null,
  last_flushed_at: null,
  completed: {},      // { "<election_id>:<pu_code>": "ok" | "skipped" | "not_uploaded" }
  errors: {},         // { "<election_id>:<pu_code>": "<error message>" }
  counts: {
    ok: 0,
    skipped: 0,
    not_uploaded: 0,
    image_blocked: 0,
    error: 0,
  },
};

function load() {
  if (!fs.existsSync(config.progressFile)) {
    return { ...EMPTY, started_at: new Date().toISOString() };
  }
  return JSON.parse(fs.readFileSync(config.progressFile, 'utf-8'));
}

function key(electionId, puCode) {
  return `${electionId}:${puCode}`;
}

function done(state, electionId, puCode, status) {
  state.completed[key(electionId, puCode)] = status;
  state.counts[status] = (state.counts[status] || 0) + 1;
}

function fail(state, electionId, puCode, message) {
  state.errors[key(electionId, puCode)] = message;
  const bucket = message && message.startsWith('image_blocked') ? 'image_blocked' : 'error';
  state.counts[bucket] = (state.counts[bucket] || 0) + 1;
}

function isDone(state, electionId, puCode) {
  return Boolean(state.completed[key(electionId, puCode)]);
}

function flush(state) {
  state.last_flushed_at = new Date().toISOString();
  const tmp = config.progressFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, config.progressFile);
}

function reset() {
  if (fs.existsSync(config.progressFile)) fs.unlinkSync(config.progressFile);
}

module.exports = { load, done, fail, isDone, flush, reset };
