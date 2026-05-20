'use strict';

// Persist scraped IReV results into the OpenBallot database.
//
// Two writes per polling unit:
//   1. ec8a_submissions row with source_type='inec_irev' and review_status='auto_approved'
//      (INEC IReV is the official source; no human review queue)
//   2. audit_log row 'submission.created' - the trigger computes the chained hash
//
// The function is idempotent: a re-scrape of the same PU UPDATES the
// existing INEC submission rather than creating a duplicate, because
// `(election_id, pu_code, source_type=inec_irev)` is logically unique.

const config = require('../config');

let _db = null;

async function db() {
  if (_db) return _db;
  const { Client } = require('pg');
  _db = new Client({ connectionString: config.databaseUrl });
  await _db.connect();
  return _db;
}

async function close() {
  if (_db) {
    await _db.end();
    _db = null;
  }
}

async function upsertInecSubmission({
  electionId,
  puCode,
  imageUrl,
  imageSha256,
  imageBytes,
  extracted,
  irevSubmittedAt,
  irevRecordId,
}) {
  if (config.dryRun) return { upserted: true, dryRun: true };

  const client = await db();

  // Idempotency: delete prior INEC IReV submission for this PU+election, if any.
  await client.query(
    `DELETE FROM ec8a_submissions
       WHERE election_id = $1 AND pu_code = $2 AND source_type = 'inec_irev'`,
    [electionId, puCode]
  );

  const res = await client.query(
    `INSERT INTO ec8a_submissions (
       election_id, pu_code, source_type, party_code,
       image_url, image_sha256, image_bytes,
       confidence_score, extracted_data, validation_flags,
       review_status, submitted_at
     ) VALUES (
       $1, $2, 'inec_irev', NULL,
       $3, $4, $5,
       1.0, $6::jsonb, $7::jsonb,
       'auto_approved', COALESCE($8::timestamptz, NOW())
     )
     RETURNING id`,
    [
      electionId,
      puCode,
      imageUrl,
      imageSha256,
      imageBytes,
      JSON.stringify(extracted),
      JSON.stringify({ ok: true, source: 'inec_irev', irev_record_id: irevRecordId }),
      irevSubmittedAt,
    ]
  );
  const submissionId = res.rows[0].id;

  await client.query(
    `INSERT INTO audit_log (event_type, entity_type, entity_id, event_data)
     VALUES ('submission.created', 'ec8a_submission', $1, $2::jsonb)`,
    [
      submissionId,
      JSON.stringify({
        election_id: electionId,
        pu_code: puCode,
        source: 'inec_irev',
        image_sha256: imageSha256,
        irev_record_id: irevRecordId,
      }),
    ]
  );

  // Refresh the per-PU verification result. We call the SQL function instead
  // of re-implementing the engine in JS - the algorithm of record is the
  // Python engine, and SQL recomputes consensus inline for write-time.
  await client.query(
    `INSERT INTO verified_results (election_id, pu_code, status, consensus_data, submission_count, source_count, computed_at)
       VALUES ($1, $2, 'inec_published', $3::jsonb, 1, 1, NOW())
     ON CONFLICT (election_id, pu_code) DO UPDATE
       SET status = EXCLUDED.status,
           consensus_data = EXCLUDED.consensus_data,
           submission_count = verified_results.submission_count,
           source_count = verified_results.source_count,
           computed_at = EXCLUDED.computed_at`,
    [electionId, puCode, JSON.stringify(extracted)]
  );

  return { upserted: true, submissionId };
}

module.exports = { upsertInecSubmission, close };
