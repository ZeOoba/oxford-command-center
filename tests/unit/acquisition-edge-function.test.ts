// tests/unit/acquisition-edge-function.test.ts
//
// Verifies the Cloudflare Pages Function (functions/api/warehouse/acquisition/score.ts) is a faithful,
// FAIL-CLOSED mirror of the Brain Server's acquisition-score route: same ratified config, same engine,
// same envelope — and that the ratification gate is real (the prior happy-path-only test could not
// detect a removed gate; this one tests resolveAcquisitionConfig directly).
//
// Runs in Node (vitest) — node:crypto/fs + the bundled JSON import resolve here, so this proves the
// LOGIC + config parity + gate. It does NOT exercise the workerd edge runtime (nodejs_compat /
// compatibility_date >= 2025-09-01) — that needs a real `wrangler pages dev`/deploy check (Function header).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { onRequestPost, resolveAcquisitionConfig } from '../../functions/api/warehouse/acquisition/score';
import { AcquisitionInput, ReplacementCostTable } from '@contracts/acquisition';
import { parseRuleset, scoreAcquisition } from '../../server/warehouse/acquisition';

type Json = Record<string, unknown>;
const ratifiedRulesetObj = JSON.parse(
  readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8'),
) as Json;
const rctObj = JSON.parse(
  readFileSync(resolve(process.cwd(), 'config/replacement-cost.v1.json'), 'utf8'),
) as Json;

/** Build a tampered copy of the ratified ruleset for fail-closed tests (raw JSON, no `any`). */
function ruleVariant(mutate: (j: Json) => void): Json {
  const j = structuredClone(ratifiedRulesetObj);
  mutate(j);
  return j;
}

// A strong, fully-known PURSUE-grade deal (copied from acquisition.test.ts STRONG_BASE).
const STRONG_BASE: Record<string, unknown> = {
  dealId: 'strong',
  price: 3_500_000, maxBuildingSf: 42_000, totalSf: 60_000,
  productType: 'shallow-bay-multi', officePct: 0.1,
  clearHeightFt: 28, hasDriveIn: true, hasDock: true, dockCount: 6, driveInCount: 6, multiStory: false, truckCourtFt: 120,
  constructionType: 'block-tilt-brick', yearBuilt: 2005,
  sfhaOnPad: false,
  allInBasis: 3_600_000, stabilizedYoc: 0.12, leveredIrr: 0.18, underwriteHorizonYrs: 5,
  clusterTier: 'owned-submarket',
  sellerMotivationScore: 0.8,
  isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5,
  valueAddScore: 0.5,
  ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
};

