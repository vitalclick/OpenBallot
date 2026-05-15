'use strict';

// Pilot report generator.
//
// Reads the captured fixtures + the database state after a pilot run and
// produces a structured report covering:
//
//   * coverage         - PUs attempted vs PUs in IReV vs PUs missing
//   * parse success    - shapes encountered + per-shape success rate
//   * image integrity  - DB SHA-256 vs recomputed-from-storage SHA-256 sample
//   * audit chain      - whole-chain verification result
//   * latency / cost   - p50/p95/p99 fetch time, total bytes uploaded
//
// The report is the deliverable: it either says "ship the full scrape" or
// "here is exactly what to fix in the parser before we ship it".

const fs = require('fs');
const path = require('path');

const fixtureCapture = require('./fixture_capture');

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function bytesHuman(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function build({ runStats, dbStats, chainResult }) {
  const fixtureSummary = fixtureCapture.summariseByOutcome();

  const report = {
    generated_at: new Date().toISOString(),
    pilot: {
      state: runStats.state,
      election: runStats.election,
      pus_in_registry: runStats.pus_in_registry,
      pus_attempted: runStats.pus_attempted,
      pus_succeeded: runStats.pus_succeeded,
      pus_not_uploaded: runStats.pus_not_uploaded,
      pus_errored: runStats.pus_errored,
      success_rate_pct:
        runStats.pus_attempted > 0
          ? Number(((runStats.pus_succeeded / runStats.pus_attempted) * 100).toFixed(2))
          : 0,
      iREV_coverage_pct:
        runStats.pus_in_registry > 0
          ? Number(
              (
                ((runStats.pus_succeeded + runStats.pus_not_uploaded ? runStats.pus_succeeded : 0) /
                  runStats.pus_in_registry) *
                100
              ).toFixed(2)
            )
          : 0,
    },
    fixtures: {
      total_captured: fixtureSummary.total,
      by_outcome: fixtureSummary.by_outcome,
      exemplar_paths: fixtureSummary.exemplars,
    },
    latency: {
      samples: runStats.latencies_ms.length,
      p50_ms: percentile(runStats.latencies_ms, 50),
      p95_ms: percentile(runStats.latencies_ms, 95),
      p99_ms: percentile(runStats.latencies_ms, 99),
    },
    bandwidth: {
      bytes_downloaded: runStats.bytes_downloaded,
      bytes_human: bytesHuman(runStats.bytes_downloaded),
      avg_image_bytes:
        runStats.images_downloaded > 0
          ? Math.round(runStats.bytes_downloaded / runStats.images_downloaded)
          : 0,
    },
    storage: {
      images_uploaded: runStats.images_uploaded,
      hash_check_sampled: dbStats.hash_check_sampled,
      hash_check_matches: dbStats.hash_check_matches,
    },
    audit_chain: chainResult,
    verdict: _verdict(runStats, fixtureSummary, chainResult),
  };

  return report;
}

function _verdict(runStats, fixtureSummary, chainResult) {
  const issues = [];
  if (runStats.pus_attempted === 0) issues.push('no PUs attempted - configuration error');
  if (runStats.pus_succeeded === 0 && runStats.pus_attempted > 0) {
    issues.push('zero successful scrapes - parser likely incompatible with current IReV schema');
  }
  if (chainResult && chainResult.ok === false) {
    issues.push(`audit chain broken at seq=${chainResult.first_broken_seq}`);
  }
  const successRate =
    runStats.pus_attempted > 0 ? runStats.pus_succeeded / runStats.pus_attempted : 0;
  if (successRate > 0 && successRate < 0.5) {
    issues.push(
      `low success rate (${(successRate * 100).toFixed(1)}%) - investigate unrecognised shapes before full scrape`
    );
  }
  const unrecognised =
    (fixtureSummary.by_outcome && fixtureSummary.by_outcome.unparseable) || 0;
  if (unrecognised > 0) {
    issues.push(`${unrecognised} unrecognised payload shape(s) captured - update lib/parse.js`);
  }

  return {
    ship_full_scrape: issues.length === 0 && successRate >= 0.9,
    issues,
  };
}

function writeReport(report, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
}

function asMarkdown(report) {
  const r = report;
  return [
    `# IReV Pilot Report`,
    ``,
    `_Generated ${r.generated_at}_`,
    ``,
    `## Coverage`,
    ``,
    `| Metric | Value |`,
    `|---|---|`,
    `| State scraped | ${r.pilot.state || 'all'} |`,
    `| Election | ${r.pilot.election || 'all'} |`,
    `| PUs in geo registry | ${r.pilot.pus_in_registry.toLocaleString()} |`,
    `| PUs attempted | ${r.pilot.pus_attempted.toLocaleString()} |`,
    `| PUs scraped successfully | ${r.pilot.pus_succeeded.toLocaleString()} |`,
    `| PUs missing from IReV | ${r.pilot.pus_not_uploaded.toLocaleString()} |`,
    `| PUs errored | ${r.pilot.pus_errored.toLocaleString()} |`,
    `| Success rate | ${r.pilot.success_rate_pct}% |`,
    ``,
    `## Parser outcomes`,
    ``,
    Object.entries(r.fixtures.by_outcome)
      .map(([k, v]) => `- **${k}**: ${v} (example: \`${r.fixtures.exemplar_paths[k] || 'n/a'}\`)`)
      .join('\n') || '_no fixtures captured_',
    ``,
    `## Latency`,
    ``,
    `p50 ${r.latency.p50_ms}ms / p95 ${r.latency.p95_ms}ms / p99 ${r.latency.p99_ms}ms (n=${r.latency.samples})`,
    ``,
    `## Bandwidth`,
    ``,
    `${r.bandwidth.bytes_human} downloaded; ${r.bandwidth.avg_image_bytes.toLocaleString()} B avg per image.`,
    ``,
    `## Storage integrity`,
    ``,
    `${r.storage.hash_check_matches}/${r.storage.hash_check_sampled} recomputed hashes match DB record.`,
    ``,
    `## Audit chain`,
    ``,
    r.audit_chain
      ? r.audit_chain.ok
        ? `Chain verified across ${r.audit_chain.events_checked} events.`
        : `**BROKEN** at seq=${r.audit_chain.first_broken_seq}`
      : '_audit chain not verified_',
    ``,
    `## Verdict`,
    ``,
    r.verdict.ship_full_scrape
      ? `**Ready to ship the full scrape.**`
      : `**Hold the full scrape.** Issues:\n${r.verdict.issues.map((i) => `  - ${i}`).join('\n')}`,
    ``,
  ].join('\n');
}

module.exports = { build, writeReport, asMarkdown };
