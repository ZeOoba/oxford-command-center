// tests/unit/pca-intelligence.test.ts
//
// Pure-function tests for src/analytics/pca-intelligence.ts and the curated overlay in
// src/modules/property-condition/pca-overlay.ts. Fixtures have the shape of the eight current reports in
// the 2026-10-13 PCA Command Center report, with synthetic figures (real firm data is local-only, ruling
// 2026-11-10). The overlay itself is the runtime table config/local/pca-overlay.json (synthetic in CI, real
// on the live machine), so every figure the overlay decides is read from it, never pinned here. The
// "register" 29000 Information Ln row is deliberately the WRONG one (the overlay's Year 1 / Year 2 reserve
// outlays shown as Immediate / Short-term) so the correction is exercised.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyPcaOverlay,
  byCode,
  currencyAlerts,
  monthsSince,
  nearTermRollup,
  reportStatus,
  reservePsfYr,
  warrantyClock,
  classifyVintage,
} from '../../src/analytics/pca-intelligence';
import { vintageFor } from '../../src/analytics/building-specs';
import {
  INFO_LANE_DETAIL,
  PCA_ISSUES,
  PCA_OVERLAY,
  calibrationLabel,
} from '../../src/modules/property-condition/pca-overlay';
import type { PcaPropertySummary, PcaReportBrief, PropertyConditionReport } from '../../src/contracts/property-condition';

function brief(over: Partial<PcaReportBrief>): PcaReportBrief {
  return {
    reportId: 'R00', reportDate: '2026-04-07', consultant: 'Intertek', usabilityClass: 'current', usabilityRaw: 'CURRENT',
    sf: null, immediateUsd: null, shortTermUsd: null, reservesUninflUsd: null, reservesInflUsd: null,
    termYears: 12, psfYrStated: null, notes: null, ...over,
  };
}

function prop(key: string, label: string, current: PcaReportBrief): PcaPropertySummary {
  return {
    propertyKey: key, propertyLabel: label, propertyMasterId: null, current, history: [], ageYears: 1,
    reservesPsfYr: null, hasDollarFigures: true,
  };
}

const INFO_SET = PCA_OVERLAY.corrections.find((c) => c.propertyKey === 'info-lane')!.set as {
  reportDate: string; immediateUsd: number; shortTermUsd: number;
};
const RAY_SET = PCA_OVERLAY.corrections.find((c) => c.propertyKey === 'raytown')!.set as { reservesUninflUsd: number };
/** The register's error: the Info Ln drill-down's Year 1 / Year 2 reserve outlays shown as Immediate / Short-term. */
const INFO_YR1 = INFO_LANE_DETAIL.reserveScheduleUninfl.yr1;
const INFO_YR2 = INFO_LANE_DETAIL.reserveScheduleUninfl.yr2;
/** Immediate + Short-term of the seven register rows the overlay does not touch (synthetic figures below). */
const OTHER_NEAR_TERM = 1000 + 2000 + (25000 + 475000) + (10000 + 55000) + 6000 + 2400 + 2000;
const FULTON_NEAR_TERM = 25000 + 475000;

