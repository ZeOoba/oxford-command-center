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
    // testTimeout/hookTimeout: 60s, not vitest's 5000ms/10000ms defaults (2026-09-07).
    // This suite's slow tests are slow because of OS latency - spawning processes, opening
    // better-sqlite3 databases, writing ExcelJS workbooks, shelling out to git - not
    // because of the logic under test. On a loaded Windows runner with on-access AV
    // scanning that latency swings by 3x to nearly 90x, so a fixed millisecond budget
    // silently encodes the calibrating machine's speed and fails on any slower or busier
    // one.
    //
    // Measured on LAPTOP-CSHSCBE6 across one full-suite session: six files timed out and
    // then passed in isolation moments later. Slowest test per file on an idle machine,
    // and the stall each needed to blow its budget - capital-allocation.integration
    // 1395ms (3.6x), calibration 1484ms (3.4x), install-git-hooks 551ms (9x),
    // safe-worktree 419ms (12x), debt-book-trust.round19b 67ms (75x), and
    // briefing-narrative-routes 344ms, which blew an already-raised 30000ms per-test
    // budget (87x). Patching files one at a time was whack-a-mole; the condition is
    // global, so the budget is too.
    //
    // hookTimeout moves with it. Hooks do the same IO as test bodies and would otherwise
    // become the weakest link at 6x tighter: warehouse-reconcile-noi.test.ts's beforeAll
    // opens a warehouse, writes two ExcelJS fixtures and ingests both, which is work
    // comparable to the 1395ms body above; and bash-guard.test.ts's beforeAll spawns nine
    // git processes, which that file prices at ~190ms each under load on this box.
    //
    // For the same reason, no per-test `{ timeout: N }` below this value should be
    // reintroduced: a local budget silently overrides this one (a per-test option wins
    // over config) and brings the flake back. 25 such sites were removed when this landed:
    // 21 x 30000ms across the briefing tests (including the 87x case above), 2 x 10s in
    // the module tests, and a 45s/20s pair in ar-import-headless-lease-status. The
    // `waitFor(..., { timeout: 3000 })` calls in the .tsx tests are NOT this - that is
    // testing-library assertion polling, not a test budget, and it stays.
    //
    // This is a HANG guard: it catches a wedged subprocess, a wedged SQLite/ExcelJS write,
    // or an unresolved promise. It is NOT a performance budget, and nothing here should
    // treat it as one. Where a perf property genuinely needs guarding, assert a counted
    // quantity instead - tests/unit/bash-guard.test.ts bounds alias resolution by counting
    // `git config` spawns via GIT_TRACE2_EVENT rather than by timing them.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One private temp root per run (redirects os.tmpdir(), removed afterwards) - the suite's ~130 mkdtemp
    // users mostly never clean up and filled the CI runner's disk. See tests/support/temp-run-dir.ts.
    globalSetup: ['./tests/global-setup.ts'],
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
