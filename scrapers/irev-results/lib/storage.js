'use strict';

// S3-compatible storage uploader (MinIO in dev, Cloudflare R2 in prod).
// We mirror every EC8A image to our own bucket so the hash manifest is
// self-contained: an auditor downloads the manifest + the bucket and can
// re-verify everything offline.

const crypto = require('crypto');

const config = require('../config');

let _client = null;
let _sdk = null;

function _loadSdk() {
  if (_sdk) return _sdk;
  _sdk = require('@aws-sdk/client-s3');
  return _sdk;
}

function client() {
  if (_client) return _client;
  const { S3Client } = _loadSdk();
  _client = new S3Client({
    endpoint: config.storage.endpoint,
    region: config.storage.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.storage.accessKey,
      secretAccessKey: config.storage.secretKey,
    },
  });
  return _client;
}

function objectKey({ electionId, puCode }) {
  return config.storage.keyTemplate
    .replace('{election_id}', electionId)
    .replace('{pu_code}', puCode);
}

async function existsByKey(key) {
  const { HeadObjectCommand } = _loadSdk();
  try {
    await client().send(new HeadObjectCommand({ Bucket: config.storage.bucket, Key: key }));
    return true;
  } catch (e) {
    if (e.$metadata?.httpStatusCode === 404) return false;
    throw e;
  }
}

async function uploadImage({ electionId, puCode, bytes, contentType }) {
  const key = objectKey({ electionId, puCode });
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

  if (config.dryRun) {
    return { key, sha256, bytes: bytes.length, skipped: true };
  }

  const { PutObjectCommand } = _loadSdk();
  await client().send(
    new PutObjectCommand({
      Bucket: config.storage.bucket,
      Key: key,
      Body: bytes,
      ContentType: contentType,
      ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
      Metadata: { 'sha256-hex': sha256, source: 'inec_irev' },
    })
  );

  // The CDN URL is bucket+key; bucket policy makes it publicly readable.
  const url = `${config.storage.endpoint.replace(/\/$/, '')}/${config.storage.bucket}/${key}`;
  return { key, sha256, bytes: bytes.length, url };
}

module.exports = { uploadImage, objectKey, existsByKey };
