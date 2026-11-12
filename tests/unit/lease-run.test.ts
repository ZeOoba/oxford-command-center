// tests/unit/lease-run.test.ts
//
// Engine unit tests for the PFI Lease-Run Pro Forma.
// Spec: docs/superpowers/specs/2026-06-14-pfi-lease-run-proforma-feature.md (Test plan + Behavior contract).
//
// Runs on the committed SYNTHETIC lease-term roster (tests/unit/lease-run-fixtures.ts): the real lease
// abstracts are local-only operator data (ruling 2026-11-10). Every expected figure below is computed
// by hand from the synthetic rents and the default assumptions (fee 3%, reserve $0.15/SF, vacancy 0,
// option growth 3%, cap 8%) — independently of the engine. On the REAL roster the engine output is
// locked by the ratified golden (`leaseRun` in data/property-financials/golden.local.json, asserted in
// tests/unit/property-financials-golden.test.ts): a snapshot of engine output, which golden:ratify
// refuses to write if it disagrees with the pre-untrack Excel-model figures read from git history.
import { describe, expect, it } from 'vitest';
import {
  projectLeaseRun,
  DEFAULT_LEASE_RUN_ASSUMPTIONS,
  computeMarkToMarket,
} from '../../server/warehouse/lease-run';
import { SUNBURST_LIKE, FISHEL_LIKE } from './lease-run-fixtures';
import type { LeaseTerm } from '../../src/contracts/lease-run';

/** Pull the projected NOI for a given lease-year label. */
function noiOf(periods: { leaseYearLabel: string; noi: number }[], label: string): number {
  const p = periods.find((x) => x.leaseYearLabel === label);
  if (!p) throw new Error(`no period ${label}`);
  return p.noi;
}

