# ADR-0006: Presigned direct-to-storage uploads

- **Status**: Accepted
- **Date**: 2026-03-15
- **Deciders**: Technical lead

## Context

EC8A images are ~1 MB each. With 176k polling units × 3 sources
average × 5 ballot types, we expect ~2.6 million uploads over a
general election. Routing those bytes through the worker would
saturate the worker's bandwidth and memory, and would tie HTTP slots
up for the duration of the upload.

## Decision

**The PWA uploads directly browser → object storage via presigned
S3-compatible PUT URLs. The worker only sees the metadata.**

Three-step flow:
1. `POST /v1/uploads/presign` returns a one-shot, 5-minute URL bound
   to size + content-type + SHA-256.
2. Browser PUTs the bytes directly to R2 / MinIO with the
   `x-amz-checksum-sha256` header. Storage rejects mismatches.
3. `POST /v1/ingest` carries the resulting URL + sha256; the worker
   trusts neither blindly (the presign already enforced both; the
   worker does a HEAD as belt-and-braces).

## Alternatives considered

- **Multipart proxy through the worker**: rejected on bandwidth
  grounds. A 100Mbps worker saturates at 12 concurrent 1MB uploads
  per second; we need 150.
- **WebSockets for the upload**: same bandwidth problem.
- **Client-side encryption + bring-your-own bucket**: rejected.
  Citizens cannot verify a result they can't see; the EC8A images
  must be publicly readable.

## Consequences

**Easy**: the worker's HTTP layer never carries image bytes. Scaling
the worker is unrelated to scaling the upload path.

**Hard**: the constraints we want on uploads (size, content-type,
hash) have to be encoded at presign time and enforced by storage.
Operators must confirm storage SigV4 ChecksumSHA256 support before
deploying.

**Locked-in**: storage is the network boundary, not the worker. An
operator who moves to a storage provider that doesn't support
ChecksumSHA256 would have to add a HEAD-based verification step to
maintain the integrity guarantee.

## References

- `worker/app/uploads/router.py` - presign endpoint + authorisation rules
- `worker/app/uploads/s3_client.py` - boto3 signer
- `web/lib/uploads.ts` - browser-side three-step client
