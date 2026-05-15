'use strict';

// Fixture capture - persist raw HTTP responses for offline inspection.
//
// The pilot is most useful when it produces evidence we can examine without
// re-hitting INEC. For every PU response (parseable or not), we write:
//
//   fixtures/captured/<election_id>/<pu_code>.json
//
// containing both the raw bytes and metadata (URL that won, status, content
// length, parse outcome). Unrecognised shapes are stored too - those are the
// ones we need to send to the parser maintainer to add a new branch.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'fixtures', 'captured');

function _ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function fixturePath(electionId, puCode) {
  const safePu = puCode.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(ROOT, electionId, `${safePu}.json`);
}

function persist({
  electionId,
  puCode,
  url,
  status,
  rawBody,
  parsedOk,
  parsedReason,
  imageContentType,
  imageBytes,
  imageSha256,
}) {
  const dir = path.join(ROOT, electionId);
  _ensureDir(dir);
  const record = {
    captured_at: new Date().toISOString(),
    election_id: electionId,
    pu_code: puCode,
    request: { url, status },
    parse: { ok: parsedOk, reason: parsedReason || null },
    image: imageBytes != null ? { content_type: imageContentType, bytes: imageBytes, sha256: imageSha256 } : null,
    raw: rawBody,
  };
  fs.writeFileSync(fixturePath(electionId, puCode), JSON.stringify(record, null, 2));
}

// Bucket captured fixtures by parser outcome - so the operator can quickly
// see "we saw N unrecognised shapes, here is one representative example
// from each".
function summariseByOutcome() {
  if (!fs.existsSync(ROOT)) return { total: 0, by_outcome: {} };
  const elections = fs.readdirSync(ROOT);
  const out = { total: 0, by_outcome: {}, exemplars: {} };
  for (const el of elections) {
    const dir = path.join(ROOT, el);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      const key = rec.parse.ok ? 'parsed' : (rec.parse.reason || 'unknown_failure');
      out.by_outcome[key] = (out.by_outcome[key] || 0) + 1;
      out.exemplars[key] = out.exemplars[key] || `${el}/${f}`;
      out.total += 1;
    }
  }
  return out;
}

module.exports = { persist, fixturePath, summariseByOutcome, ROOT };
