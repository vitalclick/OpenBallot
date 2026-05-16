import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// jsdom gives us indexedDB-ready globals (window, crypto, btoa) so the
// queue + auth tests don't have to stub them out individually.
// fake-indexeddb is wired up per-test via setup.ts so each spec gets a
// clean database.

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['node_modules/**', '.next/**'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
    },
  },
});
