// tests/unit/acquisition-golden-characterization.test.ts
//
// Golden characterization of the acquisition-engine governor surface (Tier-A T1, hardened plan 2026-10-13).
// TEST-ONLY: no production edits. Pins behaviour that later initiatives (A1/A3/A5, R-HASH) must change
// DELIBERATELY, never by accident:
//   1. computeInputsVersion for a frozen, ratified input set (legacy keyspace AND governor-folded keyspace).
//   2. Floor semantics not already pinned elsewhere: computable basis below the vintage floor => KILLED;
//      5yr-vs-10yr IRR floor selection; floors[id=basis|irr].actual populated (the contract the capital
//      BUY gate must read). The indeterminate-floor T2 cap is already pinned in acquisition.test.ts (B5) —
//      referenced there, not duplicated here.
// Synthetic fixtures only: no candidate IDs, addresses or APNs.
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AcquisitionInput } from '@contracts/acquisition';
import {
  computeInputsVersion,
  loadRatifiedRct,
  parseRuleset,
  scoreAcquisition,
} from '../../server/warehouse/acquisition';
import { governorFingerprint, loadGovernors } from '../../server/warehouse/acq-engine';
import { openWarehouse } from '../../server/warehouse/db';

const ratified = parseRuleset(
  JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8')),
);
const RCT = loadRatifiedRct();
const NOW = '2026-06-13T00:00:00Z';

/** Frozen synthetic deal (same shape as acquisition.test.ts STRONG_BASE). Do NOT edit without re-pinning. */
const FROZEN: Record<string, unknown> = {
  dealId: 'golden-synthetic',
  price: 3_500_000, maxBuildingSf: 42_000, totalSf: 60_000,
  productType: 'shallow-bay-multi', officePct: 0.1,
  clearHeightFt: 28, hasDriveIn: true, hasDock: true, dockCount: 6, driveInCount: 6, multiStory: false, truckCourtFt: 120,
  constructionType: 'block-tilt-brick', yearBuilt: 2005,
  sfhaOnPad: false,
  allInBasis: 1_200_000, stabilizedYoc: 0.12, leveredIrr: 0.18, underwriteHorizonYrs: 5,
  clusterTier: 'owned-submarket',
  sellerMotivationScore: 0.8,
  isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5,
  valueAddScore: 0.5,
  ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
};
const deal = (over: Record<string, unknown> = {}) => AcquisitionInput.parse({ ...FROZEN, ...over });
const score = (d: AcquisitionInput) => scoreAcquisition(d, ratified, { now: NOW, rct: RCT });

/** Governors as seeded by the normal migrations on a throwaway tmpdir DB — never hand-typed literals. */
function seededGovernorFingerprint(): string {
  const db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'acq-golden-')), 'test.sqlite'));
  try {
    return governorFingerprint(loadGovernors(db));
  } finally {
    db.close();
  }
}

// Captured once at baseline (origin/main 140a67a). A change here means the dedup keyspace moved:
// every persisted acq_scores row re-keys. Requires a deliberate migration plan (A3 / R-HASH) — not a casual re-pin.
const PIN_LEGACY = '7c4b74ef66c5424e';
const PIN_WITH_GOVERNORS = 'fbefaf653fb0c02e';
const PIN_GOVERNOR_FINGERPRINT = '1:1.25:0.4:0.085';

describe('golden: inputs_version pin (R-HASH)', () => {
  it('legacy keyspace (no governor fingerprint) is pinned', () => {
    expect(computeInputsVersion(deal(), ratified)).toBe(PIN_LEGACY);
  });
  it('seeded governor fingerprint is pinned', () => {
    expect(seededGovernorFingerprint()).toBe(PIN_GOVERNOR_FINGERPRINT);
  });
  it('governor-folded keyspace is pinned and differs from legacy', () => {
    const v = computeInputsVersion(deal(), ratified, undefined, seededGovernorFingerprint());
    expect(v).toBe(PIN_WITH_GOVERNORS);
    expect(v).not.toBe(PIN_LEGACY);
  });
});

describe('golden: floor-to-tier semantics (ratified ruleset)', () => {
  it('a computable basis below the vintage floor hard-fails the basis floor and KILLS', () => {
    const s = score(deal({ allInBasis: 13_000_000 })); // ~5% discount vs ~$13.67M replacement
    const basis = s.floors.find((f) => f.id === 'basis');
    expect(basis?.passed).toBe(false);
    expect(s.verdict).toBe('KILLED');
    expect(s.floorIndeterminate).toBe(false);
  });
  it('populates floors[id=basis].actual and floors[id=irr].actual (contract read by the capital BUY gate)', () => {
    const s = score(deal());
    const basis = s.floors.find((f) => f.id === 'basis');
    const irr = s.floors.find((f) => f.id === 'irr');
    expect(typeof basis?.actual).toBe('number');
    expect(basis?.actual as number).toBeGreaterThan(0.9);
    expect(irr?.actual).toBe(0.18);
  });
  it('underwriteHorizonYrs 10 selects the 10yr IRR floor; undefined/5 selects the 5yr floor', () => {
    const f5 = ratified.floors.leveredIrrFloor5yr;
    const f10 = ratified.floors.leveredIrrFloor10yr;
    const irrOf = (over: Record<string, unknown>) => score(deal(over)).floors.find((f) => f.id === 'irr');
    expect(irrOf({ underwriteHorizonYrs: 10 })?.required).toBe(f10);
    expect(irrOf({ underwriteHorizonYrs: 5 })?.required).toBe(f5);
    const noHorizon = { ...FROZEN } as Record<string, unknown>;
    delete noHorizon.underwriteHorizonYrs;
    const s = scoreAcquisition(AcquisitionInput.parse(noHorizon), ratified, { now: NOW, rct: RCT });
    expect(s.floors.find((f) => f.id === 'irr')?.required).toBe(f5);
  });
});
