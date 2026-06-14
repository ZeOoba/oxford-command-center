import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@contracts': fileURLToPath(new URL('./src/contracts', import.meta.url)),
      '@analytics': fileURLToPath(new URL('./src/analytics', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // Node 24 + Windows: the default forks pool hits a tinypool spawn fault, so we
    // pin the THREADS pool (worker_threads, no child_process spawn path).
    //
    // isolate MUST stay true. The threads pool isolates each test file in its own
    // module registry WITHOUT spawning a process — so per-file isolation costs us
    // nothing the forks spawn fault was about. The previous `isolate: false` shared
    // ONE module context across every file, which let module-level state AND unreset
    // `vi.mock` registrations (e.g. governance-check's `vi.mock('node:fs')`) bleed
    // across files in order-dependent ways — the cross-file flake class this config
    // exists to prevent. See tests/unit/test-isolation.test.ts for the regression guard.
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
    isolate: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.{test,spec}.{ts,tsx}', 'src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/analytics/**', 'src/contracts/**', 'src/lib/**'],
    },
  },
});