/** Build a Pages-Function context with a JSON POST body for the handler under test. */
function postCtx(body: unknown): { request: Request } {
  return {
    request: new Request('https://mirror/api/warehouse/acquisition/score', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  };
}
/** Strip scoredAt (the engine's only wall-clock field) so two independent score runs deep-equal. */
const stripScoredAt = (s: Record<string, unknown>): Record<string, unknown> => ({ ...s, scoredAt: undefined });

describe('acquisition edge Function — fail-closed gate (resolveAcquisitionConfig)', () => {
  it('accepts the real ratified config', () => {
    const cfg = resolveAcquisitionConfig(ratifiedRulesetObj, rctObj);
    expect(cfg.ruleset.ratification).toBe('ratified');
  });
  it('THROWS on a non-ratified (proposed) ruleset', () => {
    expect(() => resolveAcquisitionConfig({ ...ratifiedRulesetObj, ratification: 'proposed' }, rctObj)).toThrow(/not 'ratified'/);
  });
  it('THROWS on a ratified-but-incomplete ruleset (clearHeightBands null)', () => {
    const j = ruleVariant((r) => {
      const scoring = r.scoring as Json;
      const cat3 = scoring.cat3 as Json;
      cat3.clearHeightBands = null;
    });
    expect(() => resolveAcquisitionConfig(j, rctObj)).toThrow(/clearHeightBands=null/);
  });
  it('THROWS on a ratified ruleset missing provenance (ratifiedBy null)', () => {
    expect(() => resolveAcquisitionConfig({ ...ratifiedRulesetObj, ratifiedBy: null }, rctObj)).toThrow(/provenance/);
  });
  it('THROWS on a non-ratified RCT', () => {
    expect(() => resolveAcquisitionConfig(ratifiedRulesetObj, { ...rctObj, ratification: 'proposed' })).toThrow(/not 'ratified'/);
  });
});

describe('acquisition edge Function — config identity (pins what BOTH server + edge use)', () => {
  // Catches the config-divergence risk the happy-path parity test cannot: assert the SECURITY-relevant
  // identity invariants of the bundled/on-disk ruleset (full bundle-vs-disk parity needs a deploy check).
  it('the ratified config carries the gate-required provenance', () => {
    expect(ratifiedRulesetObj.ratification).toBe('ratified');
    expect(typeof ratifiedRulesetObj.rulesetVersion).toBe('string');
    expect((ratifiedRulesetObj.rulesetVersion as string).length).toBeGreaterThan(0);
    expect(ratifiedRulesetObj.ratifiedBy).not.toBeNull();
    expect(ratifiedRulesetObj.ratifiedDate).not.toBeNull();
    expect(rctObj.ratification).toBe('ratified');
    expect(rctObj.ratifiedBy).not.toBeNull();
  });
});

describe('acquisition edge Function — POST parity + input handling', () => {
  it('scores a valid deal identically to the server engine (scoredAt stripped)', async () => {
    const res = await onRequestPost(postCtx(STRONG_BASE));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { score: Record<string, unknown> };

    const ruleset = parseRuleset(ratifiedRulesetObj);
    const rct = ReplacementCostTable.parse(rctObj);
    const expected = scoreAcquisition(AcquisitionInput.parse(STRONG_BASE), ruleset, { rct });

    expect(stripScoredAt(body.score)).toEqual(stripScoredAt(expected as unknown as Record<string, unknown>));
  });

  it('returns the same {score} envelope as the server route (verdict + tier)', async () => {
    const res = await onRequestPost(postCtx(STRONG_BASE));
    const body = (await res.json()) as { score: Record<string, unknown> };
    expect(body.score).toHaveProperty('verdict');
    expect(body.score).toHaveProperty('tier');
  });

  it('rejects invalid input with 400 (not a blessed verdict)', async () => {
    const res = await onRequestPost(postCtx({ not: 'a deal' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; score?: unknown };
    expect(body.error).toMatch(/invalid acquisition input/);
    expect(body.score).toBeUndefined();
  });

  it('handles an empty body without throwing (400, fail-closed)', async () => {
    const res = await onRequestPost({
      request: new Request('https://mirror/api/warehouse/acquisition/score', { method: 'POST' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('acquisition edge Function — fail-closed 503 WIRING (config init failure)', () => {
  // Locks in onRequestPost's module-init failure path (score.ts: cfgError -> 503), which the gate-logic
  // and 200/400 tests don't reach. Force init failure by mocking the bundled ruleset JSON to a
  // non-ratified config, then re-import the module fresh so its top-level resolveAcquisitionConfig throws.
  it('onRequestPost returns 503 with no score when the bundled ruleset is non-ratified', async () => {
    vi.resetModules();
    const rulesetPath = resolve(process.cwd(), 'config/acquisition-ruleset.v1.json');
    vi.doMock(rulesetPath, () => ({ default: { ...ratifiedRulesetObj, ratification: 'proposed' } }));
    try {
      const mod = await import('../../functions/api/warehouse/acquisition/score');
      const res = await mod.onRequestPost(postCtx(STRONG_BASE));
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error?: string; score?: unknown };
      expect(body.error).toMatch(/unavailable/);
      expect(body.score).toBeUndefined();
    } finally {
      vi.doUnmock(rulesetPath);
      vi.resetModules();
    }
  });
});

describe('acquisition edge Function — shared governor proxy (consistency with the ranked path)', () => {
  // The edge now applies the SAME shared governor proxy (acq-governor-proxy.ts) as the Brain Server
  // route and the ranked persistence path, so a deal scores the same verdict on every surface.
  it('does NOT over-demote a strong basis≥price deal, and exposes the governor flags', async () => {
    // STRONG_BASE: allInBasis 3.6M / price 3.5M = 1.03 — the OLD `allInBasis/price ≤ 0.40` proxy
    // would have demoted this to PASS. LTV is now indeterminate (null) → no demotion.
    const res = await onRequestPost(postCtx(STRONG_BASE));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      score: { verdict: string };
      governorDscrCleared: unknown;
      governorLtvCleared: unknown;
    };
    expect(['PURSUE', 'WATCH']).toContain(body.score.verdict);
    expect(body.score.verdict).not.toBe('PASS');     // regression: bogus LTV over-demotion is gone
    expect(body.governorDscrCleared).toBe(true);      // high stabilized yield clears the DSCR proxy
    expect(body.governorLtvCleared).toBeNull();       // LTV indeterminate at screen time
  });

  it('the demoted verdict still equals the raw engine for a strong deal (demotion inert here)', async () => {
    const res = await onRequestPost(postCtx(STRONG_BASE));
    const body = (await res.json()) as { score: { verdict: string } };
    const expected = scoreAcquisition(AcquisitionInput.parse(STRONG_BASE), parseRuleset(ratifiedRulesetObj), {
      rct: ReplacementCostTable.parse(rctObj),
    });
    expect(body.score.verdict).toBe(expected.verdict);
  });
});
