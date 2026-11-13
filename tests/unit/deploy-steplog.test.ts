import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 2026-11-13: Task Scheduler killed four overnight mirror deploys at the 30-minute limit and nothing
// recorded which step they were in. scripts/lib/deploy-steplog.ps1 writes one timestamped line per
// step to data/_state/mirror-deploy-steps.log; deploy-mirror.ps1 logs each step BEFORE running it.
const root = process.cwd();
const onWindows = process.platform === 'win32';
const lib = join(root, 'scripts', 'lib', 'deploy-steplog.ps1');

function ps(script: string) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

describe('scripts/lib/deploy-steplog.ps1', () => {
  it.runIf(onWindows)('logs <timestamp> <run id> <step> lines and caps the file before each run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'steplog-'));
    try {
      const log = join(dir, '_state', 'steps.log');
      // First run creates the folder and file.
      let r = ps(`. '${lib}'; $id = Start-DeployStepLog -Path '${log}' -MaxLines 5 -Detail 'checkout abc'; Write-DeployStep -Path '${log}' -RunId $id -Step 'git-fetch'; Write-Output "ID=$id"`);
      expect(r.status, r.out).toBe(0);
      const id = /ID=([0-9a-f]{8})/.exec(r.out)?.[1];
      expect(id).toBeDefined();
      let lines = readFileSync(log, 'utf8').trim().split(/\r?\n/);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}[+-]\\d\\d:\\d\\d ${id} start checkout abc$`));
      expect(lines[1]).toMatch(new RegExp(` ${id} git-fetch$`));

      // An over-cap file is trimmed to its newest MaxLines-1 lines, then the new start line lands.
      writeFileSync(log, Array.from({ length: 12 }, (_, i) => `old ${i}`).join('\n') + '\n');
      r = ps(`. '${lib}'; $null = Start-DeployStepLog -Path '${log}' -MaxLines 5`);
      expect(r.status, r.out).toBe(0);
      lines = readFileSync(log, 'utf8').trim().split(/\r?\n/);
      expect(lines).toHaveLength(5);
      expect(lines.slice(0, 4)).toEqual(['old 8', 'old 9', 'old 10', 'old 11']);
      expect(lines[4]).toMatch(/ [0-9a-f]{8} start$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it.runIf(onWindows)('never throws: an unwritable log path loses the line, not the deploy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'steplog-bad-'));
    try {
      // The log path is an existing DIRECTORY, so every write fails.
      const r = ps(`$ErrorActionPreference = 'Stop'; . '${lib}'; $id = Start-DeployStepLog -Path '${dir}'; Write-DeployStep -Path '${dir}' -RunId $id -Step 'x'; Write-Output 'SURVIVED'`);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('SURVIVED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('deploy-mirror.ps1 logs each step before running it', () => {
  const code = readFileSync(join(root, 'scripts', 'deploy-mirror.ps1'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  const at = (re: RegExp) => {
    const m = re.exec(code);
    expect(m, String(re)).not.toBeNull();
    return m!.index;
  };

  it('starts the log before the try block, and every step line precedes its step', () => {
    expect(at(/Start-DeployStepLog/)).toBeLessThan(at(/^try \{/m));
    const pairs: Array<[RegExp, RegExp]> = [
      [/-Step 'latch-check'/, /Assert-MirrorGateLatchClear -Path/],
      [/-Step 'buildroot-sync'/, /Sync-DeployBuildRoot -RepoRoot/],
      [/-Step "deps-check/, /Install-DeployBuildRootDeps -BuildRoot/],
      [/-Step 'copy-real-data'/, /Copy-RealDataIntoBuildRoot -RepoRoot/],
      [/-Step 'pre-deploy-access-probe'/, /Assert-MirrorPreDeployAccessGate -VerifyUrl/],
      [/-Step 'bake-and-build/, /npm run build:mirror/],
      [/-Step 'wrangler-deploy'/, /Invoke-MirrorWranglerDeploy `/],
      [/-Step 'post-deploy-access-gate-check'/, /\$gateTargets {2}= Get-AccessGateProbeTargets/],
    ];
    for (const [step, call] of pairs) expect(at(step), String(step)).toBeLessThan(at(call));
  });

  it('records the npm ci decision and both run outcomes', () => {
    expect(code).toMatch(/deps-installed \(npm ci ran\)/);
    expect(code).toMatch(/deps-current \(npm ci skipped\)/);
    expect(code).toMatch(/-Step 'end success'/);
    // Refute wf_fc335a58-0a1: a kill during alerting or lockdown containment must be attributable too.
    expect(at(/-Step 'failure-alert-send'/)).toBeLessThan(at(/Send-DeployFailureAlert -Reason \$reason/));
    expect(at(/-Step 'lockdown-containment'/)).toBeLessThan(at(/\$lockdown = Invoke-MirrorLockdownContainment/));
    expect(at(/-Step "containment \$outcome"/)).toBeGreaterThan(at(/\$lockdown = Invoke-MirrorLockdownContainment/));
    expect(at(/-Step 'deploy-timeout-gate-probe'/)).toBeLessThan(at(/Assert-AccessGateOnAllTargets -Targets \$timeoutTargets/));
    expect(at(/-Step 'exit failed'/)).toBeLessThan(at(/throw \$original/));
    expect(code).toMatch(/-Step 'exit success'/);
    expect(at(/catch \{\s*\n\s*\$original = \$_\s*\n\s*Write-DeployStep[^\n]*end failed/)).toBeGreaterThan(0);
  });
});
