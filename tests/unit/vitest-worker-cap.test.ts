// @vitest-environment node
// tests/unit/vitest-worker-cap.test.ts
//
// Two self-hosted runners serve this repo on one 16-core laptop, so two gate jobs run at once.
// Vitest's default (cores - 1 forks per run) puts ~30 processes on 16 cores; every file then runs
// 5-90x slower than idle and unrelated tests blow the 60s budget (PRs 498/499/497, 2026-10-27).
// vitest.config.ts therefore caps workers when CI is set. Local runs keep vitest's default.
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadMaxWorkers(env: Record<string, string | undefined>): Promise<unknown> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    vi.resetModules();
    const mod = await import('../../vitest.config');
    return (mod.default as { test?: { maxWorkers?: unknown } }).test?.maxWorkers;
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('vitest.config maxWorkers', () => {
  afterEach(() => vi.resetModules());

  it('caps workers in CI', async () => {
    expect(await loadMaxWorkers({ CI: 'true', VITEST_MAX_WORKERS: undefined })).toBe(6);
  });

  it('honours VITEST_MAX_WORKERS in CI', async () => {
    expect(await loadMaxWorkers({ CI: 'true', VITEST_MAX_WORKERS: '3' })).toBe(3);
  });

  it('ignores a non-positive or non-numeric VITEST_MAX_WORKERS', async () => {
    expect(await loadMaxWorkers({ CI: 'true', VITEST_MAX_WORKERS: '0' })).toBe(6);
    expect(await loadMaxWorkers({ CI: 'true', VITEST_MAX_WORKERS: 'lots' })).toBe(6);
  });

  it('leaves vitest default outside CI', async () => {
    expect(await loadMaxWorkers({ CI: undefined, VITEST_MAX_WORKERS: undefined })).toBeUndefined();
  });
});
