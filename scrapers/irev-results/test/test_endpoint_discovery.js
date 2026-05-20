'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ed = require('../lib/endpoint_discovery');
const client = require('../lib/irev_client');

test('exports the contract verification surface', () => {
  assert.equal(typeof ed.verify, 'function');
  assert.ok(Array.isArray(ed.CONTRACT));
  assert.ok(Array.isArray(ed.PER_ELECTION_CONTRACT));
  for (const c of ed.CONTRACT) {
    assert.equal(typeof c.name, 'string');
    assert.equal(typeof c.run, 'function');
    assert.equal(typeof c.ok, 'function');
  }
});

test('client builds the live API base correctly', () => {
  assert.match(client.apiUrl('/elections'), /\/api\/v1\/elections$/);
  assert.match(client.apiUrl('elections'), /\/api\/v1\/elections$/);
});
