import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Audit wf_9bf74429-aaf (2026-11-12), findings 1 and 4, on scripts/deploy-mirror.ps1.
//  1 (HIGH): wrangler ran with cwd = the SHARED checkout, so the Pages Functions deployed from a
//    possibly dirty tree next to the FULL confidential bake.
//  4 (MED): the Access gate was only checked after upload, and a failure left the FULL bake live.
// The behaviour lives in scripts/lib/mirror-deploy.ps1 and is exercised for real (mocked network) by
// scripts/mirror-deploy.smoke-test.ps1. The ORDER and wiring inside deploy-mirror.ps1 are pinned here
// against its source, comments stripped, because the script itself cannot run without Cloudflare.
const root = process.cwd();
const onWindows = process.platform === 'win32';

const code = readFileSync(join(root, 'scripts', 'deploy-mirror.ps1'), 'utf8')
  .split(/\r?\n/)
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

function indexOfOnce(needle: RegExp): number {
  const all = [...code.matchAll(new RegExp(needle.source, 'g'))];
  expect(all.length, `expected exactly one ${needle}`).toBe(1);
  return all[0]!.index!;
}

describe('mirror deploy smoke test (scripts/mirror-deploy.smoke-test.ps1)', () => {
  it.runIf(onWindows)(
    'passes: deploy cwd is the build root, pre-deploy probe, latch and lockdown containment',
    () => {
      const r = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'mirror-deploy.smoke-test.ps1')],
        { encoding: 'utf8', timeout: 150_000 },
      );
      const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
      expect(out).toContain('ALL PASS');
      expect(r.status, out).toBe(0);
    },
    180_000,
  );
});

describe('deploy-mirror.ps1 finding 1: Functions deploy from the isolated build root only', () => {
  it('wrangler is invoked through Invoke-MirrorWranglerDeploy with the build root as wrangler root AND working directory', () => {
    expect(code).toMatch(
      /Invoke-MirrorWranglerDeploy\s*`\s*-WranglerRoot \$buildRoot\s*`\s*-WorkingDirectory \$buildRoot\s*`\s*-DistPath \$distPath/,
    );
    // No other path to the native runner: a bare call would fall back to the caller's location ($repo).
    expect(code).not.toMatch(/Invoke-NativeCommandWithTimeout/);
    expect(code).not.toMatch(/pages', 'deploy'/);
  });

  it('the shared checkout is never a functions source', () => {
    expect(code).not.toMatch(/Join-Path \$repo 'functions'/);
    expect(code).toMatch(/\$functionsDirs = @\(Join-Path \$buildRoot 'functions'\)/);
  });

  it('the deploy cwd parameter reaches the child process (lib wiring)', () => {
    const lib = readFileSync(join(root, 'scripts', 'lib', 'mirror-deploy.ps1'), 'utf8');
    expect(lib).toMatch(/"--cwd=\$WorkingDirectory"/);
    expect(lib).toMatch(/WorkingDirectory\s*=\s*\$c\.WorkingDirectory/);
    const native = readFileSync(join(root, 'scripts', 'lib', 'native-timeout.ps1'), 'utf8');
    expect(native).toMatch(/\$psi\.WorkingDirectory = if \(\$WorkingDirectory\) \{ \$WorkingDirectory \}/);
  });
});

describe('deploy-mirror.ps1 finding 4: probe before the FULL bake, contain on failure', () => {
  it('latch check -> pre-deploy probe -> preprobe attestation -> FULL flag -> bake, in that order', () => {
    const latch = indexOfOnce(/Assert-MirrorGateLatchClear -Path \$gateLatchPath/);
    const probe = indexOfOnce(/Assert-MirrorPreDeployAccessGate -VerifyUrl \$VerifyUrl/);
    const attest = indexOfOnce(/\$env:MIRROR_ACCESS_PREPROBE\s*= 'passed'/);
    const full = indexOfOnce(/\$env:MIRROR_INCLUDE_CONFIDENTIAL = '1'/);
    const bake = indexOfOnce(/npm run build:mirror/);
    expect(latch).toBeLessThan(probe);
    expect(probe).toBeLessThan(attest);
    expect(attest).toBeLessThan(full);
    expect(full).toBeLessThan(bake);
  });

  it('the pre-deploy probe also covers JSON already staged in the build root public/', () => {
    expect(code).toMatch(/Assert-MirrorPreDeployAccessGate [^\n]*-StagedDir \(Join-Path \$buildRoot 'public'\)/);
  });

  it('FULL-mode variables are cleared before the run and in the finally block', () => {
    expect((code.match(/Remove-Item Env:\\MIRROR_ACCESS_PREPROBE/g) ?? []).length).toBe(2);
    expect((code.match(/Remove-Item Env:\\MIRROR_INCLUDE_CONFIDENTIAL/g) ?? []).length).toBe(2);
    const clear = code.indexOf('Remove-Item Env:\\MIRROR_ACCESS_PREPROBE');
    expect(clear).toBeLessThan(code.indexOf('try {'));
  });

  it('a GATE CHECK FAILED opens the latch before alerting, then runs the lockdown and alerts its outcome', () => {
    const catchAt = code.lastIndexOf('catch {\n  $original = $_');
    expect(catchAt).toBeGreaterThan(0);
    const tail = code.slice(catchAt);
    const setLatch = tail.indexOf('Set-MirrorGateLatch -Path $gateLatchPath');
    const firstAlert = tail.indexOf('Send-DeployFailureAlert -Reason $reason');
    const lockdown = tail.indexOf('Invoke-MirrorLockdownContainment -WranglerRoot $buildRoot');
    const secondAlert = tail.indexOf('containment ${outcome}');
    expect(setLatch).toBeGreaterThan(0);
    expect(setLatch).toBeLessThan(firstAlert);
    expect(firstAlert).toBeLessThan(lockdown);
    expect(lockdown).toBeLessThan(secondAlert);
    // Containment only on SERVED content (refute wf_ec2162a9-34f): the decision reads the exposures
    // the gate check recorded, and both the latch and the lockdown are gated on it.
    expect(tail).toMatch(/\$containGate = \$isGateFailure -and \(Test-MirrorExposureWarrantsContainment -Exposures \$exposures\)/);
    expect(tail).toMatch(/if \(\$containGate\) \{\s*try \{ Set-MirrorGateLatch/);
    expect(tail).toMatch(/if \(\$containGate -and \$buildRoot\) \{/);
    expect(tail).not.toMatch(/if \(\$isGateFailure\) \{\s*try \{ Set-MirrorGateLatch/);
    // Lockdown bounded below the scheduler's PT30M limit.
    expect(tail).toMatch(/-TimeoutSeconds \(\[Math\]::Min\(\$DeployTimeoutSeconds, 300\)\)/);
  });
});
