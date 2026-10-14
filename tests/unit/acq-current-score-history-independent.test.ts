// @vitest-environment node
//
// Regression: the "current" acq score must be history-independent.
// Refute wf_f5f45202-de8 (PR #456): persistAndLogScore dedups on inputs_version, so A→B→A writes no
// new row and a latest-by-scored_at reader kept returning B while the engine returned A to the caller.
// The same final inputs must give the same pipeline tier whether the history is [A] or [A,B,A].
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { persistAndLogScore } from '../../server/warehouse/acq-engine';
import { buildPortfolioAllocation } from '../../server/warehouse/capital-allocation';
import { parseRuleset, loadRatifiedRct } from '../../server/warehouse/acquisition';
import { AcquisitionInput } from '@contracts/acquisition';

const RULESET = parseRuleset(
  JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8')),
);
const RCT = loadRatifiedRct();

const BASE: Record<string, unknown> = {
  dealId: 'c1',
  price: 3_500_000, maxBuildingSf: 42_000, totalSf: 60_000,
  productType: 'shallow-bay-multi', officePct: 0.1,
  clearHeightFt: 28, hasDriveIn: true, hasDock: true, dockCount: 6, driveInCount: 6,
  multiStory: false, truckCourtFt: 120,
  constructionType: 'block-tilt-brick', yearBuilt: 2005, sfhaOnPad: false,
  allInBasis: 3_600_000,
  leveredIrr: 0.18, underwriteHorizonYrs: 5,
  clusterTier: 'owned-submarket', sellerMotivationScore: 0.8,
  isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5, valueAddScore: 0.5,
  ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
};
const A = AcquisitionInput.parse({ ...BASE, stabilizedYoc: 0.03 }); // DSCR proxy fails → demoted
const B = AcquisitionInput.parse({ ...BASE, stabilizedYoc: 0.12 }); // clears

function freshDb(): WarehouseDb {
  const db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'acq-current-')), 't.sqlite'));
  db.prepare("INSERT INTO acq_candidates (id, source, status) VALUES ('c1', 'manual', 'active')").run();
  return db;
}

async function pipelineTier(db: WarehouseDb, history: AcquisitionInput[]): Promise<string | null> {
  for (const input of history) persistAndLogScore(db, 'c1', input, RULESET, RCT);
  const alloc = await buildPortfolioAllocation(db, '2026-10-01');
  return alloc.pipeline.find((p) => p.candidateId === 'c1')?.tier ?? null;
}

describe('current acq score is history-independent', () => {
  it('capital-allocation pipeline tier for final inputs A is identical for [A] and [A,B,A]', async () => {
    const direct = await pipelineTier(freshDb(), [A]);
    const roundTrip = await pipelineTier(freshDb(), [A, B, A]);
    expect(roundTrip).toBe(direct);
  });
});