/** The eight current reports as the REGISTER prints them (29000 Info Ln wrong). Synthetic figures. */
function registerProperties(): PcaPropertySummary[] {
  return [
    prop('banwick', '2800-2826 Banwick', brief({ reportId: 'R01', sf: 24000, immediateUsd: 1000, reservesUninflUsd: REDACTED-AMT, reservesInflUsd: REDACTED-AMT, psfYrStated: 0.77 })),
    prop('old-morrison', '384-420 Old Morrison', brief({ reportId: 'R02', sf: 31200, immediateUsd: 2000, reservesUninflUsd: 216000, reservesInflUsd: 229000, psfYrStated: 0.58 })),
    prop('e-fulton', '3520 E Fulton', brief({ reportId: 'R03', reportDate: '2025-04-28', consultant: 'CBRE', usabilityClass: 'limited', sf: 198576, immediateUsd: 25000, shortTermUsd: 475000, reservesUninflUsd: 780000, reservesInflUsd: 836000, psfYrStated: 0.33 })),
    prop('e-livingston', '3875-3883 E Livingston', brief({ reportId: 'R04', reportDate: '2025-04-10', consultant: 'AEI', usabilityClass: 'draft', sf: 10950, immediateUsd: 10000, shortTermUsd: 55000, reservesUninflUsd: 98550, reservesInflUsd: 110000 })),
    prop('northwood', '2203-2207 Northwood', brief({ reportId: 'R05', reportDate: '2024-09-16', consultant: 'PCI', sf: 53700, immediateUsd: 6000, reservesUninflUsd: null, reservesInflUsd: 33000, termYears: 10, psfYrStated: 0.06 })),
    prop('raytown', '9620 SR 350 Raytown', brief({ reportId: 'R06', reportDate: '2024-10-07', consultant: 'EWI', sf: 34560, immediateUsd: 2400, reservesUninflUsd: 210000, reservesInflUsd: 300000, psfYrStated: 21.25 })),
    prop('sunburst', '401 Sunburst', brief({ reportId: 'R07', reportDate: '2025-11-25', consultant: 'PCI letter', usabilityClass: 'limited', immediateUsd: 2000, termYears: null })),
    prop('info-lane', '29000 Information Ln', brief({ reportId: 'R08', reportDate: '2025-11', usabilityClass: 'draft', sf: 48000, immediateUsd: INFO_YR1, shortTermUsd: INFO_YR2, reservesUninflUsd: INFO_LANE_DETAIL.reservesUninflUsd, reservesInflUsd: INFO_LANE_DETAIL.reservesInflUsd, psfYrStated: 0.25 })),
  ];
}

function reportOf(properties: PcaPropertySummary[]): PropertyConditionReport {
  return {
    asOf: '2026-10-13', loaded: true, properties,
    totals: { propertiesTotal: properties.length, propertiesWithFigures: properties.length, immediateUsd: 0, shortTermUsd: 0, reservesUninflUsd: 0 },
    schedule: [], lifecycle: [], calibration: [], quotes: [], priceBook: [], openItems: [],
  };
}

describe('reservePsfYr', () => {
  it('derives reserves ÷ SF ÷ term when no stated value exists and marks it derived (Livingston)', () => {
    const r = reservePsfYr({ reservesUninflUsd: 98550, sf: 10950, termYears: 12, psfYrStated: null });
    expect(r.origin).toBe('derived');
    expect(r.value).toBeCloseTo(0.75, 3);
  });

  it('keeps the stated label only when the stated figure reconciles to the computation (Banwick 0.77)', () => {
    const r = reservePsfYr({ reservesUninflUsd: REDACTED-AMT, sf: 24000, termYears: 12, psfYrStated: 0.77 });
    expect(r.origin).toBe('stated');
    expect(r.value).toBeCloseTo(0.77, 2);
  });

  it('returns n/a — never imputes — when the uninflated reserve is absent (Northwood: only an inflated reserve exists)', () => {
    const r = reservePsfYr({ reservesUninflUsd: null, sf: 53700, termYears: 10, psfYrStated: 0.06 });
    expect(r).toEqual({ value: null, origin: 'n/a', stated: 0.06 });
  });

  it('returns n/a when SF or term is missing (Sunburst)', () => {
    expect(reservePsfYr({ reservesUninflUsd: 1000, sf: null, termYears: 12, psfYrStated: null }).origin).toBe('n/a');
    expect(reservePsfYr({ reservesUninflUsd: 1000, sf: 100, termYears: null, psfYrStated: null }).origin).toBe('n/a');
  });

  it('recomputes Raytown from the corrected reserve and treats the unreproducible stated $21.25 as derived', () => {
    const r = reservePsfYr({ reservesUninflUsd: RAY_SET.reservesUninflUsd, sf: 34560, termYears: 12, psfYrStated: 21.25 });
    expect(r.origin).toBe('derived');
    expect(r.value).toBeCloseTo(RAY_SET.reservesUninflUsd / 34560 / 12, 3);
  });
});

