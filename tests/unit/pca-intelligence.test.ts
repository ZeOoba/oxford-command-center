// tests/unit/pca-intelligence.test.ts
//
// Pure-function tests for src/analytics/pca-intelligence.ts and the curated overlay in
// src/modules/property-condition/pca-overlay.ts. Fixtures mirror the eight current reports in the
// 2026-10-13 PCA Command Center report; the "register" 29000 Information Ln row is deliberately the
// WRONG one ($REDACTED-AMT / $REDACTED-AMT shown as Immediate / Short-term) so the correction is exercised.
import { describe, expect, it } from 'vitest';
import {
  applyPcaOverlay,
  currencyAlerts,
  monthsSince,
  nearTermRollup,
  reportStatus,
  reservePsfYr,
  warrantyClock,
} from '../../src/analytics/pca-intelligence';
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

/** The eight current reports as the REGISTER prints them (29000 Info Ln wrong). */
function registerProperties(): PcaPropertySummary[] {
  return [
    prop('banwick', '2800-2826 Banwick', brief({ reportId: 'R01', sf: 24000, immediateUsd: 1050, reservesUninflUsd: REDACTED-AMT, reservesInflUsd: REDACTED-AMT, psfYrStated: 0.77 })),
    prop('old-morrison', '384-420 Old Morrison', brief({ reportId: 'R02', sf: 31200, immediateUsd: 2050, reservesUninflUsd: REDACTED-AMT, reservesInflUsd: REDACTED-AMT, psfYrStated: 0.58 })),
    prop('e-fulton', '3520 E Fulton', brief({ reportId: 'R03', reportDate: '2025-04-28', consultant: 'CBRE', usabilityClass: 'limited', sf: 198576, immediateUsd: 26000, shortTermUsd: REDACTED-AMT, reservesUninflUsd: REDACTED-AMT, reservesInflUsd: REDACTED-AMT, psfYrStated: 0.33 })),
    prop('e-livingston', '3875-3883 E Livingston', brief({ reportId: 'R04', reportDate: '2025-04-10', consultant: 'AEI', usabilityClass: 'draft', sf: 10950, immediateUsd: 10400, shortTermUsd: 59000, reservesUninflUsd: REDACTED-AMT, reservesInflUsd: REDACTED-AMT })),
    prop('northwood', '2203-2207 Northwood', brief({ reportId: 'R05', reportDate: '2024-09-16', consultant: 'PCI', sf: 53700, immediateUsd: 6500, reservesUninflUsd: null, reservesInflUsd: REDACTED-AMT, termYears: 10, psfYrStated: 0.06 })),
    prop('raytown', '9620 SR 350 Raytown', brief({ reportId: 'R06', reportDate: '2024-10-07', consultant: 'EWI', sf: 34560, immediateUsd: 2500, reservesUninflUsd: REDACTED-AMT, reservesInflUsd: REDACTED-AMT, psfYrStated: 21.25 })),
    prop('sunburst', '401 Sunburst', brief({ reportId: 'R07', reportDate: '2025-11-25', consultant: 'PCI letter', usabilityClass: 'limited', immediateUsd: 2225, termYears: null })),
    prop('info-lane', '29000 Information Ln', brief({ reportId: 'R08', reportDate: '2025-11', usabilityClass: 'draft', sf: 48000, immediateUsd: REDACTED-AMT, shortTermUsd: REDACTED-AMT, reservesUninflUsd: REDACTED-AMT, reservesInflUsd: REDACTED-AMT, psfYrStated: 0.25 })),
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
    const r = reservePsfYr({ reservesUninflUsd: REDACTED-AMT, sf: 10950, termYears: 12, psfYrStated: null });
    expect(r.origin).toBe('derived');
    expect(r.value).toBeCloseTo(0.8016, 3);
  });

  it('keeps the stated label only when the stated figure reconciles to the computation (Banwick 0.77)', () => {
    const r = reservePsfYr({ reservesUninflUsd: REDACTED-AMT, sf: 24000, termYears: 12, psfYrStated: 0.77 });
    expect(r.origin).toBe('stated');
    expect(r.value).toBeCloseTo(0.77, 2);
  });

  it('returns n/a — never imputes — when the uninflated reserve is absent (Northwood: only inflated $REDACTED-AMT exists)', () => {
    const r = reservePsfYr({ reservesUninflUsd: null, sf: 53700, termYears: 10, psfYrStated: 0.06 });
    expect(r).toEqual({ value: null, origin: 'n/a', stated: 0.06 });
  });

  it('returns n/a when SF or term is missing (Sunburst)', () => {
    expect(reservePsfYr({ reservesUninflUsd: 1000, sf: null, termYears: 12, psfYrStated: null }).origin).toBe('n/a');
    expect(reservePsfYr({ reservesUninflUsd: 1000, sf: 100, termYears: null, psfYrStated: null }).origin).toBe('n/a');
  });

  it('recomputes Raytown from the corrected $292,500 and treats the unreproducible stated $21.25 as derived', () => {
    const r = reservePsfYr({ reservesUninflUsd: 292500, sf: 34560, termYears: 12, psfYrStated: 21.25 });
    expect(r.origin).toBe('derived');
    expect(r.value).toBeCloseTo(0.7053, 3);
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
    expect(monthsSince('2026', '2026-10-13')).toBe(9); // bare year → January
    expect(monthsSince(null, '2026-10-13')).toBeNull();
  });
});

