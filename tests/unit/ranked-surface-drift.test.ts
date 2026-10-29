import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Drift guards for signal discipline: the surface cap and the dollar ordering each have ONE home.
const SRC = join(__dirname, '../../src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe('ranked surfaces take their ceiling from MAX_ITEMS', () => {
  const CAPPED = ['modules/alerts/AlertsModule.tsx', 'modules/calendar/CalendarModule.tsx', 'modules/renewals/RenewalsModule.tsx'];

  it.each(CAPPED)('%s imports MAX_ITEMS from the shared module', (file) => {
    expect(read(file)).toMatch(/import\s*\{[^}]*\bMAX_ITEMS\b[^}]*\}\s*from\s*'[^']*lib\/ranked-cap'/);
  });

  it.each(CAPPED)('%s has no hard-coded row ceiling', (file) => {
    const src = read(file);
    expect(src).not.toMatch(/budget=\{\s*\d+\s*\}/);
  });
});

describe('dollar ordering has one implementation', () => {
  it('no module re-implements an impactUsd comparator outside src/lib/impact-score.ts', () => {
    const offenders = walk(SRC)
      .filter((f) => relative(SRC, f).replace(/\\/g, '/') !== 'lib/impact-score.ts')
      .filter((f) => /\bb\.(?:row\.)?impactUsd\s*-\s*a\.(?:row\.)?impactUsd\b/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f).replace(/\\/g, '/'));
    expect(offenders).toEqual([]);
  });
});