describe('one STALE rule for PCA register and building specs', () => {
  const cases: Array<{ date: string; draft: boolean; stale: boolean }> = [
    { date: '2025-04-28', draft: false, stale: false },
    { date: '2025-04-28', draft: true, stale: false },
    { date: '2023-12-31', draft: false, stale: false },
    { date: '2023-12-31', draft: true, stale: false },
    { date: '2026-04', draft: false, stale: true },
    { date: '2026-04', draft: true, stale: true },
  ];
  it.each(cases)('classifyVintage agrees with reportStatus and vintageFor for %j', ({ date, draft, stale }) => {
    const usabilityClass = stale ? 'stale' : draft ? 'draft' : 'current';
    const fromRegister = reportStatus(brief({ reportDate: date, usabilityClass }));
    expect(classifyVintage(date, { draft, stale })).toBe(fromRegister);
    if (!stale) expect(vintageFor({ report_date: date, draft })).toBe(classifyVintage(date, { draft }));
  });
  it('a pre-2024 report is STALE even when flagged draft; stale flag beats draft', () => {
    expect(classifyVintage('2015-08', { draft: true })).toBe('STALE');
    expect(classifyVintage('2026-04', { draft: true, stale: true })).toBe('STALE');
    expect(classifyVintage('2026-04', { draft: true })).toBe('DRAFT');
    expect(classifyVintage('2026-04', {})).toBe('CURRENT');
  });
});

describe('reportStatus undated', () => {
  it('an undated report cannot be shown to be 2024+, so it is STALE (never feeds totals); a dated draft stays DRAFT', () => {
    expect(reportStatus({ usabilityClass: 'current', reportDate: null })).toBe('STALE');
    expect(reportStatus({ usabilityClass: 'unknown', reportDate: null })).toBe('STALE');
    expect(reportStatus({ usabilityClass: 'draft', reportDate: null })).toBe('STALE'); // undated beats draft: its dollars must not count
    expect(reportStatus({ usabilityClass: 'draft', reportDate: '2025-04-10' })).toBe('DRAFT');
  });
});

describe('reportStatus', () => {
  it('maps usability + report year to CURRENT / DRAFT / STALE', () => {
    expect(reportStatus(brief({ usabilityClass: 'current' }))).toBe('CURRENT');
    expect(reportStatus(brief({ usabilityClass: 'limited' }))).toBe('CURRENT');
    expect(reportStatus(brief({ usabilityClass: 'draft' }))).toBe('DRAFT');
    expect(reportStatus(brief({ usabilityClass: 'stale' }))).toBe('STALE');
  });

  it('treats any pre-2024 report as STALE even if the register called it usable', () => {
    expect(reportStatus(brief({ usabilityClass: 'current', reportDate: '2016-12-07' }))).toBe('STALE');
    expect(reportStatus(brief({ usabilityClass: 'draft', reportDate: '2015-08' }))).toBe('STALE');
  });
});

describe('monthsSince', () => {
  it('counts whole calendar months from a partial date to the as-of date, at runtime', () => {
    expect(monthsSince('2024-09-16', '2026-10-13')).toBe(25);
    expect(monthsSince('2024-10-07', '2026-10-13')).toBe(24);
    expect(monthsSince('2024', '2026-10-13')).toBe(22); // bare year → December (age never overstated)
    expect(monthsSince('2026', '2026-10-13')).toBe(0); // same-year bare year floors at 0, never negative
    expect(monthsSince('2027', '2026-10-13')).toBeNull(); // a future year is not an age of 0 (#474)
    expect(monthsSince('2027-03', '2026-10-13')).toBe(-5); // a stated future month is reported as is, not floored
    expect(monthsSince('2025-03', '2026-10-13')).toBe(19); // stated month is unchanged
    expect(monthsSince(null, '2026-10-13')).toBeNull();
  });
});

