// Fresh in-memory IndexedDB before every test so the queue and auth
// stores don't bleed state across specs.
import 'fake-indexeddb/auto';
import { beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

beforeEach(() => {
  // Reset the IDB instance — fake-indexeddb exposes a constructor we can
  // re-assign onto the global to reclaim the previous database.
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});
