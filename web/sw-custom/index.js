// Background-sync drainer.
//
// next-pwa appends this file to the generated service worker. When the
// browser fires a 'sync' event tagged 'drain-uploads' (or the page posts
// a manual 'drain-uploads' message) we walk the IndexedDB submission
// queue and finish any uploads that didn't complete in the foreground.
//
// The SW can't touch localStorage, so the auth token + worker URL are
// mirrored into a separate IndexedDB ('openballot-auth') by
// auth-client.ts at login time.

const QUEUE_DB = 'openballot-queue';
const QUEUE_STORE = 'submissions';
const AUTH_DB = 'openballot-auth';
const AUTH_STORE = 'session';

self.addEventListener('sync', (event) => {
  if (event.tag === 'drain-uploads') {
    event.waitUntil(drainQueue());
  }
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'drain-uploads') {
    event.waitUntil(drainQueue());
  }
});

async function drainQueue() {
  const auth = await readAuth();
  if (!auth || !auth.token || !auth.worker) return;
  if (auth.exp && new Date(auth.exp).getTime() <= Date.now()) return;

  const db = await openQueueDb();
  const rows = await getAllQueueRows(db);
  const now = Date.now();
  for (const row of rows) {
    if (row.submission_id) continue;
    if ((row.next_attempt_at || 0) > now) continue;
    try {
      const presigned = await presign(auth, row);
      await putBlob(presigned.upload_url, row.image_blob, row.image_sha256, auth);
      const ack = await ingest(auth, row, presigned.image_url);
      await updateRow(db, row.id, {
        submission_id: ack.submission_id,
        last_status: ack.processing_status,
      });
    } catch (e) {
      const retries = (row.retries || 0) + 1;
      const backoff = Math.min(60_000, Math.pow(2, retries) * 1000);
      await updateRow(db, row.id, {
        retries,
        next_attempt_at: Date.now() + backoff,
      });
    }
  }
}

// ---- IndexedDB helpers ------------------------------------------------

function openQueueDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(QUEUE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openAuthDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(AUTH_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(AUTH_STORE)) {
        db.createObjectStore(AUTH_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function readAuth() {
  return openAuthDb().then(
    (db) =>
      new Promise((resolve) => {
        const tx = db.transaction(AUTH_STORE, 'readonly');
        const r = tx.objectStore(AUTH_STORE).get('current');
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      })
  );
}

function getAllQueueRows(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readonly');
    const r = tx.objectStore(QUEUE_STORE).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
}

function updateRow(db, id, patch) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readwrite');
    const store = tx.objectStore(QUEUE_STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const row = getReq.result;
      if (!row) return resolve();
      const merged = Object.assign({}, row, patch);
      const putReq = store.put(merged);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// ---- Upload pipeline (mirror of lib/uploads.ts) ----------------------

function authHeaders(auth) {
  return {
    Authorization: 'Bearer ' + auth.token,
    'X-Device-Fingerprint': auth.fp,
  };
}

async function presign(auth, row) {
  const r = await fetch(auth.worker + '/v1/uploads/presign', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders(auth)),
    body: JSON.stringify({
      election_id: row.election_id,
      pu_code: row.pu_code,
      content_type: row.image_blob.type || 'image/jpeg',
      content_length: row.image_bytes,
      sha256: row.image_sha256,
    }),
  });
  if (!r.ok) throw new Error('presign failed: HTTP ' + r.status);
  return r.json();
}

async function putBlob(url, blob, sha256_hex) {
  const sha256_b64 = hexToBase64(sha256_hex);
  const r = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': blob.type || 'image/jpeg',
      'x-amz-checksum-sha256': sha256_b64,
    },
    body: blob,
  });
  if (!r.ok) throw new Error('upload failed: HTTP ' + r.status);
}

async function ingest(auth, row, image_url) {
  const r = await fetch(auth.worker + '/v1/ingest', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders(auth)),
    body: JSON.stringify({
      election_id: row.election_id,
      pu_code: row.pu_code,
      source_type: row.source_type,
      party_code: row.party_code,
      image_url: image_url,
      image_sha256: row.image_sha256,
      image_bytes: row.image_bytes,
      gps: row.gps ? { lat: row.gps.lat, lng: row.gps.lng, acc: row.gps.acc } : null,
      captured_at: row.captured_at,
      client_submission_uuid: row.client_submission_uuid,
    }),
  });
  if (!r.ok && r.status !== 202) throw new Error('ingest failed: HTTP ' + r.status);
  return r.json();
}

function hexToBase64(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