describe('applyPcaOverlay — 29000 Information Ln Immediate / Short-Term correction', () => {
  const adjusted = applyPcaOverlay(reportOf(registerProperties()), PCA_OVERLAY);
  const info = adjusted.properties.find((p) => p.propertyKey === 'info-lane')!;

  it('replaces the Year 1 / Year 2 reserve outlays with the overlay Immediate and Short-Term', () => {
    expect(info.current.immediateUsd).toBe(INFO_SET.immediateUsd);
    expect(info.current.shortTermUsd).toBe(INFO_SET.shortTermUsd);
  });

  it('never leaves the Year 1 / Year 2 outlays in Immediate or Short-Term anywhere in the model', () => {
    for (const p of adjusted.properties) {
      expect([p.current.immediateUsd, p.current.shortTermUsd]).not.toContain(INFO_YR1);
      expect([p.current.immediateUsd, p.current.shortTermUsd]).not.toContain(INFO_YR2);
    }
  });

  it('keeps the reserve totals and dates the report to the overlay DRAFT date', () => {
    expect(info.current.reservesUninflUsd).toBe(INFO_LANE_DETAIL.reservesUninflUsd);
    expect(info.current.reportDate).toBe(INFO_SET.reportDate);
    expect(reportStatus(info.current)).toBe('DRAFT');
  });

  it('records what it changed so the UI and reconciliation can show it', () => {
    expect(adjusted.corrections.map((c) => c.propertyKey).sort()).toEqual(['info-lane', 'raytown']);
    expect(adjusted.corrections.find((c) => c.propertyKey === 'info-lane')).toMatchObject({
      propertyKey: 'info-lane',
      changes: expect.arrayContaining([
        expect.objectContaining({ field: 'immediateUsd', from: INFO_YR1, to: INFO_SET.immediateUsd }),
        expect.objectContaining({ field: 'shortTermUsd', from: INFO_YR2, to: INFO_SET.shortTermUsd }),
      ]),
    });
  });

  it('recomputes report totals from the corrected rows', () => {
    expect(adjusted.totals.immediateUsd).toBe(
      adjusted.properties.reduce((a, p) => a + (p.current.immediateUsd ?? 0), 0),
    );
    expect(adjusted.totals.shortTermUsd).toBe(
      adjusted.properties.reduce((a, p) => a + (p.current.shortTermUsd ?? 0), 0),
    );
  });

  it('keeps STALE (pre-2024) reports out of the dollar totals but still counts the property', () => {
    const stale = prop('red-branch', '9050 Red Branch', brief({ reportId: 'R12', reportDate: '2015-08-12', usabilityClass: 'stale', immediateUsd: 70000, shortTermUsd: 5, reservesUninflUsd: 500000 }));
    const withStale = applyPcaOverlay(reportOf([...registerProperties(), stale]), PCA_OVERLAY);
    expect(withStale.totals.immediateUsd).toBe(adjusted.totals.immediateUsd);
    expect(withStale.totals.reservesUninflUsd).toBe(adjusted.totals.reservesUninflUsd);
    expect(withStale.totals.propertiesTotal).toBe(9);
  });

  it('is idempotent when the register is later fixed upstream', () => {
    const twice = applyPcaOverlay(adjusted, PCA_OVERLAY);
    expect(twice.properties.find((p) => p.propertyKey === 'info-lane')!.current.immediateUsd).toBe(INFO_SET.immediateUsd);
    expect(twice.corrections).toHaveLength(0);
  });

  it('attaches data-quality flags to Raytown, Northwood, Livingston and Info Ln', () => {
    const flagged = adjusted.properties.filter((p) => p.flags.length > 0).map((p) => p.propertyKey).sort();
    expect(flagged).toEqual(expect.arrayContaining(['e-fulton', 'e-livingston', 'info-lane', 'northwood', 'raytown']));
  });

  it('derives Raytown reserves to the corrected figure, not the stated one', () => {
    const ray = adjusted.properties.find((p) => p.propertyKey === 'raytown')!;
    expect(ray.current.reservesUninflUsd).toBe(RAY_SET.reservesUninflUsd);
    expect(ray.current.reservesUninflUsd).not.toBe(210000);
    expect(ray.psf.origin).toBe('derived');
  });
});

