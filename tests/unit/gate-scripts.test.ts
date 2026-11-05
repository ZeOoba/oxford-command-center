import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Maintenance-reduction bundle 1 (2026-11-05): the gate step list used to be hand-copied into
// CLAUDE.md ("11 steps") and drifted when check:css-tokens was added. package.json is the
// source of truth; this test pins the two intentional facts that docs used to restate by hand.
const root = process.cwd(); // vitest runs from the repo root (npm run test / gate)
const scripts: Record<string, string> = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8'),
).scripts;

const steps = (name: string): string[] =>
  scripts[name]!.split('&&').map((s) => s.trim().replace(/^npm run /, ''));

// CI runners have no live workbook / FINANCIALS_DIR, so these run only in the local gate.
const LOCAL_ONLY = ['reconcile', 'reconcile:noi-crosscheck', 'warehouse:verify', 'warehouse:drift'];
// CI builds and size-checks the bundle; the local gate does not.
const CI_ONLY = ['build', 'check:bundle'];

describe('gate scripts', () => {
  it('gate:ci is exactly gate minus LOCAL_ONLY plus CI_ONLY, in order', () => {
    const expected = [...steps('gate').filter((s) => !LOCAL_ONLY.includes(s)), ...CI_ONLY];
    expect(steps('gate:ci')).toEqual(expected);
  });

  it('every LOCAL_ONLY step is actually in gate', () => {
    for (const s of LOCAL_ONLY) expect(steps('gate')).toContain(s);
  });

  it('CLAUDE.md §6 describes every gate step', () => {
    const md = readFileSync(resolve(root, 'CLAUDE.md'), 'utf8');
    const section = md.slice(md.indexOf('## 6. Gate Requirements'));
    const block = section.slice(section.indexOf('```') + 3, section.indexOf('```', section.indexOf('```') + 3));
    const described = block.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
    for (const s of steps('gate')) expect(described, `CLAUDE.md §6 is missing "${s}"`).toContain(s);
  });
});
