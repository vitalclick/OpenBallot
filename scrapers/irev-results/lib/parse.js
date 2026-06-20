'use strict';

// Parse a per-PU entry from /elections/{_id}/pus into the shape persist.js
// writes. The 2026 IReV API returns the EC8A image URL + full geo lineage +
// upload metadata per PU; it does NOT return vote tallies inline (those
// must come from /result/stats or by OCR-ing the image). ADR-0001 makes the
// image the canonical evidence, so the MVP scraper archives the image and
// leaves vote-count extraction to downstream OCR.

/**
 * @param {object} raw - one element of /elections/{_id}/pus response .data[]
 * @returns {object|null} - { image_url, extracted, raw_meta } or null
 *   when no EC8A document has been uploaded for this PU yet (a real,
 *   expected condition — many PUs lack uploads at scrape time).
 */
function parsePuEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.pu_code) return null;

  const doc = raw.document;
  const imageUrl = doc?.url || null;
  if (!imageUrl) return null;

  const pu = raw.polling_unit || {};
  return {
    image_url: imageUrl,
    extracted: {
      pu_code: raw.pu_code,
      pu_name: raw.name || pu.name || null,
      // Geo lineage from IReV (mirrors what we'd join from our own registry).
      state_id: raw.state || pu.state || null,
      lga_id: raw.lga || pu.lga?._id || pu.lga || null,
      ward_id: raw.ward?._id || raw.ward || pu.ward || null,
      irev_polling_unit_id: raw.polling_unit_id ?? pu.polling_unit_id ?? null,
      // Vote counts are NOT in this payload (ADR-0001: image is canonical).
      candidate_votes: null,
      registered_voters: null,
      accredited_voters: null,
      total_valid_votes: null,
      rejected_ballots: null,
      total_votes_cast: null,
      // OCR/agent inspection feeds these later.
      presiding_officer_signed: null,
      agent_signatures_detected: null,
      official_stamp_present: null,
    },
    raw_meta: {
      irev_record_id: raw._id || null,
      irev_election_id: raw.election_id ?? null,
      submitted_at: raw.result_updated_time
        ? new Date(raw.result_updated_time).toISOString()
        : raw.updated_at || null,
      is_zero_pu: Boolean(raw.is_zero_pu),
      document_size: doc?.size ?? null,
    },
  };
}

/**
 * Flatten a /pus entry into an irev_pu_catalog row. Unlike parsePuEntry this
 * NEVER drops a PU: it records every polling unit in the election, with
 * document_url left null when no EC8A has been uploaded yet — so the catalog
 * doubles as an upload-coverage record. The full raw entry is preserved in
 * `raw` for forensics.
 *
 * @param {object} raw - one element of /elections/{_id}/pus response .data[]
 * @param {object} [election] - the election object (for label/type context)
 * @returns {object|null} catalog row, or null if the entry has no pu_code
 */
function parseCatalogEntry(raw, election) {
  if (!raw || typeof raw !== 'object' || !raw.pu_code) return null;
  const pu = raw.polling_unit || {};
  const doc = raw.document || {};
  const lga = pu.lga && typeof pu.lga === 'object' ? pu.lga : {};
  const ward =
    raw.ward && typeof raw.ward === 'object'
      ? raw.ward
      : pu.ward && typeof pu.ward === 'object'
        ? pu.ward
        : {};
  return {
    irev_election_id: raw.election_id ?? election?.election_id ?? null,
    pu_code: raw.pu_code,
    pu_code_string: pu.pu_code_string || raw.pu_code_string || null,
    pu_name: raw.name || pu.name || null,
    polling_unit_id: raw.polling_unit_id ?? pu.polling_unit_id ?? null,
    election_label: election?.full_name || raw.election?.full_name || null,
    election_type_id: election?.election_type_id ?? raw.election?.election_type_id ?? null,
    state_id: pu.state_id ?? raw.state_id ?? election?.state_id ?? null,
    lga_name: lga.name || null,
    lga_code: lga.code || null,
    ward_name: ward.name || null,
    document_url: doc.url || null,
    document_size: doc.size ?? null,
    is_zero_pu: Boolean(raw.is_zero_pu),
    result_updated_at: raw.result_updated_time
      ? new Date(raw.result_updated_time).toISOString()
      : raw.updated_at || null,
    irev_record_id: raw._id || null,
    raw,
  };
}

module.exports = { parsePuEntry, parseCatalogEntry };
