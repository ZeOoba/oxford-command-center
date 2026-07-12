// tests/unit/test-isolation.test.ts
//
// Regression guard for the cross-file test-state leakage class.
//
// Root cause (fixed in this change): vitest.config.ts had `isolate: false`. With isolation OFF,
// EVERY test file shares ONE module registry in the single worker thread, so two things bleed
// across files in order-dependent ways:
//   1. module-level singletons / caches, and
//   2. unreset `vi.mock` registrations (e.g. governance-check's `vi.mock('node:fs')`).
// The result is flakes that PASS in isolation and on re-run but FAIL intermittently in the full
// suite depending on file execution order (the CI-reliability risk, since gate:ci runs it).
//
// Per-file isolation removes the class BY CONSTRUCTION: each file gets a fresh module registry
// (threads pool) or a fresh OS process (forks pool), so nothing one file mutates can reach
// another. Either pool buys this; isolation costs us nothing regardless of which one is active.
//
// Pool choice (updated 2026-07-12): `forks`, NOT `threads`. Root-caused via systematic-debugging
// after `npm run gate`/`npm run test` segfaulted 4/4 reproductions under `pool: 'threads'` —
// always at end-of-suite, content-independent. Root cause: `better-sqlite3` (a native N-API
// module) is not documented-safe across Vitest's `threads`-pool worker-thread teardown — this is
// Vitest's own documented threads-pool failure class, which is why Vitest itself changed its
// default pool away from `threads`. `forks` (separate OS processes, no shared native-handle
// lifecycle) ran the full suite with zero segfaults. The prior claim that `forks` hit a "tinypool
// spawn fault" on this Node 24 + Windows box was re-tested directly and did not reproduce —
// see vitest.config.ts's own comment for the full history. If a forks spawn fault resurfaces,
// re-verify before reverting to threads; threads has its own confirmed segfault risk here.
//
// We assert against the config SOURCE rather than importing it: importing vitest.config.ts pulls
// in Vite, which trips a TextEncoder/Uint8Array invariant under the jsdom test environment. The
// regexes are anchored to line-start, so the explanatory comments above (which begin with `//`)
// cannot false-match the active settings. This guard fails loudly if anyone disables isolation
// or switches the pool away from forks without updating this guard deliberately.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CONFIG_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'vitest.config.ts'),
  'utf8',
);

describe('vitest harness — per-file isolation (regression guard)', () => {
  it('never sets isolate: false (the cross-file leakage footgun)', () => {
    expect(CONFIG_SRC).not.toMatch(/^\s*isolate:\s*false\b/m);
  });

  it('explicitly keeps isolate ON', () => {
    expect(CONFIG_SRC).toMatch(/^\s*isolate:\s*true\b/m);
  });

  it('pins the forks pool — threads segfaults with better-sqlite3 on Node 24 + Windows', () => {
    expect(CONFIG_SRC).toMatch(/^\s*pool:\s*'forks'/m);
  });
});
