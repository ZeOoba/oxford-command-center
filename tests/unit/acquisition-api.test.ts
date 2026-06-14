// tests/unit/acquisition-api.test.ts
import { describe, expect, it } from 'vitest';
import { warehouseRoutes } from '../../server/warehouse/api';
import type { AcquisitionScore } from '@contracts/acquisition';

// The acquisition route is pure compute (no warehouse DB), so a throwing db-getter is fine — it is
// never invoked for this route. Confirms the route works even when the warehouse sqlite is absent.
const app = warehouseRoutes(() => { throw new Error('no db needed for acquisition scoring'); });

/** A fully-specified, RCT-honest PURSUE-grade deal (60k SF → $8.25M replacement; $3.6M basis ≈ 56% disc). */
const STRONG = {
  dealId: 'api-strong', price: 3_500_000, maxBuildingSf: 42_000, totalSf: 60_000,
  productType: 'shallow-bay-multi', officePct: 0.1,
  clearHeightFt: 28, hasDriveIn: true, hasDock: true, dockCount: 6, driveInCount: 6, multiStory: false, truckCourtFt: 120,
  constructionType: 'block-tilt-brick', yearBuilt: 2005, sfhaOnPad: false,
  allInBasis: 3_600_000, stabilizedYoc: 0.12, leveredIrr: 0.18, underwriteHorizonYrs: 5,
  clusterTier: 'owned-submarket', sellerMotivationScore: 0.8,
  isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5, valueAddScore: 0.5,
  ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
};

function post(body: unknown) {
  return app.request('/acquisition/score', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('POST /acquisition/score', () => {
  it('scores a fully-specified deal as a LIVE PURSUE against the ratified config', async () => {
    const res = await post(STRONG);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { score: AcquisitionScore };
    expect(body.score.advisoryOnly).toBe(false);
    expect(body.score.rulesetVersion).toBe('1.0.0');
    expect(body.score.verdict).toBe('PURSUE');
  });

  it('rejects an invalid body (missing dealId) with 400', async () => {
    const res = await post({ notADeal: true });
    expect(res.status).toBe(400);
  });

  it('cannot reach a live PURSUE when replacement cost is not RCT-derivable (fail-closed)', async () => {
    const res = await post({ ...STRONG, totalSf: null, maxBuildingSf: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { score: AcquisitionScore };
    expect(body.score.verdict).not.toBe('PURSUE'); // gross SF unknown → Basis indeterminate → capped
  });
});
