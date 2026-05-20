'use strict';

// Client for the live IReV API (DigitalOcean / Express / MongoDB).
//
// Contract verified 2026-05-19 by scraping the Angular SPA bundle at
// irev.inecnigeria.org and probing each route against the live backend.
// See README.md "The traversal model" for the full inventory.
//
// Key contract rule: the :election URL parameter is the Mongo _id
// (ObjectId), NOT the integer election_id. The integer goes in
// ?election=... (optional but the SPA always sends it).

const config = require('../config');
const { getJSON, getBytes } = require('./http');

function apiUrl(path) {
  return (
    config.irevBase.replace(/\/$/, '') +
    config.apiPrefix.replace(/\/$/, '') +
    (path.startsWith('/') ? path : '/' + path)
  );
}

// ─── Catalog endpoints ─────────────────────────────────────────────────────

async function listElectionTypes() {
  const res = await getJSON(apiUrl('/election-types'));
  return res?.data || [];
}

async function listElections() {
  // The endpoint caps at 400 most-recent rows and ignores ?page / ?limit.
  // Returns Gov/Senate/Reps/Assembly/Chairman/Councillor — Presidential
  // is absent from this listing (see README).
  const res = await getJSON(apiUrl('/elections'));
  return res?.data || [];
}

async function getElection(electionObjectId) {
  const res = await getJSON(apiUrl(`/elections/${electionObjectId}`));
  return res?.data || null;
}

// ─── Traversal endpoints ───────────────────────────────────────────────────

async function listLgas(electionObjectId, electionIntegerId) {
  // Returns LGAs with embedded ward arrays. For multi-state elections
  // (e.g. Presidential) use listLgasForState instead.
  const q = electionIntegerId ? `?election=${encodeURIComponent(electionIntegerId)}` : '';
  const res = await getJSON(apiUrl(`/elections/${electionObjectId}/lga${q}`));
  return res?.data || [];
}

async function listLgasForState(electionObjectId, stateId, electionIntegerId) {
  const q = electionIntegerId ? `?election=${encodeURIComponent(electionIntegerId)}` : '';
  const res = await getJSON(
    apiUrl(`/elections/${electionObjectId}/lga/state/${stateId}${q}`)
  );
  return res?.data || [];
}

async function listPusByWard(electionObjectId, wardObjectId, electionIntegerId) {
  // Each entry in .data has:
  //   _id, polling_unit_id, election_id, pu_code, polling_unit (full geo),
  //   document.url (EC8A image, may be absent if not yet uploaded),
  //   result_updated_time, is_zero_pu
  const params = new URLSearchParams({ ward: wardObjectId });
  if (electionIntegerId) params.set('election', String(electionIntegerId));
  const res = await getJSON(
    apiUrl(`/elections/${electionObjectId}/pus?${params.toString()}`)
  );
  return res?.data || [];
}

async function fetchResultStats(electionObjectId, electionIntegerId) {
  // Upload-progress metrics (NOT vote tallies — verified 2026-05-19).
  // Response shape:
  //   data.pus         - total expected PU count for this election
  //   data.documents   - count of PUs with an uploaded EC8A
  //   data.expected    - same as data.pus
  //   data.not_expected - count of PUs not expected to upload
  //                       (e.g. is_zero_pu=true)
  //   data.latest      - the most recently uploaded PU entry (full record
  //                      with document.url, same shape as listPusByWard()
  //                      elements)
  const q = electionIntegerId ? `?election=${encodeURIComponent(electionIntegerId)}` : '';
  const res = await getJSON(apiUrl(`/elections/${electionObjectId}/result/stats${q}`));
  return res?.data || null;
}

// ─── Image fetch ───────────────────────────────────────────────────────────

async function fetchImage(imageUrl) {
  return getBytes(imageUrl);
}

module.exports = {
  apiUrl,
  listElectionTypes,
  listElections,
  getElection,
  listLgas,
  listLgasForState,
  listPusByWard,
  fetchResultStats,
  fetchImage,
};
