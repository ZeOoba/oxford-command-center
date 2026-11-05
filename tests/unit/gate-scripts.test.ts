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

// Step names described by CLAUDE.md §6's first fenced block. Only lines containing the arrow
// count as step lines (first token before it is the step name); continuation lines are ignored.
const describedSteps = (md: string): string[] => {
  const section = md.slice(md.indexOf('## 6. Gate Requirements'));
  const open = section.indexOf('```') + 3;
  const block = section.slice(open, section.indexOf('```', open));
  return block
    .split('\n')
    .filter((l) => l.includes('→'))
    .map((l) => l.split('→')[0]!.trim().split(/\s+/)[0]!)
    .filter(Boolean);
};

describe('gate scripts', () => {
  it('gate:ci is exactly gate minus LOCAL_ONLY plus CI_ONLY, in order', () => {
    const expected = [...steps('gate').filter((s) => !LOCAL_ONLY.includes(s)), ...CI_ONLY];
    expect(steps('gate:ci')).toEqual(expected);
  });

  it('every LOCAL_ONLY step is actually in gate', () => {
    for (const s of LOCAL_ONLY) expect(steps('gate')).toContain(s);
  });

  it('CLAUDE.md §6 describes every gate step and nothing else', () => {
    const md = readFileSync(resolve(root, 'CLAUDE.md'), 'utf8');
    const described = describedSteps(md);
    const gate = steps('gate');
    for (const s of gate) expect(described, `CLAUDE.md §6 is missing "${s}"`).toContain(s);
    for (const s of described) expect(gate, `CLAUDE.md §6 describes "${s}", which is not in gate`).toContain(s);
  });
});

describe('describedSteps', () => {
  const fixture = [
    '## 6. Gate Requirements',
    '```',
    'governance   → validates things',
    'check:dev-css → boots the pipeline',
    '                continuation line, no arrow, ignored',
    'fake:step → x',
    '```',
  ].join('\n');

  it('takes the first token of each arrow line and ignores continuation lines', () => {
    expect(describedSteps(fixture)).toEqual(['governance', 'check:dev-css', 'fake:step']);
  });

  it('exposes a stale step (in §6 but not in gate)', () => {
    const gate = ['governance', 'check:dev-css'];
    expect(describedSteps(fixture).filter((s) => !gate.includes(s))).toEqual(['fake:step']);
  });
});
