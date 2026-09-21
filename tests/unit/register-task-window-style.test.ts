// tests/unit/register-task-window-style.test.ts
//
// Weekly sweep 2026-09-21: the 2026-09-18 -WindowStyle Hidden fix (#338) reached
// register-mirror-task.ps1 only. register-mirror-classify-offfleet-task.ps1 kept building its action
// with no window style, so the live 'ORA Mirror Deploy Classifier' task still opened a focus-stealing
// console on the interactive desktop and last exited 3221225786 (0xC000013A, console closed) -- the
// exact signature #338 diagnosed. A per-file fix is precisely how that was missed, so this scans EVERY
// register-*-task.ps1: any scheduled-task action that launches pwsh/powershell must hide its window,
// either via the shared Get-MirrorTaskArguments helper or a literal `-WindowStyle Hidden` that comes
// BEFORE -File (PowerShell stops parsing switches at the first positional token).
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const scriptsDir = join(process.cwd(), 'scripts');
const registerScripts = readdirSync(scriptsDir).filter((f) => /^register-.*-task\.ps1$/.test(f));

describe('scheduled-task registration scripts hide the console window', () => {
  it('finds the registration scripts (guards the glob itself)', () => {
    expect(registerScripts).toEqual(
      expect.arrayContaining([
        'register-mirror-task.ps1',
        'register-mirror-classify-offfleet-task.ps1',
        'register-brain-server-task.ps1',
      ]),
    );
  });

  it.each(registerScripts)('%s builds a hidden-window action', (file) => {
    const text = readFileSync(join(scriptsDir, file), 'utf8');
    // Ignore comment lines so a doc mention of -WindowStyle cannot satisfy the check.
    const code = text
      .split(/\r?\n/)
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).toMatch(/New-ScheduledTaskAction/);

    const usesHelper =
      /\.\s+\(Join-Path \$PSScriptRoot 'lib\\mirror-task-action\.ps1'\)/.test(code) &&
      /Get-MirrorTaskArguments\s+-ScriptPath/.test(code);
    const literal = /-WindowStyle\s+Hidden[^\n]*-File/.test(code);
    expect(
      usesHelper || literal,
      `${file}: the task action must include -WindowStyle Hidden before -File`,
    ).toBe(true);
  });

  it('the shared helper still emits -WindowStyle Hidden before -File', () => {
    const lib = readFileSync(join(scriptsDir, 'lib', 'mirror-task-action.ps1'), 'utf8');
    expect(lib).toMatch(/-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File/);
  });
});
