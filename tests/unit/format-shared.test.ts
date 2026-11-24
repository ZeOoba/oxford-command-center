// @vitest-environment node
// Tier 3 UI hygiene PR B (2026-11-23 review): percent, signed-percent, basis-point and $/SF
// formatting had private copies in several modules. One source now, and a guard keeps it that way.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fmtBps, fmtPct, fmtPsf, fmtSignedPct } from '../../src/analytics/format';

describe('shared formatters', () => {
  it('fmtSignedPct: + for zero and up, - below, one decimal by default', () => {
    expect(fmtSignedPct(0.026)).toBe('+2.6%');
    expect(fmtSignedPct(0)).toBe('+0.0%');
    expect(fmtSignedPct(-0.08)).toBe('-8.0%');
    expect(fmtSignedPct(0.026, 0)).toBe('+3%');
    expect(fmtSignedPct(null)).toBe('—');
    expect(fmtSignedPct(Number.NaN)).toBe('—');
  });

  it('fmtBps: signed whole basis points', () => {
    expect(fmtBps(0.0042)).toBe('+42 bps');
    expect(fmtBps(-0.0042)).toBe('-42 bps');
    expect(fmtBps(0)).toBe('+0 bps');
    expect(fmtBps(null)).toBe('—');
  });

  it('fmtPsf: dollars per SF, two decimals by default', () => {
    expect(fmtPsf(12.5)).toBe('$12.50');
    expect(fmtPsf(12.5, 0)).toBe('$13');
    expect(fmtPsf(null)).toBe('—');
    expect(fmtPsf(undefined)).toBe('—');
  });

  it('fmtPct with 0 digits matches the old ReportGate Math.round form on ordinary values', () => {
    for (const v of [0, 0.123, 0.5, 0.876, 1]) expect(fmtPct(v, 0)).toBe(`${Math.round(v * 100)}%`);
  });
});

/** Every .ts/.tsx file under src/modules. */
function moduleFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? moduleFiles(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

describe('no private copies of the shared formatters', () => {
  it('src/modules defines none of fmtPct, fmtSignedPct, fmtCapRate, fmtCapRateGap, fmtBps, fmtPsf', () => {
    // lease-market/hooks.ts keeps its own fmtPct deliberately: signed whole percent with explicit
    // -0 handling, a different contract that its callers rely on.
    const allowed = new Set([join('src', 'modules', 'lease-market', 'hooks.ts')]);
    const offenders: string[] = [];
    const def = /(?:function|const)\s+(fmtPct|fmtSignedPct|fmtCapRate|fmtCapRateGap|fmtBps|fmtPsf)\b/g;
    for (const f of moduleFiles(join('src', 'modules'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(def)) {
        if (!(allowed.has(f) && m[1] === 'fmtPct')) offenders.push(`${f}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
