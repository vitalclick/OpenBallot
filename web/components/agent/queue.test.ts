import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { computeSha256Hex, OfflineQueue, type QueuedSubmission } from './queue';

// queue.ts imports lib/uploads, which imports lib/auth-client. The
// uploads module reads NEXT_PUBLIC_WORKER_URL at module load — that's
// fine; we just mock the three network functions so drainOnce can run
// deterministically.
vi.mock('@/lib/uploads', () => ({
  presignUpload: vi.fn(),
  uploadBytes: vi.fn(),
  submitIngestion: vi.fn(),
}));

import { presignUpload, submitIngestion, uploadBytes } from '@/lib/uploads';

function makeRow(overrides: Partial<QueuedSubmission> = {}): QueuedSubmission {
  return {
    election_id: '2027-presidential',
    pu_code: '25/11/04/007',
    source_type: 'party_agent',
    party_code: 'APC',
    image_blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' }),
    image_sha256: 'a'.repeat(64),
    image_bytes: 4,
    gps: { lat: 6.5, lng: 3.35, acc: 8 },
    captured_at: '2027-02-27T17:43:22Z',
    client_submission_uuid: '00000000-0000-0000-0000-000000000001',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: pretend the browser is online so drainOnce doesn't bail.
  Object.defineProperty(globalThis.navigator, 'onLine', {
    value: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('computeSha256Hex', () => {
  it('hashes a known buffer to its SHA-256 hex digest', async () => {
    const buf = new TextEncoder().encode('abc').buffer;
    const hex = await computeSha256Hex(buf);
    // Known SHA-256("abc")
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('OfflineQueue.enqueue + depth + list', () => {
  it('persists a row and returns it via list()', async () => {
    await OfflineQueue.enqueue(makeRow({ pu_code: '01/02/03/004' }));
    expect(await OfflineQueue.depth()).toBe(1);
    const rows = await OfflineQueue.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].pu_code).toBe('01/02/03/004');
    expect(rows[0].retries).toBe(0);
    expect(rows[0].submission_id).toBeNull();
  });

  it('list() does not include the image_blob', async () => {
    await OfflineQueue.enqueue(makeRow());
    const rows = await OfflineQueue.list();
    expect(rows[0]).not.toHaveProperty('image_blob');
  });
});

describe('OfflineQueue.forget', () => {
  it('removes the row from the queue', async () => {
    await OfflineQueue.enqueue(makeRow());
    const [row] = await OfflineQueue.list();
    await OfflineQueue.forget(row.id);
    expect(await OfflineQueue.depth()).toBe(0);
  });
});

describe('OfflineQueue.drainOnce', () => {
  it('runs the three-stage upload pipeline and records the submission_id', async () => {
    vi.mocked(presignUpload).mockResolvedValue({
      upload_url: 'https://r2/upload',
      image_url: 'https://r2/object',
      object_key: 'k',
      expires_in_seconds: 600,
    });
    vi.mocked(uploadBytes).mockResolvedValue(undefined);
    vi.mocked(submitIngestion).mockResolvedValue({
      accepted: true,
      submission_id: 'sub-1',
      processing_status: 'queued',
      flags: {},
      poll_url: '/v1/submissions/sub-1',
    });

    await OfflineQueue.enqueue(makeRow());
    const sent = await OfflineQueue.drainOnce();
    expect(sent).toBe(1);
    expect(presignUpload).toHaveBeenCalledOnce();
    expect(uploadBytes).toHaveBeenCalledOnce();
    expect(submitIngestion).toHaveBeenCalledOnce();

    const [row] = await OfflineQueue.list();
    expect(row.submission_id).toBe('sub-1');
    expect(row.last_status).toBe('queued');
  });

  it('emits progress messages for each pipeline stage', async () => {
    vi.mocked(presignUpload).mockResolvedValue({
      upload_url: 'u',
      image_url: 'i',
      object_key: 'k',
      expires_in_seconds: 600,
    });
    vi.mocked(uploadBytes).mockResolvedValue(undefined);
    vi.mocked(submitIngestion).mockResolvedValue({
      accepted: true,
      submission_id: 'sub-2',
      processing_status: 'queued',
      flags: {},
      poll_url: '/p',
    });

    await OfflineQueue.enqueue(makeRow());
    const progress: string[] = [];
    await OfflineQueue.drainOnce((m) => progress.push(m.kind));
    expect(progress).toEqual(['started', 'presigned', 'uploaded', 'accepted']);
  });

  it('backs off exponentially on failure without losing the row', async () => {
    vi.mocked(presignUpload).mockRejectedValue(new Error('boom'));
    await OfflineQueue.enqueue(makeRow());

    const before = Date.now();
    await OfflineQueue.drainOnce();
    const [row] = await OfflineQueue.list();
    expect(row.retries).toBe(1);
    expect(row.submission_id).toBeNull();
    // Backoff is 2^1 * 1000 = 2000ms — at least 1.5s into the future.
    expect(row.next_attempt_at).not.toBeNull();
    expect(row.next_attempt_at! - before).toBeGreaterThanOrEqual(1500);
  });

  it('skips already-sent rows', async () => {
    vi.mocked(presignUpload).mockResolvedValue({
      upload_url: 'u',
      image_url: 'i',
      object_key: 'k',
      expires_in_seconds: 600,
    });
    vi.mocked(uploadBytes).mockResolvedValue(undefined);
    vi.mocked(submitIngestion).mockResolvedValue({
      accepted: true,
      submission_id: 'sub-3',
      processing_status: 'queued',
      flags: {},
      poll_url: '/p',
    });

    await OfflineQueue.enqueue(makeRow());
    await OfflineQueue.drainOnce();
    // Second drain should not re-call the pipeline.
    vi.mocked(presignUpload).mockClear();
    const sent = await OfflineQueue.drainOnce();
    expect(sent).toBe(0);
    expect(presignUpload).not.toHaveBeenCalled();
  });

  it('returns 0 immediately when the browser is offline', async () => {
    Object.defineProperty(globalThis.navigator, 'onLine', {
      value: false,
      configurable: true,
    });
    await OfflineQueue.enqueue(makeRow());
    const sent = await OfflineQueue.drainOnce();
    expect(sent).toBe(0);
    expect(presignUpload).not.toHaveBeenCalled();
  });
});
