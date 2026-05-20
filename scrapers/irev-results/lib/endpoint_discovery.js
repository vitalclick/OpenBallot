'use strict';

// IReV API contract (verified 2026-05-19).
//
// Discovered by scraping the Angular SPA bundle at irev.inecnigeria.org
// and probing each route against the live backend. See README.md
// "The traversal model" for the full discovery narrative.
//
// This module replaces the pre-2026 "candidate URL templates" probe with
// a single verify() function: it walks the contract against a known-good
// election and reports each route's status. Use it as a smoke test before
// long-running scrapes.

const client = require('./irev_client');

const CONTRACT = [
  {
    name: 'GET /election-types',
    run: () => client.listElectionTypes(),
    ok: (r) => Array.isArray(r) && r.length === 7,
  },
  {
    name: 'GET /elections',
    run: () => client.listElections(),
    ok: (r) => Array.isArray(r) && r.length > 0,
  },
];

const PER_ELECTION_CONTRACT = [
  {
    name: 'GET /elections/{_id}',
    run: (e) => client.getElection(e._id),
    ok: (r, e) => r && r.election_id === e.election_id,
  },
  {
    name: 'GET /elections/{_id}/lga',
    run: (e) => client.listLgas(e._id, e.election_id),
    ok: (r) => Array.isArray(r) && r.length > 0 && Array.isArray(r[0].wards),
  },
  {
    name: 'GET /elections/{_id}/pus?ward={...}',
    run: async (e) => {
      const lgas = await client.listLgas(e._id, e.election_id);
      const ward = lgas[0]?.wards?.[0];
      if (!ward) return null;
      return client.listPusByWard(e._id, ward._id, e.election_id);
    },
    ok: (r) => Array.isArray(r),
  },
];

/**
 * Run every contract check. Returns { results: [...], allOk: bool }.
 * Each result has { name, ok, took_ms, sample (truncated) }.
 */
async function verify({ probeElectionId = null } = {}) {
  const results = [];
  let allOk = true;

  for (const c of CONTRACT) {
    const r = await timed(c.name, c.run);
    r.ok = r.ok && c.ok(r.value);
    if (!r.ok) allOk = false;
    results.push(redact(r));
  }

  // Pick an election to probe per-election routes against.
  let probeElection = null;
  const electionsResult = results.find((r) => r.name === 'GET /elections');
  if (electionsResult && electionsResult.ok) {
    const all = await client.listElections();
    probeElection = probeElectionId
      ? all.find((e) => e.election_id === probeElectionId)
      : all[0];
  }
  if (!probeElection) {
    results.push({
      name: '(skip per-election probes)',
      ok: false,
      note: 'could not select a probe election',
    });
    return { results, allOk: false };
  }

  for (const c of PER_ELECTION_CONTRACT) {
    const r = await timed(c.name, () => c.run(probeElection));
    r.ok = r.ok && c.ok(r.value, probeElection);
    if (!r.ok) allOk = false;
    results.push(redact(r));
  }
  return { results, allOk, probeElectionId: probeElection.election_id };
}

async function timed(name, fn) {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { name, ok: true, took_ms: Date.now() - t0, value };
  } catch (e) {
    return { name, ok: false, took_ms: Date.now() - t0, error: e.message };
  }
}

function redact(r) {
  const out = { name: r.name, ok: r.ok, took_ms: r.took_ms };
  if (r.error) out.error = r.error;
  if (r.value !== undefined) {
    out.sample = Array.isArray(r.value)
      ? `[${r.value.length} items]`
      : r.value && typeof r.value === 'object'
      ? `{${Object.keys(r.value).slice(0, 6).join(', ')}}`
      : String(r.value).slice(0, 80);
  }
  return out;
}

module.exports = { verify, CONTRACT, PER_ELECTION_CONTRACT };
