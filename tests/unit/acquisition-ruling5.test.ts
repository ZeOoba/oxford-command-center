// tests/unit/acquisition-ruling5.test.ts
//
// Ruling 5 (acquisition-underwriting SKILL.md, ratified 2026-06-09; engine alignment ratified by Gabriel in-turn
// 2026-11-20): a gate or floor breach is a FLAG, never a kill — only Gabriel kills a deal. The engine labels a
// computable gate miss GATE-FLAGGED and a computable floor miss FLOOR-FLAGGED (tier and verdict alike), keeps the
// composite scored and reported, and a flagged deal is never BUY-eligible. Synthetic deals only.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AcquisitionInput, type AcquisitionScore } from '@contracts/acquisition';
import { parseRuleset, scoreAcquisition } from '../../server/warehouse/acquisition';
import { applyGovernorProxyToScore } from '../../server/warehouse/acq-governor-proxy';
import { effectiveTier, governorDemotedLabel, isGovernorDemoted } from '../../src/analytics/acq-governor-demotion';
import { loadTestRct } from '../support/rct';

const RULESET = parseRuleset(JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8')));
const RCT = loadTestRct();
const NOW = '2026-06-13T00:00:00Z';

/** Synthetic strong deal: scores T1 PURSUE on the ratified ruleset (same shape as acquisition.test.ts STRONG_BASE). */
const BASE: Record<string, unknown> = {
  dealId: 'r5-synthetic',
  price: 3_500_000, maxBuildingSf: 42_000, totalSf: 60_000,
  productType: 'shallow-bay-multi', officePct: 0.1,
  clearHeightFt: 28, hasDriveIn: true, hasDock: true, dockCount: 6, driveInCount: 6, multiStory: false, truckCourtFt: 120,
  constructionType: 'tilt-precast', yearBuilt: 2005, sfhaOnPad: false,
  groundLeased: false, envRemediationPctOfPrice: 0,
  use: { automotive: false, childRelated: false, childSafetyReviewed: false },
  allInBasis: 1_200_000, stabilizedYoc: 0.12, leveredIrr: 0.18, unleveredIrr10yr: 0.12, exitCapPct: 0.075, ust10yr: 0.043, ustAsOf: '2026-11-10', underwriteHorizonYrs: 5,
  clusterTier: 'owned-submarket', sellerMotivationScore: 0.8,
  isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5, valueAddScore: 0.5,
  ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
};
const deal = (o: Record<string, unknown> = {}) => AcquisitionInput.parse({ ...BASE, ...o });
const score = (o: Record<string, unknown> = {}) => scoreAcquisition(deal(o), RULESET, { now: NOW, rct: RCT });
const sumSubs = (s: AcquisitionScore) => Math.round(s.subScores.reduce((a, x) => a + x.points, 0) * 10) / 10;

describe('Ruling 5 — engine: flag, never kill', () => {
  it('precondition: the synthetic base deal is a clean T1 PURSUE', () => {
    const s = score();
    expect(s.verdict).toBe('PURSUE');
    expect(s.tier).toBe('T1');
  });

  it('a computable floor miss is FLOOR-FLAGGED (tier and verdict) with its composite kept and reported', () => {
    // An unlevered IRR below the 10.0% floor is a decided floor miss. Composite inputs are otherwise unchanged.
    const clean = score();
    const s = score({ unleveredIrr10yr: 0.05 });
    expect(s.verdict).toBe('FLOOR-FLAGGED');
    expect(s.tier).toBe('FLOOR-FLAGGED');
    expect(s.floorsPassed).toBe(false);
    expect(s.gatesPassed).toBe(true);
    // The IRR is not a scorecard input, so the composite is exactly the clean deal's composite: still scored.
    expect(s.composite).toBe(clean.composite);
    expect(s.composite).toBe(sumSubs(s));
    expect(s.composite).toBeGreaterThan(0);
    expect(s.reasons.some((r) => r.startsWith('FLOOR-FLAGGED') && r.includes('irr'))).toBe(true);
    expect(s.reasons.some((r) => r.includes(`Composite ${s.composite}/100`))).toBe(true);
    expect(s.reasons.join(' ')).not.toMatch(/KILLED/);
  });

  it('a computable gate miss is GATE-FLAGGED (tier and verdict) with its composite kept and reported', () => {
    const s = score({ maxBuildingSf: 55_000 });
    expect(s.verdict).toBe('GATE-FLAGGED');
    expect(s.tier).toBe('GATE-FLAGGED');
    expect(s.gatesPassed).toBe(false);
    expect(s.composite).toBe(sumSubs(s));
    expect(s.composite).toBeGreaterThan(0);
    expect(s.reasons.some((r) => r.startsWith('GATE-FLAGGED') && r.includes('size-price'))).toBe(true);
    expect(s.reasons.join(' ')).not.toMatch(/KILLED/);
  });

  it('a deal breaching both a gate and a floor is GATE-FLAGGED and still names the floor breach', () => {
    const s = score({ maxBuildingSf: 55_000, unleveredIrr10yr: 0.05 });
    expect(s.verdict).toBe('GATE-FLAGGED');
    expect(s.tier).toBe('GATE-FLAGGED');
    expect(s.reasons.some((r) => r.startsWith('FLOOR-FLAGGED') && r.includes('irr'))).toBe(true);
  });

  it('the engine never emits KILLED for any gate or floor miss', () => {
    const misses: Record<string, unknown>[] = [
      { maxBuildingSf: 55_000 }, { clearHeightFt: 10 }, { sfhaOnPad: true }, { productType: 'office-only' },
      { use: { automotive: true, childRelated: false, childSafetyReviewed: false } },
      { clusterTier: 'satellite', driveMinutesToCluster: 45 },
      { stabilizedYoc: 0.05 }, { unleveredIrr10yr: 0.05 }, { allInBasis: 9_000_000 },
    ];
    for (const m of misses) {
      const s = score(m);
      expect(s.verdict, JSON.stringify(m)).toMatch(/^(GATE|FLOOR)-FLAGGED$/);
      expect(s.tier, JSON.stringify(m)).toBe(s.verdict);
    }
  });

  it('a flagged score never carries a T2 cap flag (the flag is the stronger label)', () => {
    expect(score({ unleveredIrr10yr: 0.05, ddKnown: {} }).cappedAtT2).toBe(false);
  });
});

describe('Ruling 5 — DSCR governor: a DSCR floor miss is FLOOR-FLAGGED', () => {
  const GOV = { dscrFloor: 1.25, ltvCeiling: 0.4 };
  const DSCR_MISS = { exitCapPct: 0.05, ust10yr: 0.043 };

  it('a clean PURSUE that misses the DSCR floor becomes FLOOR-FLAGGED (tier and verdict), composite unchanged', () => {
    const s = score();
    const out = applyGovernorProxyToScore(s, DSCR_MISS, GOV);
    expect(out.governorDscrCleared).toBe(false);
    expect(out.score.verdict).toBe('FLOOR-FLAGGED');
    expect(out.score.tier).toBe('FLOOR-FLAGGED');
    expect((out.score as AcquisitionScore).composite).toBe(s.composite);
    expect(out.score.reasons.at(-1)).toMatch(/^Governor demotion: PURSUE → FLOOR-FLAGGED \(tier T1 → FLOOR-FLAGGED\) — DSCR /);
  });

  it('a GATE-FLAGGED deal stays GATE-FLAGGED on a DSCR miss, and the miss is disclosed', () => {
    const s = score({ maxBuildingSf: 55_000 });
    const out = applyGovernorProxyToScore(s, DSCR_MISS, GOV);
    expect(out.score.verdict).toBe('GATE-FLAGGED');
    expect(out.score.tier).toBe('GATE-FLAGGED');
    expect(out.score.reasons.some((r) => r.includes('DSCR') && r.includes('FLOOR-FLAGGED'))).toBe(true);
  });

  it('a FLOOR-FLAGGED deal stays FLOOR-FLAGGED on a DSCR miss, and the DSCR miss is disclosed too', () => {
    const s = score({ unleveredIrr10yr: 0.05 });
    const out = applyGovernorProxyToScore(s, DSCR_MISS, GOV);
    expect(out.score.verdict).toBe('FLOOR-FLAGGED');
    expect(out.score.reasons.some((r) => r.includes('DSCR') && r.includes('FLOOR-FLAGGED'))).toBe(true);
  });

  it('an INVALID governor set still fails closed to PASS (a system fault, not a deal breach)', () => {
    const out = applyGovernorProxyToScore(score(), { exitCapPct: 0.075, ust10yr: 0.043 }, { dscrFloor: 1.25, ltvCeiling: 0 });
    expect(out.score.verdict).toBe('PASS');
    expect(out.score.tier).toBe('PASS');
  });

  it('display: a DSCR-flagged score reads as governor-demoted under its FLOOR-FLAGGED tier', () => {
    const out = applyGovernorProxyToScore(score(), DSCR_MISS, GOV);
    expect(effectiveTier(out.score)).toBe('FLOOR-FLAGGED');
    expect(isGovernorDemoted(out.score)).toBe(true);
    expect(governorDemotedLabel(out.score)).toBe('Governor-demoted (was T1)');
  });

  it('a natively scored PASS that misses the DSCR floor is FLOOR-FLAGGED but NOT a governor demotion (refute wf_8198d211-d20)', () => {
    const weak = { allInBasis: 4_472_480, clusterTier: 'entry', valueAddScore: 0, sellerMotivationScore: 0, clearHeightFt: 16, truckCourtFt: 50, dockCount: 1, driveInCount: 1, inPlaceRentPsf: 6, marketRentPsf: 6, waltYears: 6 };
    const s = score(weak);
    expect(s.verdict).toBe('PASS'); // precondition: native PASS on its composite
    const out = applyGovernorProxyToScore(s, DSCR_MISS, GOV);
    expect(out.score.verdict).toBe('FLOOR-FLAGGED');
    expect(out.score.tier).toBe('FLOOR-FLAGGED');
    expect(out.score.reasons.some((r) => r.startsWith('Governor demotion:'))).toBe(false);
    expect(out.score.reasons.at(-1)).toMatch(/^FLOOR-FLAGGED \(governor\): DSCR /);
    expect(isGovernorDemoted(out.score)).toBe(false);
  });

  it('display: an engine FLOOR-FLAGGED (no governor reason) is not governor-demoted', () => {
    expect(isGovernorDemoted(score({ unleveredIrr10yr: 0.05 }))).toBe(false);
    expect(effectiveTier({ verdict: 'GATE-FLAGGED' })).toBe('GATE-FLAGGED');
  });
});
