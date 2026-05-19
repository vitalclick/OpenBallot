#!/usr/bin/env node
'use strict';

// OpenBallot Nigeria - IReV results scraper (election-first walker).
//
// For each matching election in IReV:
//   election -> LGAs -> wards -> PUs -> EC8A document.url -> object store
//
// Selects elections via /elections (cap 400 most-recent) and filters
// client-side. See README.md "The traversal model" for the API contract
// this is built against.
//
// Flags:
//   --election-id <int>   Scrape exactly one IReV election (e.g. 2919)
//   --type <CODE>         Filter elections by type: PRES|GOV|SEN|REPS|
//                         ASSEMBLY|CHAIRMAN|COUNCILLOR (repeatable)
//   --year <YYYY>         Filter elections by election_date year
//   --state <NAME>        Limit to one state by name (e.g. ANAMBRA)
//   --ward <objectId>     Scrape only one ward (smoke test)
//   --max <N>             Stop after N successful PUs
//   --smoke               Pick first matching election, first LGA, first
//                         ward; scrape that single ward end-to-end.
//                         Equivalent to a guided dry-run + tiny live run.
//   --catalog-only        Skip image downloads; just record metadata + the
//                         image URL. Use this when the EC8A CDN
//                         (inc-s3-cache.incportals.com) is unreachable —
//                         it allowlists by host so external scrapers get
//                         HTTP 403. See README "Image fetch limitation".
//   --stats               Print upload-progress per matching election and
//                         exit (no scrape). Useful pre-flight check.
//   --check-cdn           Verify the EC8A CDN is reachable from this host
//                         (one image fetch) before committing to a long
//                         run. Exits 0 if reachable, 1 if blocked.
//   --dry-run             Skip DB + storage writes
//   --reset               Discard progress and start over

const config = require('./config');
const client = require('./lib/irev_client');
const { parsePuEntry } = require('./lib/parse');
const { uploadImage } = require('./lib/storage');
const { upsertInecSubmission, close: closeDb } = require('./lib/persist');
const progress = require('./lib/progress');
const { sleep } = require('./lib/http');

function parseArgs(argv) {
  const out = {
    electionId: null,
    types: [],
    year: null,
    state: null,
    ward: null,
    max: Infinity,
    smoke: false,
    reset: false,
    catalogOnly: false,
    stats: false,
    checkCdn: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--election-id') out.electionId = parseInt(argv[++i], 10);
    else if (a === '--type') out.types.push(argv[++i].toUpperCase());
    else if (a === '--year') out.year = parseInt(argv[++i], 10);
    else if (a === '--state') out.state = argv[++i].toUpperCase();
    else if (a === '--ward') out.ward = argv[++i];
    else if (a === '--max') out.max = parseInt(argv[++i], 10);
    else if (a === '--smoke') out.smoke = true;
    else if (a === '--reset') out.reset = true;
    else if (a === '--catalog-only') out.catalogOnly = true;
    else if (a === '--stats') out.stats = true;
    else if (a === '--check-cdn') out.checkCdn = true;
  }
  return out;
}

function dbElectionId(electionIntegerId) {
  return `${config.electionIdPrefix}${electionIntegerId}`;
}

function matchesFilters(election, args) {
  if (args.electionId && election.election_id !== args.electionId) return false;
  if (args.types.length) {
    const code = election.election_type?.code;
    if (!code || !args.types.includes(code.toUpperCase())) return false;
  }
  if (args.year) {
    const y = new Date(election.election_date).getUTCFullYear();
    if (y !== args.year) return false;
  }
  if (args.state) {
    const name = election.state?.name?.toUpperCase();
    if (!name || name !== args.state) return false;
  }
  return true;
}

async function selectElections(args) {
  if (args.electionId) {
    // Caller asked for a specific election. Fetch it directly so we don't
    // depend on it being inside the 400-most-recent window.
    const all = await client.listElections();
    let hit = all.find((e) => e.election_id === args.electionId);
    if (!hit) {
      // Fall back to a focused fetch by ObjectId — but we only have the
      // integer; warn and bail.
      throw new Error(
        `election_id=${args.electionId} not in the 400-most-recent /elections window; ` +
          `pass --year/--type filters instead, or look up its _id manually.`
      );
    }
    return [hit];
  }
  const all = await client.listElections();
  return all.filter((e) => matchesFilters(e, args));
}

async function processOne(progressState, dbEid, electionIntegerId, puEntry, args) {
  const parsed = parsePuEntry(puEntry);
  if (!parsed) {
    progress.done(progressState, dbEid, puEntry.pu_code || '?', 'not_uploaded');
    return 'not_uploaded';
  }

  try {
    let imageSha256 = null;
    let imageBytes = null;
    let storedUrl = parsed.image_url;

    if (!args.catalogOnly) {
      try {
        const { bytes, contentType } = await client.fetchImage(parsed.image_url);
        const upload = await uploadImage({
          electionId: dbEid,
          puCode: parsed.extracted.pu_code,
          bytes,
          contentType,
        });
        imageSha256 = upload.sha256;
        imageBytes = upload.bytes;
        storedUrl = upload.url || parsed.image_url;
      } catch (e) {
        // The IReV CDN (inc-s3-cache.incportals.com) allowlists by host;
        // external scrapers get HTTP 403. Treat as a known condition so
        // the run keeps cataloging metadata instead of bailing per-PU.
        if (e.status === 403) {
          progress.fail(
            progressState,
            dbEid,
            parsed.extracted.pu_code,
            'image_blocked (CDN ACL)'
          );
          return 'image_blocked';
        }
        throw e;
      }
    }

    await upsertInecSubmission({
      electionId: dbEid,
      puCode: parsed.extracted.pu_code,
      imageUrl: storedUrl,
      imageSha256,
      imageBytes,
      extracted: parsed.extracted,
      irevSubmittedAt: parsed.raw_meta.submitted_at,
      irevRecordId: parsed.raw_meta.irev_record_id,
    });

    progress.done(progressState, dbEid, parsed.extracted.pu_code, 'ok');
    return 'ok';
  } catch (e) {
    progress.fail(progressState, dbEid, parsed.extracted.pu_code, e.message);
    return 'error';
  }
}

