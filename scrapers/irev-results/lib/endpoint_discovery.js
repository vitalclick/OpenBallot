'use strict';

// Endpoint discovery.
//
// IReV's URL scheme is not officially documented and has changed across
// election cycles. Rather than hard-code a single guess, the discovery
// step probes a small set of plausible templates against a known PU and
// returns whichever one returns a parseable JSON body. The operator can
// pipe the result into IREV_RESULT_PATHS before the pilot scrape.
//
// Conservative: at most one probe per template, then move on. We do not
// hammer the portal.

const config = require('../config');
const { getJSON } = require('./http');

const CANDIDATE_TEMPLATES = [
  '/api/v1/elections/{election_id}/polling-units/{pu_code}',
  '/api/v1/elections/{election_id}/results/{pu_code}',
  '/api/elections/{election_id}/results/{pu_code}',
  '/api/elections/{election_id}/polling-units/{pu_code}',
  '/api/v1/pu/{pu_code}?election={election_id}',
  '/api/pu/{pu_code}?election={election_id}',
  '/api/v1/results/{election_id}/{pu_code}',
  '/api/results/{election_id}/{pu_code}',
  '/elections/{election_id}/polling-units/{pu_code}.json',
];

function expand(template, electionId, puCode) {
  return (
    config.irevBase.replace(/\/$/, '') +
    template
      .replace('{election_id}', encodeURIComponent(electionId))
      .replace('{pu_code}', encodeURIComponent(puCode))
  );
}

function looksLikeResultPayload(json) {
  if (!json || typeof json !== 'object') return false;
  if (json.result && (json.result.scores || json.result.results)) return true;
  if (json.data && (json.data.results || json.data.scores)) return true;
  if (Array.isArray(json.Votes)) return true;
  // Last resort: any nested array of {party, score|votes} pairs
  return false;
}

async function discoverResultPath({ electionId, puCode }) {
  const tried = [];
  for (const tmpl of CANDIDATE_TEMPLATES) {
    const url = expand(tmpl, electionId, puCode);
    const t0 = Date.now();
    try {
      const json = await getJSON(url);
      const elapsed = Date.now() - t0;
      const ok = looksLikeResultPayload(json);
      tried.push({ template: tmpl, url, status: 200, elapsed_ms: elapsed, parseable: ok });
      if (ok) return { winner: tmpl, url, tried };
    } catch (e) {
      tried.push({
        template: tmpl,
        url,
        status: e.status || 'network_error',
        elapsed_ms: Date.now() - t0,
        parseable: false,
        error: e.message,
      });
    }
  }
  return { winner: null, url: null, tried };
}

module.exports = { discoverResultPath, CANDIDATE_TEMPLATES, expand, looksLikeResultPayload };
