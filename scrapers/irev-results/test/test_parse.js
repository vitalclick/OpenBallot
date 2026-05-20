'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parsePuEntry } = require('../lib/parse');

const sample = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'sample_pu_entry.json'), 'utf-8')
);
const sampleNoDoc = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'sample_pu_no_document.json'), 'utf-8')
);

test('parses a PU entry with an uploaded EC8A document', () => {
  const out = parsePuEntry(sample);
  assert.ok(out, 'expected non-null parse result');
  assert.equal(out.extracted.pu_code, sample.pu_code);
  assert.equal(out.image_url, sample.document.url);
  assert.ok(out.image_url.startsWith('http'), 'image_url should be absolute');
  assert.equal(out.raw_meta.irev_election_id, sample.election_id);
  assert.equal(out.raw_meta.irev_record_id, sample._id);
  // Vote counts intentionally absent in the MVP — image is canonical (ADR-0001).
  assert.equal(out.extracted.candidate_votes, null);
  assert.equal(out.extracted.total_valid_votes, null);
});

test('returns null when the PU has no uploaded document', () => {
  assert.equal(parsePuEntry(sampleNoDoc), null);
});

test('returns null for empty / malformed inputs', () => {
  assert.equal(parsePuEntry(null), null);
  assert.equal(parsePuEntry(undefined), null);
  assert.equal(parsePuEntry({}), null);
  assert.equal(parsePuEntry({ pu_code: 'X' }), null); // no document
  assert.equal(parsePuEntry({ document: { url: 'x' } }), null); // no pu_code
});

test('exposes submitted_at as ISO from result_updated_time epoch', () => {
  const out = parsePuEntry(sample);
  if (sample.result_updated_time) {
    assert.match(out.raw_meta.submitted_at, /^\d{4}-\d{2}-\d{2}T/);
  }
});

test('flags is_zero_pu correctly', () => {
  const zero = { ...sample, is_zero_pu: true };
  const out = parsePuEntry(zero);
  assert.equal(out.raw_meta.is_zero_pu, true);
});
