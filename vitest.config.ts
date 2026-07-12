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
    // pool: 'forks' (2026-07-12, superseding the prior threads pin below).
    // Root-caused via systematic-debugging after `npm run gate`/`npm run test` segfaulted
    // 4/4 reproductions under pool:'threads' — always at end-of-suite, content-independent
    // (a clean 0-failure run crashed on exit same as a run with a real test timeout; a
    // single small file never crashed; singleThread true vs false made no difference).
    // Root cause: `better-sqlite3` (a native N-API module — see package.json) is not
    // documented-safe across Vitest's `threads` pool worker-thread teardown; this is
    // Vitest's own documented threads-pool failure class (native modules -> segfault on
    // exit), which is why Vitest itself changed its default pool away from `threads`.
    // Switching to `forks` (separate OS processes, no shared native-handle lifecycle)
    // ran the full 224-file/2569-test suite with ZERO segfaults (verified 2026-07-12).
    // The OLD comment below this one claimed forks hit a "tinypool spawn fault" here —
    // that was re-tested directly and did NOT reproduce; whatever caused it appears to
    // have been fixed by a since-updated tinypool/vitest/npm version. If a forks spawn
    // fault resurfaces, re-verify before reverting to threads — that pool has its own
    // confirmed segfault risk with this repo's native dependencies.
    //
    // isolate MUST stay true regardless of pool. Forks pool isolates each test file in
    // its own OS process (at least as strong a boundary as threads' per-file module
    // registry) — so per-file isolation still costs nothing extra. The previous
    // `isolate: false` shared ONE module context across every file, which let
    // module-level state AND unreset `vi.mock` registrations (e.g. governance-check's
    // `vi.mock('node:fs')`) bleed across files in order-dependent ways — the cross-file
    // flake class this config exists to prevent. See tests/unit/test-isolation.test.ts
    // for the regression guard.
    pool: 'forks',
    isolate: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.{test,spec}.{ts,tsx}', 'src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Cover the business logic across BOTH spines and the client logic layer — not just the
      // formatter/contract helpers. `.tsx` view components stay out of scope (their logic lives in
      // the `.ts` hooks/helpers that ARE covered); entry/env/type-only files are excluded.
      include: ['server/**/*.ts', 'src/**/*.ts'],
      exclude: [
        'server/index.ts',
        'server/load-env.ts',
        'src/main.tsx',
        'src/**/*.d.ts',
        'src/contracts/**',
        '**/*.test.ts',
        '**/*.test.tsx',
      ],
    },
  },
});
