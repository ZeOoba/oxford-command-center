// tests/unit/lease-run.test.ts
//
// Engine unit + GOLDEN reconciliation for the PFI Lease-Run Pro Forma.
// Spec: docs/superpowers/specs/2026-06-14-pfi-lease-run-proforma-feature.md (Test plan + Behavior contract).
//
// The golden figures are INDEPENDENTLY computed from the lease economics encoded in
// build_proformas.py (the v1.0 Excel models) and embedded here verbatim. The engine MUST
// reproduce them to the dollar (≤ $0.01 float tolerance). This is the acceptance gate — the
// in-app projection and the Excel deliverable must never diverge.
import { describe, expect, it } from 'vitest';
import {
  projectLeaseRun,
  DEFAULT_LEASE_RUN_ASSUMPTIONS,
  computeMarkToMarket,
} from '../../server/warehouse/lease-run';
import { SUNBURST_SEED, FISHEL_SEED } from '../../server/warehouse/lease-terms';
import type { LeaseTerm } from '../../src/contracts/lease-run';

/** Pull the projected NOI for a given lease-year label. */
function noiOf(periods: { leaseYearLabel: string; noi: number }[], label: string): number {
  const p = periods.find((x) => x.leaseYearLabel === label);
  if (!p) throw new Error(`no period ${label}`);
  return p.noi;
}

describe('projectLeaseRun — 401 Sunburst (5,130 SF, absolute NNN)', () => {
  const proj = projectLeaseRun(SUNBURST_SEED, DEFAULT_LEASE_RUN_ASSUMPTIONS);

  it('uses the LEASE rentable SF (5,130), not the rounded master figure', () => {
    expect(proj.rentableSf).toBe(5130);
  });

  it('GOLDEN: contractual + step NOI per lease-year to the dollar', () => {
    // LY'27/'28 base rent 76,950 @ $15.00/SF; EGR = 76,950 (vac 0); fee = -76,950*.03 = -2,308.50;
    // reserve = -5,130*0.15 = -769.50; NOI = 76,950 - 2,308.50 - 769.50 = 73,872.00 ($14.40/SF).
    expect(noiOf(proj.periods, "LY '27")).toBeCloseTo(73872.0, 2);
    expect(noiOf(proj.periods, "LY '28")).toBeCloseTo(73872.0, 2);
    // LY'29 step to 87,210 @ $17.00/SF; EGR 87,210; fee -2,616.30; reserve -769.50; NOI 83,824.20 ($16.34/SF).
    expect(noiOf(proj.periods, "LY '29")).toBeCloseTo(83824.2, 2);
    for (const ly of ["LY '30", "LY '31", "LY '32", "LY '33"]) {
      expect(noiOf(proj.periods, ly)).toBeCloseTo(83824.2, 2);
    }
  });

  it('GOLDEN: option_assumed LY\'34 grows prior rent at 3% (86,362.01 NOI)', () => {
    // LY'34 base = 87,210 * 1.03 = 89,826.30; EGR = 89,826.30; fee = -2,694.789; reserve = -769.50;
    // NOI = 89,826.30 - 2,694.789 - 769.50 = 86,362.011 → 86,362.01.
    expect(noiOf(proj.periods, "LY '34")).toBeCloseTo(86362.01, 2);
  });

  it('GOLDEN: stabilized NOI (LY\'27) and indicative value', () => {
    expect(proj.stabilizedNoi).toBeCloseTo(73872.0, 2);
    expect(proj.stabilizedYearLabel).toBe("LY '27");
    // 73,872.00 / 0.08 = 923,400.00 ($180.00/SF on 5,130).
    expect(proj.indicativeValue).toBeCloseTo(923400.0, 2);
    expect(proj.indicativeValuePsf).toBeCloseTo(180.0, 2);
  });

  it('flags option rows as assumptions, contractual rows as data', () => {
    const ly33 = proj.periods.find((p) => p.leaseYearLabel === "LY '33")!;
    const ly34 = proj.periods.find((p) => p.leaseYearLabel === "LY '34")!;
    expect(ly33.isAssumption).toBe(false);
    expect(ly33.status).toBe('contractual');
    expect(ly34.isAssumption).toBe(true);
    expect(ly34.status).toBe('option_assumed');
  });
});

