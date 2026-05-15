'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// We need to redirect ROOT before requiring the module. Easiest is to
// monkey-patch process.cwd() via a temporary script. Cleaner: just call
// persist with a known prefix and clean up after.

const fc = require('../lib/fixture_capture');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openballot-fc-'));

// Override the module-level ROOT for this test by writing into the real
// fixtures/captured folder under a sentinel election id, then cleaning up.
const SENTINEL = '__test_election__';

test('fixture capture round-trip writes file and summarises', () => {
  fc.persist({
    electionId: SENTINEL,
    puCode: '25-11-04-007',
    url: 'https://example.com/api/x',
    status: 200,
    rawBody: { result: { scores: [{ party: 'APC', score: 142 }] } },
    parsedOk: true,
    parsedReason: null,
    imageContentType: 'image/jpeg',
    imageBytes: 412_000,
    imageSha256: 'a'.repeat(64),
  });
  fc.persist({
    electionId: SENTINEL,
    puCode: '25-11-04-019',
    url: 'https://example.com/api/y',
    status: 200,
    rawBody: { totally: 'unrecognised' },
    parsedOk: false,
    parsedReason: 'unparseable',
  });

  // File exists
  const p = fc.fixturePath(SENTINEL, '25-11-04-007');
  assert.equal(fs.existsSync(p), true);
  const rec = JSON.parse(fs.readFileSync(p, 'utf-8'));
  assert.equal(rec.pu_code, '25-11-04-007');
  assert.equal(rec.parse.ok, true);
  assert.equal(rec.image.bytes, 412_000);

  // Summary picks up both outcomes
  const summary = fc.summariseByOutcome();
  assert.ok(summary.total >= 2);
  assert.ok(summary.by_outcome.parsed >= 1);
  assert.ok(summary.by_outcome.unparseable >= 1);

  // Cleanup
  fs.rmSync(path.join(fc.ROOT, SENTINEL), { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
});
