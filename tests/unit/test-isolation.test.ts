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
// Per-file isolation removes the class BY CONSTRUCTION: each file gets a fresh module registry,
// so nothing one file mutates can reach another. The threads pool isolates via worker_threads —
// it does NOT use the child_process spawn path that the forks pool hit on Node 24 + Windows, so
// isolation costs us nothing the original `isolate: false` was trying to buy.
//
// We assert against the config SOURCE rather than importing it: importing vitest.config.ts pulls
// in Vite, which trips a TextEncoder/Uint8Array invariant under the jsdom test environment. The
// regexes are anchored to line-start, so the explanatory comments above (which begin with `//`)
// cannot false-match the active settings. This guard fails loudly if anyone disables isolation
// or switches off the threads pool.
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

  it('pins the threads pool — isolation works there without the forks spawn fault', () => {
    expect(CONFIG_SRC).toMatch(/^\s*pool:\s*'threads'/m);
  });
});