async function scrapeWard(progressState, election, lga, ward, args) {
  const dbEid = dbElectionId(election.election_id);
  const pus = await client.listPusByWard(election._id, ward._id, election.election_id);

  let processed = 0;
  for (const puEntry of pus) {
    if (processed >= args.max) return processed;
    if (progress.isDone(progressState, dbEid, puEntry.pu_code)) {
      processed += 1;
      continue;
    }

    const t0 = Date.now();
    const status = await processOne(progressState, dbEid, election.election_id, puEntry, args);
    processed += 1;

    if (processed === 1 || processed % 25 === 0) {
      progress.flush(progressState);
      console.log(
        `  [${dbEid}] ${lga.lga?.name || '?'}/${ward.name || ward._id}  ` +
          `pu=${puEntry.pu_code} → ${status}  ` +
          `(${progressState.counts.ok} ok / ${progressState.counts.not_uploaded} missing / ` +
          `${progressState.counts.error} err)`
      );
    }

    const elapsed = Date.now() - t0;
    if (elapsed < config.requestDelayMs) {
      await sleep(config.requestDelayMs - elapsed);
    }
  }
  return processed;
}

async function scrapeElection(progressState, election, args) {
  const dbEid = dbElectionId(election.election_id);
  console.log(
    `\n=== ${dbEid}  ${election.full_name}  ` +
      `(${election.state?.name || 'multi-state'}, type=${election.election_type?.code || '?'})`
  );

  const lgas = await client.listLgas(election._id, election.election_id);
  if (!lgas.length) {
    console.log(`  no LGAs returned — election may be empty (e.g. Presidential singleton)`);
    return 0;
  }

  let processed = 0;
  for (const lga of lgas) {
    if (processed >= args.max) break;
    const wards = lga.wards || [];
    for (const ward of wards) {
      if (processed >= args.max) break;
      if (args.ward && ward._id !== args.ward) continue;
      processed += await scrapeWard(progressState, election, lga, ward, {
        ...args,
        max: args.max - processed,
      });
      if (args.smoke) return processed; // one ward and done
    }
  }
  return processed;
}

async function printElectionStats(elections) {
  console.log('upload progress per election (pus / documents / latest upload):\n');
  for (const e of elections) {
    const s = await client.fetchResultStats(e._id, e.election_id);
    if (!s) {
      console.log(`  irev:${e.election_id}  ${e.full_name}  (no stats)`);
      continue;
    }
    const pct = s.pus ? ((100 * s.documents) / s.pus).toFixed(1) : '0.0';
    const latest = s.latest?.updated_at || s.latest?.result_updated_time || '—';
    console.log(
      `  irev:${e.election_id}  ${e.full_name}\n` +
        `    ${s.documents}/${s.pus} uploaded (${pct}%), expected=${s.expected}, ` +
        `not_expected=${s.not_expected}, latest=${latest}`
    );
  }
}

async function checkCdnReachable() {
  // Probe one EC8A image to confirm the CDN allowlist lets this host
  // through. Picks the latest-uploaded image from an arbitrary election
  // so the URL is fresh.
  const elections = await client.listElections();
  for (const e of elections) {
    const s = await client.fetchResultStats(e._id, e.election_id);
    const url = s?.latest?.document?.url;
    if (!url) continue;
    console.log(`probing ${url}`);
    try {
      const { bytes } = await client.fetchImage(url);
      console.log(`OK — fetched ${bytes.length} bytes`);
      return true;
    } catch (err) {
      if (err.status === 403) {
        console.log(`BLOCKED — HTTP 403 (CDN allowlist). See README "Image fetch limitation".`);
      } else {
        console.log(`FAILED — ${err.message}`);
      }
      return false;
    }
  }
  console.log('no images available to probe');
  return false;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.reset) progress.reset();
  const progressState = progress.load();

  if (args.checkCdn) {
    const ok = await checkCdnReachable();
    process.exit(ok ? 0 : 1);
  }

  if (
    !args.electionId &&
    !args.types.length &&
    !args.year &&
    !args.state &&
    !args.smoke
  ) {
    console.error(
      'refusing to scrape with no filters — pass --election-id, --type, --year, --state, or --smoke'
    );
    process.exit(2);
  }

  const elections = await selectElections(args);
  if (!elections.length) {
    console.error('no elections matched the given filters');
    process.exit(1);
  }
  console.log(
    `matched ${elections.length} election(s)` + (config.dryRun ? ' [DRY RUN]' : '')
  );

  if (args.stats) {
    await printElectionStats(elections);
    return;
  }

  if (args.smoke) {
    // Pick the first matching election; --max defaults to Infinity but we
    // cap at one ward in scrapeElection.
    const e = elections[0];
    console.log(`smoke mode: scraping first ward of first LGA of ${e.full_name}`);
    await scrapeElection(progressState, e, args);
  } else {
    for (const e of elections) {
      await scrapeElection(progressState, e, args);
    }
  }

  progress.flush(progressState);
  console.log('\nFinal counts:', progressState.counts);
  await closeDb();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { main, processOne, selectElections, scrapeWard, scrapeElection };
