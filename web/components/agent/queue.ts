// Offline-first submission queue.
//
// Submissions are persisted to IndexedDB the moment the user taps "Submit".
// A background drainer retries uploads with exponential backoff until each
// submission lands. The drainer is wired into AgentFlow's mount lifecycle
// so it ticks every few seconds when the page is open; a service-worker-
// registered drainer takes over when the tab is closed (production
// only; dev mode skips the SW per next.config.mjs).
//
// Each successful drain runs:
//   1. presignUpload    /v1/uploads/presign          (worker)
//   2. uploadBytes      direct browser -> R2 PUT
//   3. submitIngestion  /v1/ingest                   (worker, 202)
// On any step's failure we leave the row in the queue with exponential
// backoff. The SHA-256 is computed once at queue-time and travels with
// the bytes, so a re-attempt uses the same hash that the presign was
// bound to.

import { presignUpload, submitIngestion, uploadBytes } from '@/lib/uploads';

const DB_NAME = 'openballot-queue';
const STORE = 'submissions';
const DB_VERSION = 1;

export interface QueuedSubmission {
  id?: number;
  election_id: string;
  pu_code: string;
  source_type: 'party_agent' | 'observer';
  party_code: string | null;
  image_blob: Blob;
  image_sha256: string;
  image_bytes: number;
  gps: { lat: number; lng: number; acc: number } | null;
  captured_at: string;
  client_submission_uuid: string;
  retries?: number;
  next_attempt_at?: number;
  // After a successful upload + ingest, we keep the row briefly with
  // the submission_id so the UI can poll status before it's purged.
  submission_id?: string;
  last_status?: 'queued' | 'processing' | 'extracted' | 'failed';
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const OfflineQueue = {
  async enqueue(s: QueuedSubmission): Promise<number> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).add({ ...s, retries: 0, next_attempt_at: Date.now() });
      req.onsuccess = () => resolve(req.result as number);
      req.onerror = () => reject(req.error);
    });
  },

  async depth(): Promise<number> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  /** Run one drain pass. Calls `onProgress` with each row's outcome so
   *  the UI can surface "uploading...", "submission accepted",
   *  "failed: ..." without coupling to the queue internals. */
  async drainOnce(onProgress?: (msg: DrainMessage) => void): Promise<number> {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return 0;
    }
    const db = await open();
    const all = await new Promise<QueuedSubmission[]>((res, rej) => {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).getAll();
      r.onsuccess = () => res(r.result as QueuedSubmission[]);
      r.onerror = () => rej(r.error);
    });
    let sent = 0;
    const now = Date.now();
    for (const s of all) {
      if (s.submission_id) continue;                  // already sent; let it age out
      if ((s.next_attempt_at ?? 0) > now) continue;

      try {
        onProgress?.({ kind: 'started', id: s.id! });

        const presigned = await presignUpload({
          election_id: s.election_id,
          pu_code: s.pu_code,
          content_type: s.image_blob.type || 'image/jpeg',
          content_length: s.image_bytes,
          sha256_hex: s.image_sha256,
        });
        onProgress?.({ kind: 'presigned', id: s.id! });

        await uploadBytes(presigned.upload_url, s.image_blob, s.image_sha256);
        onProgress?.({ kind: 'uploaded', id: s.id! });

        const ack = await submitIngestion({
          election_id: s.election_id,
          pu_code: s.pu_code,
          source_type: s.source_type,
          party_code: s.party_code,
          image_url: presigned.image_url,
          image_sha256: s.image_sha256,
          image_bytes: s.image_bytes,
          gps: s.gps ? { lat: s.gps.lat, lng: s.gps.lng, acc: s.gps.acc } : null,
          captured_at: s.captured_at,
          client_submission_uuid: s.client_submission_uuid,
        });
        onProgress?.({
          kind: 'accepted',
          id: s.id!,
          submission_id: ack.submission_id,
          status: ack.processing_status,
        });

        // Update the row in place with the submission_id; we keep it for
        // a short while so the UI can poll status, then purge after a
        // terminal state.
        await updateRow(db, s.id!, {
          submission_id: ack.submission_id,
          last_status: ack.processing_status,
        });
        sent += 1;
      } catch (e: any) {
        onProgress?.({ kind: 'error', id: s.id!, error: e?.message ?? String(e) });
        const retries = (s.retries ?? 0) + 1;
        const backoff = Math.min(60_000, 2 ** retries * 1000);
        await updateRow(db, s.id!, { retries, next_attempt_at: now + backoff });
      }
    }
    return sent;
  },

  /** Delete a submission row once the UI has acknowledged the
   *  terminal status (so it stops counting toward queue depth). */
  async forget(id: number): Promise<void> {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      const r = tx.objectStore(STORE).delete(id);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  },

  /** Return a lightweight, blob-free view of every row in the queue.
   *  Used by the QueuePanel UI so the agent can see what's stuck. */
  async list(): Promise<QueuedSubmissionView[]> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).getAll();
      r.onsuccess = () => {
        const rows = (r.result as QueuedSubmission[]).map((row) => ({
          id: row.id!,
          election_id: row.election_id,
          pu_code: row.pu_code,
          image_bytes: row.image_bytes,
          captured_at: row.captured_at,
          retries: row.retries ?? 0,
          next_attempt_at: row.next_attempt_at ?? null,
          submission_id: row.submission_id ?? null,
          last_status: row.last_status ?? null,
        }));
        resolve(rows);
      };
      r.onerror = () => reject(r.error);
    });
  },
};

/** Trigger a background-sync registration so the service worker drains
 *  the queue when connectivity returns, even if this tab is closed.
 *  Silently no-ops if the platform doesn't support SyncManager (Safari,
 *  Firefox at time of writing) — the in-page drainer still covers the
 *  foreground case. */
export async function requestBackgroundSync(): Promise<void> {
  if (typeof navigator === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = (await navigator.serviceWorker.ready) as ServiceWorkerRegistration & {
      sync?: { register: (tag: string) => Promise<void> };
    };
    if (reg.sync?.register) {
      await reg.sync.register('drain-uploads');
    }
  } catch {
    /* swallow; foreground drainer is the safety net */
  }
}

export interface QueuedSubmissionView {
  id: number;
  election_id: string;
  pu_code: string;
  image_bytes: number;
  captured_at: string;
  retries: number;
  next_attempt_at: number | null;
  submission_id: string | null;
  last_status: 'queued' | 'processing' | 'extracted' | 'failed' | null;
}

export type DrainMessage =
  | { kind: 'started'; id: number }
  | { kind: 'presigned'; id: number }
  | { kind: 'uploaded'; id: number }
  | { kind: 'accepted'; id: number; submission_id: string; status: string }
  | { kind: 'error'; id: number; error: string };

function updateRow(db: IDBDatabase, id: number, patch: Partial<QueuedSubmission>): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const row = getReq.result;
      if (!row) return resolve();
      const merged = { ...row, ...patch };
      const putReq = store.put(merged);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

export async function computeSha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
