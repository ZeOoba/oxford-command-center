// tests/unit/lease-run-view.test.ts
//
// Pure presentation helpers backing LeaseRunView (the view is browser-verified, not jsdom-rendered).
// Drives them off the REAL seed projections so the UI logic stays reconciled to the engine.
import { describe, expect, it } from 'vitest';
import {
  assumptionRows,
  assumptionYearCount,
  markToMarketChip,
  noiChartPoints,
  rolloverLabels,
  statusLabel,
} from '../../src/modules/intel/lease-run-view';
import { projectLeaseRun, DEFAULT_LEASE_RUN_ASSUMPTIONS, computeMarkToMarket } from '../../server/warehouse/lease-run';
import { SUNBURST_SEED, FISHEL_SEED } from '../../server/warehouse/lease-terms';
import type { LeaseRunProjectionEnvelope } from '../../src/contracts/lease-run';

const sunburst = projectLeaseRun(SUNBURST_SEED, DEFAULT_LEASE_RUN_ASSUMPTIONS);
const fishel = projectLeaseRun(FISHEL_SEED, DEFAULT_LEASE_RUN_ASSUMPTIONS);

describe('rolloverLabels', () => {
  it('marks each status boundary (Sunburst: contractual→option_assumed at LY\'34)', () => {
    const labels = rolloverLabels(sunburst.periods);
    expect(labels).toContain("LY '34");
  });

  it('Fishel boundaries: initial→renewal at LY\'27, renewal→option at LY\'32', () => {
    const labels = rolloverLabels(fishel.periods);
    expect(labels).toContain("LY '27");
    expect(labels).toContain("LY '32");
  });
});

describe('noiChartPoints', () => {
  it('one point per period, NOI values, assumption + rollover flags', () => {
    const pts = noiChartPoints(sunburst.periods);
    expect(pts).toHaveLength(sunburst.periods.length);
    expect(pts[0]!.value).toBeCloseTo(73872.0, 2);
    const ly34 = pts.find((p) => p.label === "LY '34")!;
    expect(ly34.isAssumption).toBe(true);
    expect(ly34.isRollover).toBe(true);
  });

  it('Fishel has zero assumption points (all option rows are contractual)', () => {
    expect(noiChartPoints(fishel.periods).some((p) => p.isAssumption)).toBe(false);
  });
});

describe('statusLabel', () => {
  it('maps every status to a human label', () => {
    expect(statusLabel('contractual')).toMatch(/contractual/i);
    expect(statusLabel('renewal_exercised')).toMatch(/exercised/i);
    expect(statusLabel('option_contractual')).toMatch(/fixed/i);
    expect(statusLabel('option_assumed')).toMatch(/assumed/i);
  });
});

describe('markToMarketChip', () => {
  it('shows the gold below-market chip for Fishel against a higher cohort', () => {
    const mtm = computeMarkToMarket(fishel, { median: 5.91, p25: 5.71, n: 2 });
    const chip = markToMarketChip(mtm);
    expect(chip.show).toBe(true);
    expect(chip.tone).toBe('gold');
    expect(chip.label).toMatch(/below market/i);
    expect(chip.detail).toMatch(/rollover upside/i);
  });

  it('hides when not below market', () => {
    const mtm = computeMarkToMarket(sunburst, { median: 10, p25: 8, n: 4 });
    expect(markToMarketChip(mtm).show).toBe(false);
  });

  it('hides for a null mark-to-market (no cohort)', () => {
    expect(markToMarketChip(null).show).toBe(false);
  });
});

describe('assumptionRows / assumptionYearCount', () => {
  it('returns five editable assumption rows with the default values', () => {
    const env = { ...fishel, markToMarket: null } as LeaseRunProjectionEnvelope;
    const rows = assumptionRows(env);
    expect(rows.map((r) => r.key)).toEqual([
      'managementFeePct',
      'roofStructuralReservePsf',
      'vacancyCreditLossPct',
      'renewalMarketGrowthPct',
      'indicativeCapRate',
    ]);
    expect(rows.find((r) => r.key === 'indicativeCapRate')!.value).toBeCloseTo(0.08, 6);
  });

  it('counts flagged-assumption years (Sunburst has 10 option_assumed years, Fishel 0)', () => {
    expect(assumptionYearCount(sunburst.periods)).toBe(10);
    expect(assumptionYearCount(fishel.periods)).toBe(0);
  });
});
