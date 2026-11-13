// tests/unit/deploy-mirror-priority.test.ts
//
// 2026-11-13: the mirror deploy ran at Task Scheduler's default Priority 7 (below-normal CPU, very-low
// I/O) and, under sustained load, took 9-15 minutes to reach its first script line. Besides
// registering the task at Priority 5 (register-mirror-task-priority.test.ts), deploy-mirror.ps1
// raises its own CPU class to Normal as its first statement, so a task registered by an older
// script or a manual launch from a low-priority shell is not starved either.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const raw = readFileSync(join(process.cwd(), 'scripts', 'deploy-mirror.ps1'), 'utf8');
const code = raw
  .split(/\r?\n/)
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

/** The raise block exactly as it appears in the script: `& { try { $selfProc = ... } catch { } }`. */
const block = /& \{\s*\n\s*try \{\s*\n\s*\$selfProc = Get-Process[\s\S]*?\} catch \{ \}\s*\n\}/.exec(code)?.[0];

describe('deploy-mirror.ps1 raises its own priority first', () => {
  it('the raise block exists and is wrapped so it can never fail the run', () => {
    expect(block, 'priority-raise try/catch block').toBeDefined();
    expect(block).toMatch(/\.PriorityClass = \[System\.Diagnostics\.ProcessPriorityClass\]::Normal/);
  });

  it('runs after param() and before every other statement (dot-sources, beacon, step log)', () => {
    const at = (re: RegExp) => {
      const m = re.exec(code);
      expect(m, String(re)).not.toBeNull();
      return m!.index;
    };
    const raise = at(/\$selfProc = Get-Process -Id \$PID/);
    expect(raise).toBeGreaterThan(at(/\[switch\]\$IncludeWarehouse\s*\n\)/));
    for (const later of [/\$ErrorActionPreference = 'Stop'/, /Mirror deploy starting/, /\. \(Join-Path \$PSScriptRoot 'lib\\deploy-alert\.ps1'\)/, /Write-DeployBeaconStart/, /Start-DeployStepLog/]) {
      expect(raise, String(later)).toBeLessThan(at(later));
    }
  });

  it.runIf(process.platform === 'win32')('raises BelowNormal and Idle to Normal, and never lowers a higher class', () => {
    for (const [from, expected] of [['BelowNormal', 'Normal'], ['Idle', 'Normal'], ['Normal', 'Normal'], ['AboveNormal', 'AboveNormal']] as const) {
      const script = `(Get-Process -Id $PID).PriorityClass = '${from}'\n${block}\n(Get-Process -Id $PID).PriorityClass.ToString()`;
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', timeout: 60_000 });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim().split(/\r?\n/).pop(), `from ${from}`).toBe(expected);
    }
  }, 120_000);
});
