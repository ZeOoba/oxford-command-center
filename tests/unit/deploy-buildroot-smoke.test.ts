import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// scripts/deploy-buildroot.smoke-test.ps1 was run-by-hand only. It now also pins the 2026-11-13
// regression where the build root's deps stamp was deleted by Sync-DeployBuildRoot's own
// `git clean -fd`, forcing a full `npm ci` on every hourly mirror deploy (overnight runs then hit
// the task's 30-minute limit). Run it here so the suite catches a regression.
const root = process.cwd();

describe('deploy build-root smoke test (scripts/deploy-buildroot.smoke-test.ps1)', () => {
  it.runIf(process.platform === 'win32')(
    'passes: isolation refusals, .env import, real-data copy, deps stamp survives git clean',
    () => {
      const r = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'deploy-buildroot.smoke-test.ps1')],
        { encoding: 'utf8', timeout: 150_000 },
      );
      const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
      expect(out).toContain('All deploy-buildroot assertions passed.');
      expect(r.status, out).toBe(0);
    },
    180_000,
  );
});