describe('applyPcaOverlay — 29000 Information Ln Immediate / Short-Term correction', () => {
  const adjusted = applyPcaOverlay(reportOf(registerProperties()), PCA_OVERLAY);
  const info = adjusted.properties.find((p) => p.propertyKey === 'info-lane')!;

  it('replaces the Year 1 / Year 2 reserve outlays with Immediate $1,100 and Short-Term $0', () => {
    expect(info.current.immediateUsd).toBe(1100);
    expect(info.current.shortTermUsd).toBe(0);
  });

  it('never leaves $REDACTED-AMT or $REDACTED-AMT in Immediate or Short-Term anywhere in the model', () => {
    for (const p of adjusted.properties) {
      expect([p.current.immediateUsd, p.current.shortTermUsd]).not.toContain(REDACTED-AMT);
      expect([p.current.immediateUsd, p.current.shortTermUsd]).not.toContain(REDACTED-AMT);
    }
  });

  it('keeps the reserve totals and dates the report to the 2025-10-29 Intertek DRAFT', () => {
    expect(info.current.reservesUninflUsd).toBe(REDACTED-AMT);
    expect(info.current.reportDate).toBe('2025-10-29');
    expect(reportStatus(info.current)).toBe('DRAFT');
  });

  it('records what it changed so the UI and reconciliation can show it', () => {
    expect(adjusted.corrections.map((c) => c.propertyKey).sort()).toEqual(['info-lane', 'raytown']);
    expect(adjusted.corrections.find((c) => c.propertyKey === 'info-lane')).toMatchObject({
      propertyKey: 'info-lane',
      changes: expect.arrayContaining([
        expect.objectContaining({ field: 'immediateUsd', from: REDACTED-AMT, to: 1100 }),
        expect.objectContaining({ field: 'shortTermUsd', from: REDACTED-AMT, to: 0 }),
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
    const stale = prop('red-branch', '9050 Red Branch', brief({ reportId: 'R12', reportDate: '2015-08-12', usabilityClass: 'stale', immediateUsd: REDACTED-AMT, shortTermUsd: 5, reservesUninflUsd: 522000 }));
    const withStale = applyPcaOverlay(reportOf([...registerProperties(), stale]), PCA_OVERLAY);
    expect(withStale.totals.immediateUsd).toBe(adjusted.totals.immediateUsd);
    expect(withStale.totals.reservesUninflUsd).toBe(adjusted.totals.reservesUninflUsd);
    expect(withStale.totals.propertiesTotal).toBe(9);
  });

  it('is idempotent when the register is later fixed upstream', () => {
    const twice = applyPcaOverlay(adjusted, PCA_OVERLAY);
    expect(twice.properties.find((p) => p.propertyKey === 'info-lane')!.current.immediateUsd).toBe(1100);
    expect(twice.corrections).toHaveLength(0);
  });

  it('attaches data-quality flags to Raytown, Northwood, Livingston and Info Ln', () => {
    const flagged = adjusted.properties.filter((p) => p.flags.length > 0).map((p) => p.propertyKey).sort();
    expect(flagged).toEqual(expect.arrayContaining(['e-fulton', 'e-livingston', 'info-lane', 'northwood', 'raytown']));
  });

  it('derives Raytown reserves to the corrected $292,500, not the stated $REDACTED-AMT', () => {
    const ray = adjusted.properties.find((p) => p.propertyKey === 'raytown')!;
    expect(ray.current.reservesUninflUsd).toBe(292500);
    expect(ray.psf.origin).toBe('derived');
  });
});

describe('nearTermRollup', () => {
  const adjusted = applyPcaOverlay(reportOf(registerProperties()), PCA_OVERLAY);
  const roll = nearTermRollup(adjusted.properties);

  it('totals Immediate + Short-Term across the eight current reports to ≈ $677K', () => {
    expect(roll.totalUsd).toBe(676950);
  });

  it('puts 3520 E Fulton first at ≈ 87% concentration ($592,125)', () => {
    expect(roll.rows[0]).toMatchObject({ propertyKey: 'e-fulton', totalUsd: 592125 });
    expect(roll.rows[0]!.share).toBeCloseTo(0.8747, 3);
    expect(roll.topShare).toBeCloseTo(0.8747, 3);
  });

  it('sorts descending', () => {
    const totals = roll.rows.map((r) => r.totalUsd);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
  });

  it('counts 29000 Info Ln at $1,100 — not $70,863 — so the register error cannot inflate the rollup', () => {
    expect(roll.rows.find((r) => r.propertyKey === 'info-lane')!.totalUsd).toBe(1100);
    const unfixed = nearTermRollup(registerProperties());
    expect(unfixed.totalUsd).toBe(746713);
  });

  it('excludes STALE reports from the rollup', () => {
    const stale = prop('red-branch', '9050 Red Branch', brief({ reportDate: '2015-08-12', usabilityClass: 'stale', immediateUsd: REDACTED-AMT }));
    const withStale = nearTermRollup([...adjusted.properties, { ...stale, flags: [], psf: reservePsfYr({ reservesUninflUsd: null, sf: null, termYears: null, psfYrStated: null }), status: 'STALE' }]);
    expect(withStale.totalUsd).toBe(676950);
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
    expect(rr!.message).toContain('2025-10-17');
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
  it('29000 Info Ln drill-down reconciles: reserve schedule and system breakdown both sum to $REDACTED-AMT', () => {
    const sched = Object.values(INFO_LANE_DETAIL.reserveScheduleUninfl).reduce((a, b) => a + b, 0);
    const sys = INFO_LANE_DETAIL.systems.reduce((a, s) => a + s.usd, 0);
    expect(sched).toBe(REDACTED-AMT);
    expect(sys).toBe(REDACTED-AMT);
    expect(INFO_LANE_DETAIL.immediateUsd).toBe(1100);
    expect(INFO_LANE_DETAIL.shortTermUsd).toBe(0);
    expect(INFO_LANE_DETAIL.reserveScheduleUninfl.yr1).toBe(REDACTED-AMT);
    expect(INFO_LANE_DETAIL.reserveScheduleUninfl.yr2).toBe(REDACTED-AMT);
  });

  it('ADA immediate items sum to the $1,100 Immediate (van $275 + signs $225 + aisles $600)', () => {
    expect(INFO_LANE_DETAIL.immediateItems.reduce((a, i) => a + i.usd, 0)).toBe(1100);
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