describe('nearTermRollup', () => {
  const adjusted = applyPcaOverlay(reportOf(registerProperties()), PCA_OVERLAY);
  const roll = nearTermRollup(adjusted.properties);

  const total = OTHER_NEAR_TERM + INFO_SET.immediateUsd + INFO_SET.shortTermUsd;

  it('totals Immediate + Short-Term across the eight current reports', () => {
    expect(roll.totalUsd).toBe(total);
  });

  it('puts 3520 E Fulton first with its concentration share', () => {
    expect(roll.rows[0]).toMatchObject({ propertyKey: 'e-fulton', totalUsd: FULTON_NEAR_TERM });
    expect(roll.rows[0]!.share).toBeCloseTo(FULTON_NEAR_TERM / total, 3);
    expect(roll.topShare).toBeCloseTo(FULTON_NEAR_TERM / total, 3);
  });

  it('sorts descending', () => {
    const totals = roll.rows.map((r) => r.totalUsd);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
  });

  it('counts 29000 Info Ln at the corrected figure — not Year 1 + Year 2 — so the register error cannot inflate the rollup', () => {
    expect(roll.rows.find((r) => r.propertyKey === 'info-lane')!.totalUsd).toBe(INFO_SET.immediateUsd + INFO_SET.shortTermUsd);
    const unfixed = nearTermRollup(registerProperties());
    expect(unfixed.totalUsd).toBe(OTHER_NEAR_TERM + INFO_YR1 + INFO_YR2);
  });

  it('excludes STALE reports from the rollup', () => {
    const stale = prop('red-branch', '9050 Red Branch', brief({ reportDate: '2015-08-12', usabilityClass: 'stale', immediateUsd: 70000 }));
    const withStale = nearTermRollup([...adjusted.properties, { ...stale, flags: [], psf: reservePsfYr({ reservesUninflUsd: null, sf: null, termYears: null, psfYrStated: null }), status: 'STALE' }]);
    expect(withStale.totalUsd).toBe(total);
    expect(withStale.excludedStale).toBe(1);
  });
});

describe('currencyAlerts', () => {
  const adjusted = applyPcaOverlay(reportOf(registerProperties()), PCA_OVERLAY);
  const alerts = currencyAlerts(adjusted.properties, '2026-10-13', PCA_OVERLAY);

  it('flags DRAFT reports (Livingston, 29000 Info Ln)', () => {
    const draft = alerts.filter((a) => a.kind === 'draft').map((a) => a.propertyKey).sort();
    expect(draft).toEqual(['e-livingston', 'info-lane']);
  });

  it('flags reports older than 24 months at runtime (Northwood 25 mo) but not exactly 24 (Raytown)', () => {
    const aged = alerts.filter((a) => a.kind === 'age').map((a) => a.propertyKey);
    expect(aged).toContain('northwood');
    expect(aged).not.toContain('raytown');
  });

  it('collapses STALE reports into one info line instead of one alert each', () => {
    const stale = [
      prop('red-branch', '9050 Red Branch', brief({ reportDate: '2015-08-12', usabilityClass: 'stale' })),
      prop('muirkirk', 'Muirkirk', brief({ reportDate: '2014-10-23', usabilityClass: 'stale' })),
    ];
    const a = currencyAlerts([...adjusted.properties, ...stale], '2026-10-13', PCA_OVERLAY).filter((x) => x.propertyKey === '_stale');
    expect(a).toHaveLength(1);
    expect(a[0]!.severity).toBe('info');
    expect(a[0]!.message).toContain('Muirkirk');
  });

  it('names a RECENT report the register classed stale (excluded from totals, so it must be surfaced)', () => {
    const recent = prop('banwick-x', 'Recent But Stale', brief({ reportDate: '2026-04-07', usabilityClass: 'stale' }));
    const a = currencyAlerts([...adjusted.properties, recent], '2026-10-13', PCA_OVERLAY).filter((x) => x.propertyKey === '_stale');
    expect(a).toHaveLength(1);
    expect(a[0]!.message).toContain('Recent But Stale');
  });

  it('moves the age boundary with the as-of date — no hardcoded "years left"', () => {
    const later = currencyAlerts(adjusted.properties, '2026-11-13', PCA_OVERLAY).filter((a) => a.kind === 'age').map((a) => a.propertyKey);
    expect(later).toEqual(expect.arrayContaining(['northwood', 'raytown']));
  });

  it('flags the stale 29000 Info Ln rent roll (10/17/2025)', () => {
    const rr = alerts.find((a) => a.kind === 'rent-roll');
    expect(rr).toMatchObject({ propertyKey: 'info-lane' });
    expect(rr!.message).toContain(PCA_OVERLAY.rentRolls[0]!.asOf);
  });
});

