#!/usr/bin/env node
'use strict';

// One-state pilot scrape with full instrumentation.
//
// What it does:
//   1. Walks the geo registry for one state (default: Lagos)
//   2. For each PU, fetches the IReV result, captures the raw response to a
//      fixture file, parses, downloads + uploads the image, persists the
//      submission + audit event
//   3. Tracks per-PU latency, bandwidth, success/failure
//   4. After the run, re-pulls a sample of images from storage and
//      recomputes SHA-256 to verify storage integrity
//   5. Calls the audit chain verifier
//   6. Emits a structured JSON report + a human-readable markdown summary
//
// Output:
//   ./pilot-report.json
//   ./pilot-report.md
//
// Flags:
//   --state <NAME>       default "Lagos"
//   --election <type>    default "presidential"
//   --limit <N>          stop after N attempts (default 200 - tight pilot)
//   --dry-run            skip writes (no DB, no storage upload)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('../config');
const { walkPollingUnits, countPollingUnits } = require('../lib/geo');
const { fetchPUResult, fetchImage } = require('../lib/irev_client');
const { parseIRevPU } = require('../lib/parse');
const { uploadImage } = require('../lib/storage');
const { upsertInecSubmission, close: closeDb } = require('../lib/persist');
const { sleep } = require('../lib/http');
const fixtureCapture = require('../lib/fixture_capture');
const reporter = require('../lib/pilot_reporter');

function parseArgs() {
  const out = { state: 'Lagos', election: 'presidential', limit: 200 };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--state') out.state = process.argv[++i];
    else if (a === '--election') out.election = process.argv[++i];
    else if (a === '--limit') out.limit = parseInt(process.argv[++i], 10);
  }
  return out;
}

async function verifyAuditChain() {
  if (config.dryRun) return null;
  const { Client } = require('pg');
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query(`
      SELECT seq, event_type, entity_type, entity_id, actor_id::text,
             event_at::text, event_data::text, prev_hash, log_hash
      FROM audit_log ORDER BY seq
    `);
    let prev = '0'.repeat(64);
    for (const r of rows) {
      if (r.event_type === 'chain.genesis') {
        prev = r.log_hash;
        continue;
      }
      if (r.prev_hash !== prev) {
        return { ok: false, first_broken_seq: r.seq, events_checked: r.seq };
      }
      const payload =
        prev +
        r.event_type +
        r.entity_type +
        r.entity_id +
        (r.actor_id || '') +
        r.event_at +
        r.event_data;
      const expected = crypto.createHash('sha256').update(payload).digest('hex');
      if (expected !== r.log_hash) {
        return { ok: false, first_broken_seq: r.seq, events_checked: r.seq };
      }
      prev = r.log_hash;
    }
    return { ok: true, events_checked: rows.length };
  } finally {
    await client.end();
  }
}

async function verifyStorageHashes(sampleSize = 5) {
  if (config.dryRun) return { hash_check_sampled: 0, hash_check_matches: 0 };
  const { Client } = require('pg');
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query(`
      SELECT id, image_url, image_sha256
      FROM ec8a_submissions
      WHERE source_type = 'inec_irev'
      ORDER BY submitted_at DESC
      LIMIT $1
    `, [sampleSize]);
    let matches = 0;
    for (const r of rows) {
      try {
        const { bytes } = await fetchImage(r.image_url);
        const sha = crypto.createHash('sha256').update(bytes).digest('hex');
        if (sha === r.image_sha256) matches += 1;
      } catch {
        // network error - count as non-match
      }
    }
    return { hash_check_sampled: rows.length, hash_check_matches: matches };
  } finally {
    await client.end();
  }
}

