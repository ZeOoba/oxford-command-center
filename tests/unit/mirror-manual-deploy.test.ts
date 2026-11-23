import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Cross-repo audit 2026-11-23 (HIGH): the MANUAL `npm run deploy:mirror` uploaded the redacted bundle, which still carries
// the local-only ratified RCT, with no Access-gate check. It now runs scripts/deploy-mirror-manual.ps1 ->
// lib/mirror-manual-deploy.ps1, exercised for real (mocked network) by scripts/deploy-mirror-manual.smoke-test.ps1.
const root = process.cwd();
const onWindows = process.platform === 'win32';

describe('manual mirror deploy (scripts/deploy-mirror-manual.smoke-test.ps1)', () => {
  it.runIf(onWindows)(
    'passes: latch, pre-probe before build, bounded deploy, post-check, containment on exposure',
    () => {
      const r = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'deploy-mirror-manual.smoke-test.ps1')],
        { encoding: 'utf8', timeout: 150_000 },
      );
      const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
      expect(out).toContain('ALL PASS');
      expect(r.status, out).toBe(0);
    },
    180_000,
  );

  it('the manual path never calls wrangler outside the probed library function', () => {
    const strip = (s: string) =>
      s.replace(/<#[\s\S]*?#>/g, '').split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
    const wrapper = strip(readFileSync(join(root, 'scripts', 'deploy-mirror-manual.ps1'), 'utf8'));
    expect(wrapper).not.toMatch(/wrangler/i);
    expect(wrapper).toMatch(/Invoke-MirrorManualDeploy/);
    const lib = strip(readFileSync(join(root, 'scripts', 'lib', 'mirror-manual-deploy.ps1'), 'utf8'));
    const pre = lib.indexOf('Assert-MirrorPreDeployAccessGate');
    const build = lib.indexOf('& $Build');
    const deploy = lib.indexOf('Invoke-MirrorWranglerDeploy');
    expect(pre).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(pre);
    expect(deploy).toBeGreaterThan(build);
  });
});