describe('projectLeaseRun — 7658 Fishel (24,000 SF, NNN)', () => {
  const proj = projectLeaseRun(FISHEL_SEED, DEFAULT_LEASE_RUN_ASSUMPTIONS);

  it('GOLDEN: NOI per lease-year to the dollar', () => {
    // LY'26 base 102,480; EGR 102,480; fee -3,074.40; reserve -24,000*0.15 = -3,600; NOI 95,805.60 ($3.99/SF).
    expect(noiOf(proj.periods, "LY '26")).toBeCloseTo(95805.6, 2);
    // LY'27 base 104,529.60; fee -3,135.888; reserve -3,600; NOI 97,793.712 → 97,793.71 ($4.07/SF).
    expect(noiOf(proj.periods, "LY '27")).toBeCloseTo(97793.71, 2);
    // LY'31 base 113,146.20; fee -3,394.386; reserve -3,600; NOI 106,151.814 → 106,151.81.
    expect(noiOf(proj.periods, "LY '31")).toBeCloseTo(106151.81, 2);
    // LY'36 base 124,922.52; fee -3,747.6756; reserve -3,600; NOI 117,574.8444 → 117,574.84.
    expect(noiOf(proj.periods, "LY '36")).toBeCloseTo(117574.84, 2);
  });

  it('GOLDEN: stabilized NOI (LY\'27) and indicative value', () => {
    expect(proj.stabilizedNoi).toBeCloseTo(97793.71, 2);
    expect(proj.stabilizedYearLabel).toBe("LY '27");
    // 97,793.712 / 0.08 = 1,222,421.40 ($50.93/SF on 24,000 — 50.9342…).
    expect(proj.indicativeValue).toBeCloseTo(1222421.4, 2);
    expect(proj.indicativeValuePsf).toBeCloseTo(50.93, 2);
  });

  it('ALL Fishel option periods are option_contractual (data, NOT assumptions)', () => {
    // Opt 2 (LY'32–LY'36) is unexercised but at FIXED contractual rates → data.
    for (const ly of ["LY '32", "LY '33", "LY '34", "LY '35", "LY '36"]) {
      const p = proj.periods.find((x) => x.leaseYearLabel === ly)!;
      expect(p.status).toBe('option_contractual');
      expect(p.isAssumption).toBe(false);
    }
    // No assumption rows at all on Fishel.
    expect(proj.periods.some((p) => p.isAssumption)).toBe(false);
  });
});