async function main() {
  const args = parseArgs();
  const electionId = `2023-${args.election === 'governorship' ? 'governorship' : args.election}`;
  const irevElectionId = config.electionIds[args.election];

  if (!irevElectionId) {
    console.error(`unknown election: ${args.election}`);
    process.exit(2);
  }

  const totalPUs = countPollingUnits({ stateFilter: args.state });
  console.log(
    `Pilot: state=${args.state}, election=${args.election}, ` +
      `PUs available=${totalPUs}, limit=${args.limit}` +
      (config.dryRun ? ' [DRY RUN]' : '')
  );
  console.log('');

  const runStats = {
    state: args.state,
    election: args.election,
    pus_in_registry: totalPUs,
    pus_attempted: 0,
    pus_succeeded: 0,
    pus_not_uploaded: 0,
    pus_errored: 0,
    latencies_ms: [],
    bytes_downloaded: 0,
    images_downloaded: 0,
    images_uploaded: 0,
  };

  for (const pu of walkPollingUnits({ stateFilter: args.state })) {
    if (runStats.pus_attempted >= args.limit) break;
    runStats.pus_attempted += 1;

    const t0 = Date.now();
    let rawBody = null;
    let url = null;
    let parsed = null;
    let parseReason = null;

    try {
      const fetched = await fetchPUResult(irevElectionId, pu.pu_code);
      url = fetched.url;
      rawBody = fetched.json;
      parsed = parseIRevPU(rawBody, pu.pu_code);
      if (!parsed) parseReason = 'unparseable';
    } catch (e) {
      if (e.code === 'not_uploaded') {
        runStats.pus_not_uploaded += 1;
        fixtureCapture.persist({
          electionId,
          puCode: pu.pu_code,
          url: null,
          status: 404,
          rawBody: null,
          parsedOk: false,
          parsedReason: 'not_uploaded',
        });
        runStats.latencies_ms.push(Date.now() - t0);
        if (Date.now() - t0 < config.requestDelayMs) {
          await sleep(config.requestDelayMs - (Date.now() - t0));
        }
        continue;
      }
      parseReason = e.message;
    }

    let imageBytes = null;
    let imageSha = null;
    let imageContentType = null;

    if (parsed) {
      try {
        const img = await fetchImage(parsed.image_url);
        imageContentType = img.contentType;
        const upload = await uploadImage({
          electionId,
          puCode: pu.pu_code,
          bytes: img.bytes,
          contentType: img.contentType,
        });
        imageBytes = upload.bytes;
        imageSha = upload.sha256;
        runStats.bytes_downloaded += img.bytes.length;
        runStats.images_downloaded += 1;
        runStats.images_uploaded += upload.skipped ? 0 : 1;

        await upsertInecSubmission({
          electionId,
          puCode: pu.pu_code,
          imageUrl: upload.url || parsed.image_url,
          imageSha256: upload.sha256,
          imageBytes: upload.bytes,
          extracted: parsed.extracted,
          irevSubmittedAt: parsed.raw_meta.submitted_at,
          irevRecordId: parsed.raw_meta.irev_record_id,
        });
        runStats.pus_succeeded += 1;
      } catch (e) {
        parseReason = `image/persist failed: ${e.message}`;
        runStats.pus_errored += 1;
      }
    } else {
      runStats.pus_errored += 1;
    }

    fixtureCapture.persist({
      electionId,
      puCode: pu.pu_code,
      url,
      status: rawBody ? 200 : 0,
      rawBody,
      parsedOk: !!parsed,
      parsedReason: parsed ? null : parseReason,
      imageContentType,
      imageBytes,
      imageSha256: imageSha,
    });

    runStats.latencies_ms.push(Date.now() - t0);
    if (runStats.pus_attempted % 25 === 0) {
      console.log(
        `  [${runStats.pus_attempted}/${args.limit}] ok=${runStats.pus_succeeded} ` +
          `missing=${runStats.pus_not_uploaded} err=${runStats.pus_errored}`
      );
    }
    if (Date.now() - t0 < config.requestDelayMs) {
      await sleep(config.requestDelayMs - (Date.now() - t0));
    }
  }

  console.log('');
  console.log('Verifying storage hashes...');
  const dbStats = await verifyStorageHashes(5);
  console.log(`  ${dbStats.hash_check_matches}/${dbStats.hash_check_sampled} match`);

  console.log('Verifying audit chain...');
  const chainResult = await verifyAuditChain();
  console.log(
    chainResult
      ? chainResult.ok
        ? `  OK across ${chainResult.events_checked} events`
        : `  BROKEN at seq=${chainResult.first_broken_seq}`
      : '  skipped (dry run)'
  );

  await closeDb();

  const report = reporter.build({ runStats, dbStats, chainResult });
  const reportDir = path.resolve(__dirname, '..', 'pilot-output');
  fs.mkdirSync(reportDir, { recursive: true });
  reporter.writeReport(report, path.join(reportDir, 'pilot-report.json'));
  fs.writeFileSync(path.join(reportDir, 'pilot-report.md'), reporter.asMarkdown(report));

  console.log('');
  console.log(`Report written to:`);
  console.log(`  ${path.join(reportDir, 'pilot-report.json')}`);
  console.log(`  ${path.join(reportDir, 'pilot-report.md')}`);
  console.log('');
  if (report.verdict.ship_full_scrape) {
    console.log('VERDICT: ready to ship the full scrape.');
  } else {
    console.log('VERDICT: hold the full scrape. Issues:');
    for (const issue of report.verdict.issues) console.log(`  - ${issue}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
