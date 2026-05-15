'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { looksLikeResultPayload, expand } = require('../lib/endpoint_discovery');

test('looksLikeResultPayload accepts the three known IReV shapes', () => {
  assert.equal(looksLikeResultPayload({ result: { scores: [] } }), true);
  assert.equal(looksLikeResultPayload({ data: { results: {} } }), true);
  assert.equal(looksLikeResultPayload({ Votes: [] }), true);
});

test('looksLikeResultPayload rejects unrecognised shapes', () => {
  assert.equal(looksLikeResultPayload(null), false);
  assert.equal(looksLikeResultPayload({}), false);
  assert.equal(looksLikeResultPayload({ random: 'junk' }), false);
  assert.equal(looksLikeResultPayload({ result: {} }), false); // no scores or results inside
});

test('expand substitutes both tokens and URL-encodes them', () => {
  const url = expand(
    '/api/v1/elections/{election_id}/polling-units/{pu_code}',
    'presidential-2023',
    '25/11/04/007'
  );
  assert.ok(url.endsWith('/api/v1/elections/presidential-2023/polling-units/25%2F11%2F04%2F007'));
});

test('expand handles query-string template form', () => {
  const url = expand('/api/v1/pu/{pu_code}?election={election_id}', 'pres-2023', '25-11-04-007');
  assert.ok(url.endsWith('/api/v1/pu/25-11-04-007?election=pres-2023'));
});
