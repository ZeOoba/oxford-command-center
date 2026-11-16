// tests/unit/register-mirror-task-priority.test.ts
//
// 2026-11-13: the mirror deploy task ran at Task Scheduler's default Priority 7 (below-normal CPU,
// very-low I/O and memory priority). Under sustained normal-priority load the 11:00 and 12:00 runs
// took 9 and 15 minutes just to reach their first script line and were killed at the 30-minute
// limit. register-mirror-task.ps1 must register the task at Priority 5 (normal), so a re-run of the
// script cannot silently drop the live task back to the default.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const code = readFileSync(join(process.cwd(), 'scripts', 'register-mirror-task.ps1'), 'utf8')
  .replace(/<#[\s\S]*?#>/g, '')
  .split(/\r?\n/)
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

describe('register-mirror-task.ps1 task priority', () => {
  it('registers the settings with -Priority 5 (normal), not the default 7', () => {
    const settings = /\$settings\s*=\s*New-ScheduledTaskSettingsSet\b[^\n]*/.exec(code)?.[0];
    expect(settings, 'the $settings = New-ScheduledTaskSettingsSet line').toBeDefined();
    expect(settings).toMatch(/-Priority\s+5\b/);
  });

  it('keeps the 30-minute execution limit unchanged', () => {
    expect(code).toMatch(/-ExecutionTimeLimit \(New-TimeSpan -Minutes 30\)/);
  });

  it('passes those settings to Register-ScheduledTask', () => {
    expect(code).toMatch(/Register-ScheduledTask\b[^\n]*-Settings \$settings/);
  });
});
