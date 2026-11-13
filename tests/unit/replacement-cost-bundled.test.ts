// tests/unit/replacement-cost-bundled.test.ts
//
// bundledRct() is the drawer's only guard against shipping the synthetic RCT stand-in: a PRODUCTION Vite build of a
// checkout without the local-only ratified table bundles the stand-in, and the drawer must then price nothing rather
// than invented figures (docs/ops/rct-runtime-config.md). Under vitest import.meta.env.PROD is false, so the module's
// own RCT_V03 never exercises the refusal branch; this file calls the function directly for all four cases
// (independent review 2026-11-13: a mutation of the condition passed the whole suite).
import { describe, expect, it } from 'vitest';
import { bundledRct, fallbackFromConfig, rctFromConfig, scheduleFromConfig } from '../../src/brain/replacement-cost';
import { syntheticRctRaw } from '../support/rct';

/** The stand-in without its marker: invented figures standing in for the ratified table. */
function ratifiedLike(): Record<string, unknown> {
  const j = syntheticRctRaw();
  delete j._synthetic;
  return j;
}

describe('bundledRct: the production drawer refuses the synthetic stand-in', () => {
  it('production + synthetic => null, so the drawer prices nothing', () => {
    const synthetic = syntheticRctRaw();
    expect(synthetic._synthetic).toBe(true);
    const bundled = bundledRct(synthetic, true);
    expect(bundled).toBeNull();
    expect(rctFromConfig(bundled)).toEqual({});
    expect(fallbackFromConfig(bundled)).toBeNull();
    expect(scheduleFromConfig(bundled)).toBeNull();
  });

  it('production + a non-synthetic table => passed through unchanged (same object), and it prices', () => {
    const real = ratifiedLike();
    const bundled = bundledRct(real, true);
    expect(bundled).toBe(real);
    expect(Object.keys(rctFromConfig(bundled)).length).toBeGreaterThanOrEqual(10);
    expect(fallbackFromConfig(bundled)).not.toBeNull();
    expect(scheduleFromConfig(bundled)).not.toBeNull();
  });

  it('dev / test + synthetic => passed through unchanged (tests and `npm run dev` keep the stand-in)', () => {
    const synthetic = syntheticRctRaw();
    expect(bundledRct(synthetic, false)).toBe(synthetic);
  });

  it('dev / test + a non-synthetic table => passed through unchanged', () => {
    const real = ratifiedLike();
    expect(bundledRct(real, false)).toBe(real);
  });

  it('only an exact `_synthetic: true` marks the stand-in; anything else is not refused here (the build-time pin owns that)', () => {
    for (const marker of ['true', 1, false, null]) {
      const j = { ...ratifiedLike(), _synthetic: marker };
      expect(bundledRct(j, true)).toBe(j);
    }
    expect(bundledRct(null, true)).toBeNull();
    expect(bundledRct('not an object', true)).toBe('not an object');
  });
});
