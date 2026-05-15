#!/usr/bin/env node
'use strict';

// Discover the live IReV result-endpoint URL pattern.
//
// Usage:
//   node scripts/discover-endpoints.js \
//     --election presidential \
//     --pu 25-11-04-007
//
// On success, prints the winning template and an export line that the
// operator can paste into their shell before running the pilot.

const config = require('../config');
const { discoverResultPath } = require('../lib/endpoint_discovery');

function parseArgs() {
  const out = { election: 'presidential', pu: null };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--election') out.election = process.argv[++i];
    else if (a === '--pu') out.pu = process.argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs();
  if (!args.pu) {
    console.error('--pu <pu_code> is required. Pick a known-good PU from Polling-Units/results.');
    process.exit(2);
  }
  const electionId = config.electionIds[args.election];
  if (!electionId) {
    console.error(`unknown election type: ${args.election}`);
    process.exit(2);
  }

  console.log(`Probing IReV at ${config.irevBase}`);
  console.log(`Election: ${args.election} (id=${electionId})`);
  console.log(`Polling unit: ${args.pu}`);
  console.log('');

  const result = await discoverResultPath({ electionId, puCode: args.pu });

  console.log('Templates tried:');
  for (const t of result.tried) {
    const mark = t.parseable ? 'PARSEABLE' : t.status === 200 ? '200 (unrecognised)' : t.status;
    console.log(`  [${mark}]  ${t.template}  (${t.elapsed_ms}ms)`);
  }
  console.log('');

  if (!result.winner) {
    console.error('No template returned a parseable payload.');
    console.error('Inspect the network responses manually or update CANDIDATE_TEMPLATES in lib/endpoint_discovery.js.');
    process.exit(1);
  }

  console.log(`Winner: ${result.winner}`);
  console.log('');
  console.log('To use this pattern in subsequent scrapes:');
  console.log('');
  console.log(`  export IREV_RESULT_PATHS='${result.winner}'`);
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
