// @vitest-environment node
// (esbuild refuses to run under jsdom's TextEncoder; nothing here needs a DOM)
// tests/unit/replacement-cost-bundled.test.ts
//
// bundledRct() is the drawer's only guard against shipping the synthetic RCT stand-in: a PRODUCTION Vite build of a
// checkout without the local-only ratified table bundles the stand-in, and the drawer must then price nothing rather
// than invented figures (docs/ops/rct-runtime-config.md). Under vitest import.meta.env.PROD is false, so the module's
// own RCT_V03 never exercises the refusal branch; this file calls the function directly for all four cases
// (independent review 2026-11-13: a mutation of the condition passed the whole suite).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bundledRct, fallbackFromConfig, rctFromConfig, scheduleFromConfig } from '../../src/brain/replacement-cost';
import type * as ReplacementCost from '../../src/brain/replacement-cost';
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

// The module-level wiring `RCT_BUNDLED = bundledRct(rctJson, import.meta.env.PROD === true)` is what the drawer ships;
// the cases above call the function directly, so a mutation of that call site (a hard-coded `false` or `true`) passed
// the suite (review F3). vi.stubEnv('PROD', ...) sets import.meta.env.PROD; resetModules re-evaluates the module so its
// top-level constants see the stubbed value. Under vitest the bundled config is the synthetic stand-in (vitest.config.ts
// alias), so a simulated production build must price nothing.
describe('module wiring: RCT_BUNDLED follows import.meta.env.PROD', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function freshModule(prod: boolean): Promise<typeof ReplacementCost> {
    vi.stubEnv('PROD', prod);
    vi.resetModules();
    expect(import.meta.env.PROD).toBe(prod); // the stub reaches import.meta.env
    return import('../../src/brain/replacement-cost');
  }

  // vi.stubEnv cannot reach the cast form the module uses, `(import.meta as { env?: ... }).env?.PROD` (house style, as in
  // src/shell/tab-types.ts, because this tsconfig does not load vite/client types). So the production half is checked the
  // way Vite actually builds it. Vite substitutes `import.meta.env.PROD` with esbuild `define`, and a real `vite build`
  // compiles this call to `bundledRct(<table>, true)`, which was checked by hand on 2026-11-13. This test runs the same
  // transform on the real source and asserts the call site receives `true` in production and `false` in dev, so a
  // hard-coded first or second argument fails here.
  it.each([
    // minifySyntax prints true/false as !0/!1, which is what the shipped bundle contains
    ['production', 'true', '!0'],
    ['development', 'false', '!1'],
  ])('a %s build passes import.meta.env.PROD into bundledRct at the module call site', async (_mode, prod, expected) => {
    const { transform } = await import('esbuild');
    const src = readFileSync(resolve(process.cwd(), 'src/brain/replacement-cost.ts'), 'utf8');
    const out = await transform(src, { loader: 'ts', format: 'esm', minifySyntax: true, define: { 'import.meta.env.PROD': prod } });
    const call = out.code.match(/RCT_BUNDLED\s*=\s*bundledRct\(\s*rctJson\s*,\s*([^)]*)\)/);
    expect(call, 'the RCT_BUNDLED = bundledRct(rctJson, ...) call site exists').not.toBeNull();
    expect(call![1]!.trim()).toBe(expected);
  });

  it('control: a non-production build keeps the stand-in, which prices >= 10 markets', async () => {
    const m = await freshModule(false);
    expect(Object.keys(m.RCT_V03).length).toBeGreaterThanOrEqual(10);
    expect(m.RCT_FALLBACK).not.toBeNull();
    expect(m.RCT_SCHEDULE).not.toBeNull();
  });
});