describe('engine math invariants', () => {
  it('EGR for NNN is NET — never adds reimbursement income or opex', () => {
    const proj = projectLeaseRun(FISHEL_SEED, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    const ly26 = proj.periods.find((p) => p.leaseYearLabel === "LY '26")!;
    // EGR equals base rent (vacancy 0); no recoveries added.
    expect(ly26.egr).toBeCloseTo(102480.0, 2);
    expect(ly26.egr).toBeCloseTo(ly26.baseRent, 2);
  });

  it('vacancy/credit loss reduces EGR multiplicatively', () => {
    const a = { ...DEFAULT_LEASE_RUN_ASSUMPTIONS, vacancyCreditLossPct: 0.05 };
    const proj = projectLeaseRun(FISHEL_SEED, a);
    const ly26 = proj.periods.find((p) => p.leaseYearLabel === "LY '26")!;
    // EGR = 102,480 * 0.95 = 97,356.
    expect(ly26.egr).toBeCloseTo(97356.0, 2);
  });

  it('renewalMarketGrowthPct applies ONLY to option_assumed rows (never contractual)', () => {
    // Bump growth to 10% — Sunburst contractual rows must be unchanged; only LY'34+ move.
    const hot = { ...DEFAULT_LEASE_RUN_ASSUMPTIONS, renewalMarketGrowthPct: 0.1 };
    const base = projectLeaseRun(SUNBURST_SEED, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    const grown = projectLeaseRun(SUNBURST_SEED, hot);
    // Contractual LY'33 identical regardless of growth.
    expect(noiOf(grown.periods, "LY '33")).toBeCloseTo(noiOf(base.periods, "LY '33"), 2);
    // option_assumed LY'34 base = 87,210 * 1.10 = 95,931 → strictly higher than at 3%.
    const ly34 = grown.periods.find((p) => p.leaseYearLabel === "LY '34")!;
    expect(ly34.baseRent).toBeCloseTo(95931.0, 2);
    // And Fishel (no assumed rows) is completely insensitive to growth.
    const fbase = projectLeaseRun(FISHEL_SEED, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    const fhot = projectLeaseRun(FISHEL_SEED, hot);
    expect(noiOf(fhot.periods, "LY '36")).toBeCloseTo(noiOf(fbase.periods, "LY '36"), 2);
  });

  it('chained option_assumed rows compound off the PRIOR projected rent (Sunburst LY\'35)', () => {
    const proj = projectLeaseRun(SUNBURST_SEED, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    const ly34 = proj.periods.find((p) => p.leaseYearLabel === "LY '34")!;
    const ly35 = proj.periods.find((p) => p.leaseYearLabel === "LY '35")!;
    // LY'35 = LY'34 * 1.03 (compounding), not 87,210 * 1.03.
    expect(ly35.baseRent).toBeCloseTo(ly34.baseRent * 1.03, 2);
  });

  it('noiGrowthYoY is null for the first period and a ratio thereafter', () => {
    const proj = projectLeaseRun(SUNBURST_SEED, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    expect(proj.periods[0]!.noiGrowthYoY).toBeNull();
    const ly29 = proj.periods.find((p) => p.leaseYearLabel === "LY '29")!;
    // 83,824.20 / 73,872.00 - 1.
    expect(ly29.noiGrowthYoY).toBeCloseTo(83824.2 / 73872.0 - 1, 6);
  });

  it('stabilized NOI never picks a partial/stub year', () => {
    // A leading 3-month stub must never be chosen. Sunburst has no exercised renewal, so
    // stabilization is the first FULL contractual year — never the stub.
    const stub: LeaseTerm = {
      ...SUNBURST_SEED,
      rentSchedule: [
        { periodStart: '2026-01-01', periodEnd: '2026-03-31', leaseYearLabel: 'stub', annualBaseRent: 19237.5, status: 'contractual' },
        ...SUNBURST_SEED.rentSchedule,
      ],
    };
    const proj = projectLeaseRun(stub, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    expect(proj.stabilizedYearLabel).toBe("LY '27");
  });

  it('stabilized NOI is the first LOCKED renewal year when a renewal is exercised (skips the expiring initial-term tail)', () => {
    // Fishel LY'26 is the initial-term tail (contractual); LY'27 is the first exercised-renewal
    // year. The durable go-forward income stabilizes on LY'27 (matches the Excel stab_idx=1).
    const proj = projectLeaseRun(FISHEL_SEED, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    expect(proj.stabilizedYearLabel).toBe("LY '27");
    expect(proj.periods.find((p) => p.leaseYearLabel === "LY '27")!.status).toBe('renewal_exercised');
  });
});

describe('guards & empty path', () => {
  it('non-NNN structure throws (explicitly unsupported in v1)', () => {
    const mg: LeaseTerm = { ...SUNBURST_SEED, structure: 'modified_gross' };
    expect(() => projectLeaseRun(mg, DEFAULT_LEASE_RUN_ASSUMPTIONS)).toThrow(/NNN/i);
    const gross: LeaseTerm = { ...SUNBURST_SEED, structure: 'gross' };
    expect(() => projectLeaseRun(gross, DEFAULT_LEASE_RUN_ASSUMPTIONS)).toThrow();
  });

  it('absolute_nnn and nnn are both accepted', () => {
    expect(() => projectLeaseRun(SUNBURST_SEED, DEFAULT_LEASE_RUN_ASSUMPTIONS)).not.toThrow();
    expect(() => projectLeaseRun(FISHEL_SEED, DEFAULT_LEASE_RUN_ASSUMPTIONS)).not.toThrow();
  });

  it('empty rent schedule → typed empty projection, no crash', () => {
    const empty: LeaseTerm = { ...SUNBURST_SEED, rentSchedule: [] };
    const proj = projectLeaseRun(empty, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    expect(proj.isEmpty).toBe(true);
    expect(proj.periods).toEqual([]);
    expect(proj.stabilizedNoi).toBeNull();
    expect(proj.indicativeValue).toBeNull();
  });
});

describe('mark-to-market (below-market rollover flag)', () => {
  it('fires for Fishel: $4.07/SF current base rent vs a higher cohort median', () => {
    const proj = projectLeaseRun(FISHEL_SEED, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    // Cohort median well above Fishel's in-place rent (e.g. $7/SF flex).
    const mtm = computeMarkToMarket(proj, { median: 7.0, p25: 5.5, n: 6 });
    expect(mtm.belowMarket).toBe(true);
    expect(mtm.currentBaseRentPsf).toBeCloseTo(102480 / 24000, 2); // 4.27 in-place (first period, LY'26 $/SF)
    expect(mtm.upsidePct).not.toBeNull();
    expect(mtm.upsidePct!).toBeGreaterThan(0);
  });

  it('does NOT fire when in-place rent is at/above the cohort', () => {
    const proj = projectLeaseRun(SUNBURST_SEED, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    const mtm = computeMarkToMarket(proj, { median: 10.0, p25: 8.0, n: 6 });
    expect(mtm.belowMarket).toBe(false);
  });

  it('null cohort (no peers) → not below market, no crash', () => {
    const proj = projectLeaseRun(FISHEL_SEED, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    const mtm = computeMarkToMarket(proj, { median: null, p25: null, n: 0 });
    expect(mtm.belowMarket).toBe(false);
    expect(mtm.cohortMedianPsf).toBeNull();
  });
});