describe('warrantyClock', () => {
  it('computes years remaining from the as-of year at runtime', () => {
    const rows = warrantyClock(
      [{ propertyLabel: '55 New Plant', component: 'Roof EPDM', installYear: 2017, eul: null, rul: null, rulAsOfYear: null, warrantyEndYear: 2037 }],
      '2026-10-13',
    );
    expect(rows[0]!.warrantyYearsRemaining).toBe(11);
    expect(warrantyClock(rows.map((r) => ({ ...r })), '2030-01-01')[0]!.warrantyYearsRemaining).toBe(7);
  });

  it('derives life remaining from install + EUL (29000 metal roofs, EUL 40)', () => {
    const rows = warrantyClock(
      [{ propertyLabel: '29000 Info Ln', component: 'Metal roof B2-B4', installYear: 2001, eul: 40, rul: null, rulAsOfYear: null, warrantyEndYear: null }],
      '2026-10-13',
    );
    expect(rows[0]!.lifeYearsRemaining).toBe(15);
    expect(rows[0]!.warrantyYearsRemaining).toBeNull();
  });

  it('rolls an RUL stated in a report year forward to the as-of year (asphalt RUL 1 in 2025 → 0 in 2026)', () => {
    const rows = warrantyClock(
      [{ propertyLabel: '29000 Info Ln', component: 'Asphalt', installYear: 2001, eul: null, rul: 1, rulAsOfYear: 2025, warrantyEndYear: null }],
      '2026-10-13',
    );
    expect(rows[0]!.lifeYearsRemaining).toBe(0);
  });
});

