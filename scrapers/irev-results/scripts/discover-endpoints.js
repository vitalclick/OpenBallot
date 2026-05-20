#!/usr/bin/env node
'use strict';

// Verify the IReV API contract end-to-end against the live backend.
//
// Usage:
//   node scripts/discover-endpoints.js
//   node scripts/discover-endpoints.js --election-id 2919
//
// Exits 0 if every contract route returns the expected shape, 1 otherwise.
// Run this before kicking off a long scrape so a server-side schema drift
// is caught immediately rather than 6 hours into the walk.

const { verify } = require('../lib/endpoint_discovery');

function parseArgs() {
  const out = { electionId: null };
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--election-id') {
      out.electionId = parseInt(process.argv[++i], 10);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const { results, allOk, probeElectionId } = await verify({
    probeElectionId: args.electionId,
  });

  if (probeElectionId) {
    console.log(`probed against election_id=${probeElectionId}\n`);
  }
  for (const r of results) {
    const status = r.ok ? 'OK  ' : 'FAIL';
    const tail = r.error ? `error=${r.error}` : `sample=${r.sample || ''}`;
    console.log(`${status}  ${(r.took_ms ?? 0).toString().padStart(5)}ms  ${r.name}  ${tail}`);
  }
  console.log(allOk ? '\ncontract OK' : '\ncontract FAILED');
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