describe('projectLeaseRun — 401 Sunburst shape (5,130 SF, absolute NNN)', () => {
  const proj = projectLeaseRun(SUNBURST_LIKE, DEFAULT_LEASE_RUN_ASSUMPTIONS);

  it('uses the LEASE rentable SF (5,130), not the rounded master figure', () => {
    expect(proj.rentableSf).toBe(5130);
  });

  it('contractual + step NOI per lease-year to the cent', () => {
    // LY'27/'28 base rent 70,000; EGR = 70,000 (vac 0); fee = -70,000*.03 = -2,100;
    // reserve = -5,130*0.15 = -769.50; NOI = 70,000 - 2,100 - 769.50 = 67,130.50.
    expect(noiOf(proj.periods, "LY '27")).toBeCloseTo(67130.5, 2);
    expect(noiOf(proj.periods, "LY '28")).toBeCloseTo(67130.5, 2);
    // LY'29 step to 80,000; fee -2,400; reserve -769.50; NOI 76,830.50.
    expect(noiOf(proj.periods, "LY '29")).toBeCloseTo(76830.5, 2);
    for (const ly of ["LY '30", "LY '31", "LY '32", "LY '33"]) {
      expect(noiOf(proj.periods, ly)).toBeCloseTo(76830.5, 2);
    }
  });

  it('option_assumed LY\'34 grows prior rent at 3% (79,158.50 NOI)', () => {
    // LY'34 base = 80,000 * 1.03 = 82,400; fee = -2,472; reserve = -769.50; NOI = 79,158.50.
    expect(noiOf(proj.periods, "LY '34")).toBeCloseTo(79158.5, 2);
  });

  it('stabilized NOI (LY\'27) and indicative value', () => {
    expect(proj.stabilizedNoi).toBeCloseTo(67130.5, 2);
    expect(proj.stabilizedYearLabel).toBe("LY '27");
    // 67,130.50 / 0.08 = 839,131.25 ($163.57/SF on 5,130).
    expect(proj.indicativeValue).toBeCloseTo(839131.25, 2);
    expect(proj.indicativeValuePsf).toBeCloseTo(163.57, 2);
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

describe('projectLeaseRun — 7658 Fishel shape (24,000 SF, NNN)', () => {
  const proj = projectLeaseRun(FISHEL_LIKE, DEFAULT_LEASE_RUN_ASSUMPTIONS);

  it('NOI per lease-year to the cent', () => {
    // LY'26 base 90,000; EGR 90,000; fee -2,700; reserve -24,000*0.15 = -3,600; NOI 83,700.
    expect(noiOf(proj.periods, "LY '26")).toBeCloseTo(83700, 2);
    // LY'27 base 91,800; fee -2,754; reserve -3,600; NOI 85,446.
    expect(noiOf(proj.periods, "LY '27")).toBeCloseTo(85446, 2);
    // LY'31 base 99,367.27; fee -2,981.0181; reserve -3,600; NOI 92,786.2519.
    expect(noiOf(proj.periods, "LY '31")).toBeCloseTo(92786.2519, 2);
    // LY'36 base 109,709.50; fee -3,291.285; reserve -3,600; NOI 102,818.215.
    expect(noiOf(proj.periods, "LY '36")).toBeCloseTo(102818.215, 2);
  });

  it('stabilized NOI (LY\'27) and indicative value', () => {
    expect(proj.stabilizedNoi).toBeCloseTo(85446, 2);
    expect(proj.stabilizedYearLabel).toBe("LY '27");
    // 85,446 / 0.08 = 1,068,075 ($44.50/SF on 24,000 — 44.503…).
    expect(proj.indicativeValue).toBeCloseTo(1068075, 2);
    expect(proj.indicativeValuePsf).toBeCloseTo(44.5, 2);
  });

  it('ALL option periods are option_contractual (data, NOT assumptions)', () => {
    // Opt 2 (LY'32–LY'36) is unexercised but at FIXED contractual rates → data.
    for (const ly of ["LY '32", "LY '33", "LY '34", "LY '35", "LY '36"]) {
      const p = proj.periods.find((x) => x.leaseYearLabel === ly)!;
      expect(p.status).toBe('option_contractual');
      expect(p.isAssumption).toBe(false);
    }
    // No assumption rows at all on this lease.
    expect(proj.periods.some((p) => p.isAssumption)).toBe(false);
  });
});

describe('engine math invariants', () => {
  it('EGR for NNN is NET — never adds reimbursement income or opex', () => {
    const proj = projectLeaseRun(FISHEL_LIKE, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    const ly26 = proj.periods.find((p) => p.leaseYearLabel === "LY '26")!;
    // EGR equals base rent (vacancy 0); no recoveries added.
    expect(ly26.egr).toBeCloseTo(90000, 2);
    expect(ly26.egr).toBeCloseTo(ly26.baseRent, 2);
  });

  it('vacancy/credit loss reduces EGR multiplicatively', () => {
    const a = { ...DEFAULT_LEASE_RUN_ASSUMPTIONS, vacancyCreditLossPct: 0.05 };
    const proj = projectLeaseRun(FISHEL_LIKE, a);
    const ly26 = proj.periods.find((p) => p.leaseYearLabel === "LY '26")!;
    // EGR = 90,000 * 0.95 = 85,500.
    expect(ly26.egr).toBeCloseTo(85500, 2);
  });

  it('renewalMarketGrowthPct applies ONLY to option_assumed rows (never contractual)', () => {
    // Bump growth to 10% — the contractual rows must be unchanged; only LY'34+ move.
    const hot = { ...DEFAULT_LEASE_RUN_ASSUMPTIONS, renewalMarketGrowthPct: 0.1 };
    const base = projectLeaseRun(SUNBURST_LIKE, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    const grown = projectLeaseRun(SUNBURST_LIKE, hot);
    // Contractual LY'33 identical regardless of growth.
    expect(noiOf(grown.periods, "LY '33")).toBeCloseTo(noiOf(base.periods, "LY '33"), 2);
    // option_assumed LY'34 base = 80,000 * 1.10 = 88,000 → strictly higher than at 3%.
    const ly34 = grown.periods.find((p) => p.leaseYearLabel === "LY '34")!;
    expect(ly34.baseRent).toBeCloseTo(88000, 2);
    // And a lease with no assumed rows is completely insensitive to growth.
    const fbase = projectLeaseRun(FISHEL_LIKE, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    const fhot = projectLeaseRun(FISHEL_LIKE, hot);
    expect(noiOf(fhot.periods, "LY '36")).toBeCloseTo(noiOf(fbase.periods, "LY '36"), 2);
  });

  it('chained option_assumed rows compound off the PRIOR projected rent (LY\'35)', () => {
    const proj = projectLeaseRun(SUNBURST_LIKE, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    const ly34 = proj.periods.find((p) => p.leaseYearLabel === "LY '34")!;
    const ly35 = proj.periods.find((p) => p.leaseYearLabel === "LY '35")!;
    // LY'35 = LY'34 * 1.03 (compounding), not 80,000 * 1.03.
    expect(ly35.baseRent).toBeCloseTo(ly34.baseRent * 1.03, 2);
  });

  it('noiGrowthYoY is null for the first period and a ratio thereafter', () => {
    const proj = projectLeaseRun(SUNBURST_LIKE, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    expect(proj.periods[0]!.noiGrowthYoY).toBeNull();
    const ly29 = proj.periods.find((p) => p.leaseYearLabel === "LY '29")!;
    // 76,830.50 / 67,130.50 - 1.
    expect(ly29.noiGrowthYoY).toBeCloseTo(76830.5 / 67130.5 - 1, 6);
  });

  it('stabilized NOI never picks a partial/stub year', () => {
    // A leading 3-month stub must never be chosen. This lease has no exercised renewal, so
    // stabilization is the first FULL contractual year — never the stub.
    const stub: LeaseTerm = {
      ...SUNBURST_LIKE,
      rentSchedule: [
        { periodStart: '2026-01-01', periodEnd: '2026-03-31', leaseYearLabel: 'stub', annualBaseRent: 17500, status: 'contractual' },
        ...SUNBURST_LIKE.rentSchedule,
      ],
    };
    const proj = projectLeaseRun(stub, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    expect(proj.stabilizedYearLabel).toBe("LY '27");
  });

  it('stabilized NOI is the first LOCKED renewal year when a renewal is exercised (skips the expiring initial-term tail)', () => {
    // LY'26 is the initial-term tail (contractual); LY'27 is the first exercised-renewal year. The
    // durable go-forward income stabilizes on LY'27 (matches the Excel stab_idx=1).
    const proj = projectLeaseRun(FISHEL_LIKE, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    expect(proj.stabilizedYearLabel).toBe("LY '27");
    expect(proj.periods.find((p) => p.leaseYearLabel === "LY '27")!.status).toBe('renewal_exercised');
  });
});

describe('guards & empty path', () => {
  it('non-NNN structure throws (explicitly unsupported in v1)', () => {
    const mg: LeaseTerm = { ...SUNBURST_LIKE, structure: 'modified_gross' };
    expect(() => projectLeaseRun(mg, DEFAULT_LEASE_RUN_ASSUMPTIONS)).toThrow(/NNN/i);
    const gross: LeaseTerm = { ...SUNBURST_LIKE, structure: 'gross' };
    expect(() => projectLeaseRun(gross, DEFAULT_LEASE_RUN_ASSUMPTIONS)).toThrow();
  });

  it('absolute_nnn and nnn are both accepted', () => {
    expect(() => projectLeaseRun(SUNBURST_LIKE, DEFAULT_LEASE_RUN_ASSUMPTIONS)).not.toThrow();
    expect(() => projectLeaseRun(FISHEL_LIKE, DEFAULT_LEASE_RUN_ASSUMPTIONS)).not.toThrow();
  });

  it('empty rent schedule → typed empty projection, no crash', () => {
    const empty: LeaseTerm = { ...SUNBURST_LIKE, rentSchedule: [] };
    const proj = projectLeaseRun(empty, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    expect(proj.isEmpty).toBe(true);
    expect(proj.periods).toEqual([]);
    expect(proj.stabilizedNoi).toBeNull();
    expect(proj.indicativeValue).toBeNull();
  });
});

describe('mark-to-market (below-market rollover flag)', () => {
  it('fires for a $3.75/SF in-place base rent vs a higher cohort median', () => {
    const proj = projectLeaseRun(FISHEL_LIKE, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    // Cohort median well above the in-place rent (e.g. $7/SF flex).
    const mtm = computeMarkToMarket(proj, { median: 7.0, p25: 5.5, n: 6 });
    expect(mtm.belowMarket).toBe(true);
    expect(mtm.currentBaseRentPsf).toBeCloseTo(90000 / 24000, 2); // 3.75 in-place (first period, LY'26 $/SF)
    expect(mtm.upsidePct).not.toBeNull();
    expect(mtm.upsidePct!).toBeGreaterThan(0);
  });

  it('does NOT fire when in-place rent is at/above the cohort', () => {
    const proj = projectLeaseRun(SUNBURST_LIKE, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    const mtm = computeMarkToMarket(proj, { median: 10.0, p25: 8.0, n: 6 });
    expect(mtm.belowMarket).toBe(false);
  });

  it('null cohort (no peers) → not below market, no crash', () => {
    const proj = projectLeaseRun(FISHEL_LIKE, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    const mtm = computeMarkToMarket(proj, { median: null, p25: null, n: 0 });
    expect(mtm.belowMarket).toBe(false);
    expect(mtm.cohortMedianPsf).toBeNull();
  });
});