describe('overlay content', () => {
  it('29000 Info Ln drill-down reconciles: reserve schedule and system breakdown both sum to the uninflated reserve', () => {
    const sched = Object.values(INFO_LANE_DETAIL.reserveScheduleUninfl).reduce((a, b) => a + b, 0);
    const sys = INFO_LANE_DETAIL.systems.reduce((a, s) => a + s.usd, 0);
    expect(sched).toBe(INFO_LANE_DETAIL.reservesUninflUsd);
    expect(sys).toBe(INFO_LANE_DETAIL.reservesUninflUsd);
    // The drill-down and the correction agree on Immediate / Short-term, and neither is a reserve outlay.
    expect(INFO_LANE_DETAIL.immediateUsd).toBe(INFO_SET.immediateUsd);
    expect(INFO_LANE_DETAIL.shortTermUsd).toBe(INFO_SET.shortTermUsd);
    expect(INFO_LANE_DETAIL.immediateUsd).not.toBe(INFO_YR1);
    expect(INFO_LANE_DETAIL.shortTermUsd).not.toBe(INFO_YR2);
  });

  it('ADA immediate items sum to the Immediate figure', () => {
    expect(INFO_LANE_DETAIL.immediateItems.reduce((a, i) => a + i.usd, 0)).toBe(INFO_LANE_DETAIL.immediateUsd);
  });

  it('loads exactly the 9 open issues, status Open, owner blank', () => {
    expect(PCA_ISSUES).toHaveLength(9);
    for (const i of PCA_ISSUES) {
      expect(i.status).toBe('Open');
      expect(i.owner).toBe('');
    }
  });

  it('marks speculative items [SPECULATIVE] in the issue text', () => {
    const text = PCA_ISSUES.map((i) => i.detail).join('\n');
    expect(text.match(/\[SPECULATIVE[\];]/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('every overlay figure carries provenance (source_file, source_date, price_basis, status)', () => {
    for (const c of PCA_OVERLAY.corrections) {
      expect(c.provenance.sourceFile).toBeTruthy();
      expect(c.provenance.sourceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.provenance.priceBasis).toBe('PCA_CONSULTANT_ESTIMATE');
      expect(['CURRENT', 'DRAFT', 'STALE']).toContain(c.provenance.status);
    }
    expect(INFO_LANE_DETAIL.provenance.priceBasis).toBe('PCA_CONSULTANT_ESTIMATE');
  });

  it('carries the permanent calibration label', () => {
    expect(calibrationLabel([1, 1, 1])).toBe('PCA consultant estimate vs contractor quote; n=1 each; directional only below n=5');
    expect(calibrationLabel([1, 3, 0])).toContain('n=1–3 per component');
    expect(calibrationLabel([])).toContain('no countable observations');
  });
});

describe('applyPcaOverlay — STALE reports stay out of the figures count (#474)', () => {
  it('a pre-2024 current report with dollar figures is neither summed nor counted as a property with figures', () => {
    const stale = prop('old', 'Old Prop', brief({ reportId: 'S1', reportDate: '2019-06-01', immediateUsd: 9000, reservesUninflUsd: 40000 }));
    const live = prop('new', 'New Prop', brief({ reportId: 'C1', reportDate: '2025-06-01', immediateUsd: 100, reservesUninflUsd: 900 }));
    const undated = prop('und', 'Undated', brief({ reportId: 'U1', reportDate: null, immediateUsd: 5000, reservesUninflUsd: 20000 }));
    const flagged = prop('flg', 'Flagged', brief({ reportId: 'F1', reportDate: '2025-03-01', usabilityClass: 'stale', immediateUsd: 4000, reservesUninflUsd: 10000 }));
    const adjusted = applyPcaOverlay(reportOf([stale, live, undated, flagged]), { corrections: [], flags: {} } as never);
    expect(adjusted.totals).toMatchObject({ propertiesTotal: 4, propertiesWithFigures: 1, immediateUsd: 100, reservesUninflUsd: 900 });
  });
});

describe('display sorts use code-unit compare, not localeCompare (#474)', () => {
  it('byCode orders by UTF-16 code unit regardless of host locale', () => {
    expect(byCode('B', 'a')).toBe(-1); // uppercase before lowercase; localeCompare would say 1
    expect(byCode('a', 'a')).toBe(0);
    expect(byCode('b', 'a')).toBe(1);
  });

  it('the PCA display modules contain no localeCompare', () => {
    const files = ['src/analytics/pca-intelligence.ts', 'src/analytics/building-specs.ts', 'server/warehouse/property-condition.ts', 'src/modules/property-condition/SpecsView.tsx'];
    for (const f of files) expect(readFileSync(join(process.cwd(), f), 'utf-8'), f).not.toMatch(/localeCompare/);
  });
});

describe('#474 currency alert copy and undated drafts', () => {
  const undatedDraft = prop('undated-draft', 'Undated Draft Plaza', brief({ reportDate: null, usabilityClass: 'draft', immediateUsd: 9000 }));
  const undatedFinal = prop('undated-final', 'Undated Final Park', brief({ reportDate: null, usabilityClass: 'current', immediateUsd: 9000 }));

  it('the stale summary names undated reports as a stale cause', () => {
    const a = currencyAlerts([undatedFinal], '2026-10-13', { rentRolls: [] }).find((x) => x.propertyKey === '_stale')!;
    const cause = a.message.split(':')[0]!; // the cause clause, before the property list
    expect(cause).toMatch(/undated/i);
    expect(cause).toContain('pre-2024');
    expect(a.message).toContain('Undated Final Park');
  });

  it('an undated DRAFT stays excluded from totals (STALE) but still gets its DRAFT warning', () => {
    expect(reportStatus(undatedDraft.current)).toBe('STALE');
    const alerts = currencyAlerts([undatedDraft], '2026-10-13', { rentRolls: [] });
    const draft = alerts.find((x) => x.kind === 'draft')!;
    expect(draft).toMatchObject({ propertyKey: 'undated-draft', severity: 'warn' });
    expect(draft.message).toContain('DRAFT');
    expect(alerts.find((x) => x.propertyKey === '_stale')!.message).toContain('Undated Draft Plaza'); // still named as excluded
    expect(nearTermRollup([undatedDraft]).totalUsd).toBe(0);
  });

  it('a draft whose date is unparseable text counts as undated and still gets the DRAFT warning', () => {
    const tbd = prop('tbd', 'TBD Plaza', brief({ reportDate: 'TBD' as unknown as string, usabilityClass: 'draft' }));
    expect(currencyAlerts([tbd], '2026-10-13', { rentRolls: [] }).some((x) => x.kind === 'draft')).toBe(true);
  });

  it('an undated non-draft and a pre-2024 draft get no DRAFT alert', () => {
    const pre = prop('pre', 'Pre Draft', brief({ reportDate: '2015-08', usabilityClass: 'draft' }));
    expect(currencyAlerts([undatedFinal, pre], '2026-10-13', { rentRolls: [] }).filter((x) => x.kind === 'draft')).toEqual([]);
  });
});
