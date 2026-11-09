import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// mirror-gate-probe-apex-only (audit 2026-11-08). The deploy's Access-gate check is PowerShell
// (scripts/lib/access-gate-probe.ps1); this runs its smoke test, which dot-sources the REAL probe
// with a mocked curl, so a regression fails `npm test` instead of waiting for a by-hand run.
// PowerShell 5.1 ships with Windows only; the CI runners are the Windows laptop.
const root = process.cwd();
const smoke = join(root, 'scripts', 'access-gate-probe.smoke-test.ps1');

describe('access-gate probe (scripts/lib/access-gate-probe.ps1)', () => {
  it.runIf(process.platform === 'win32')(
    'smoke test passes: alias, snapshot.json and /api/ targets are all probed and any 2xx fails the gate',
    () => {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', smoke], {
        encoding: 'utf8',
        timeout: 120_000,
      });
      const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
      expect(out).toContain('ALL PASS');
      expect(r.status, out).toBe(0);
    },
    150_000,
  );

  it('deploy-mirror.ps1 verifies through the all-targets probe on both the success and timeout paths, never the apex-only form', () => {
    const src = readFileSync(join(root, 'scripts', 'deploy-mirror.ps1'), 'utf8');
    const code = src
      .split(/\r?\n/)
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).toContain("lib\\access-gate-probe.ps1");
    // success path requires the per-deployment alias (reported AFTER probing, via -Unprobed);
    // the timeout path probes whatever was printed
    expect(code).toMatch(/Get-MissingAliasRequirement -DeployOutput \$deployOutput/);
    expect(code).toMatch(/Assert-AccessGateOnAllTargets -Targets \$gateTargets[^\n]*-Unprobed \$gateUnprobed/);
    expect((code.match(/Assert-AccessGateOnAllTargets /g) ?? []).length).toBe(2);
    // the old single-URL call (apex only) must not come back
    expect(code).not.toMatch(/Invoke-AccessGateProbe -VerifyUrl \$VerifyUrl/);
    // wrangler output is captured so the alias can be parsed
    expect(code).toMatch(/-OutputFile \$deployLog/);
  });
});
