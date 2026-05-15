'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const reporter = require('../lib/pilot_reporter');

function baseStats(overrides = {}) {
  return {
    state: 'Lagos',
    election: 'presidential',
    pus_in_registry: 8000,
    pus_attempted: 200,
    pus_succeeded: 195,
    pus_not_uploaded: 3,
    pus_errored: 2,
    latencies_ms: [120, 180, 220, 250, 310, 540, 800, 1200],
    bytes_downloaded: 200 * 800_000,
    images_downloaded: 200,
    images_uploaded: 200,
    ...overrides,
  };
}

test('verdict says ship when success rate is high and chain ok', () => {
  const r = reporter.build({
    runStats: baseStats(),
    dbStats: { hash_check_sampled: 5, hash_check_matches: 5 },
    chainResult: { ok: true, events_checked: 195 },
  });
  assert.equal(r.verdict.ship_full_scrape, true);
  assert.deepEqual(r.verdict.issues, []);
});

test('verdict holds when success rate is low', () => {
  const r = reporter.build({
    runStats: baseStats({ pus_succeeded: 40, pus_errored: 160 }),
    dbStats: { hash_check_sampled: 0, hash_check_matches: 0 },
    chainResult: { ok: true, events_checked: 40 },
  });
  assert.equal(r.verdict.ship_full_scrape, false);
  assert.ok(r.verdict.issues.some((i) => i.includes('low success rate')));
});

test('verdict holds when audit chain is broken', () => {
  const r = reporter.build({
    runStats: baseStats(),
    dbStats: { hash_check_sampled: 5, hash_check_matches: 5 },
    chainResult: { ok: false, first_broken_seq: 42 },
  });
  assert.equal(r.verdict.ship_full_scrape, false);
  assert.ok(r.verdict.issues.some((i) => i.includes('seq=42')));
});

test('verdict holds when zero PUs succeeded', () => {
  const r = reporter.build({
    runStats: baseStats({ pus_succeeded: 0, pus_errored: 200 }),
    dbStats: { hash_check_sampled: 0, hash_check_matches: 0 },
    chainResult: { ok: true, events_checked: 0 },
  });
  assert.equal(r.verdict.ship_full_scrape, false);
  assert.ok(r.verdict.issues.some((i) => i.includes('parser likely incompatible')));
});

test('percentiles roughly correct', () => {
  const r = reporter.build({
    runStats: baseStats({ latencies_ms: [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000] }),
    dbStats: { hash_check_sampled: 5, hash_check_matches: 5 },
    chainResult: { ok: true, events_checked: 195 },
  });
  // p50 should be in the middle of the sorted array
  assert.ok(r.latency.p50_ms >= 500 && r.latency.p50_ms <= 600);
  assert.ok(r.latency.p95_ms >= 900);
});

test('markdown rendering does not throw on a valid report', () => {
  const r = reporter.build({
    runStats: baseStats(),
    dbStats: { hash_check_sampled: 5, hash_check_matches: 5 },
    chainResult: { ok: true, events_checked: 195 },
  });
  const md = reporter.asMarkdown(r);
  assert.ok(md.includes('# IReV Pilot Report'));
  assert.ok(md.includes('## Coverage'));
  assert.ok(md.includes('## Verdict'));
});
