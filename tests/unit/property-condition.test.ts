// @vitest-environment node
//
// tests/unit/property-condition.test.ts
//
// buildPropertyConditionReport (Phase 2 read model) + propertyConditionApi, against a fresh tmpdir
// warehouse loaded through the real writeRegister(). Pins the load-bearing rules: "current" = the
// most recent report (no age cutoff), consultant estimates and contractor prices stay separate,
// derived figures are computed at read time.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { buildPropertyConditionReport, warrantyStatus } from '../../server/warehouse/property-condition';
import { propertyConditionApi } from '../../server/warehouse/property-condition-api';
import { writeRegister, type ParsedRegister } from '../../scripts/import-pca-register';
import type { PcaReport } from '../../src/contracts/property-condition';

function report(over: Partial<PcaReport>): PcaReport {
  return {
    reportId: 'R01', propertyKey: 'banwick', propertyMasterId: null, propertyLabel: 'Banwick', location: null,
    consultant: 'Intertek', client: null, oraCommissioned: true, purpose: null, inspectionDate: null,
    reportDate: '2026-04-07', sf: 24000, buildings: 1, yearBuilt: '1981', immediateUsd: 1000, shortTermUsd: null,
    reservesUninflUsd: REDACTED-AMT, reservesInflUsd: REDACTED-AMT, termYears: 12, psfYrStated: 0.77,
    usabilityRaw: 'CURRENT', usabilityClass: 'current', sourceFiles: null, notes: null, ...over,
  };
}

function parsed(over: Partial<ParsedRegister>): ParsedRegister {
  return { reports: [], components: [], quotes: [], assets: [], pairs: [], openItems: [], rejects: [], ...over };
}

function freshDb(): WarehouseDb {
  return openWarehouse(join(mkdtempSync(join(tmpdir(), 'pca-read-')), 'finance.sqlite'));
}

const AS_OF = '2026-10-07';

describe('buildPropertyConditionReport — properties', () => {
  it('reports loaded:false and empty lists for an unimported warehouse', () => {
    const db = freshDb();
    try {
      const r = buildPropertyConditionReport(db, AS_OF);
      expect(r.loaded).toBe(false);
      expect(r.properties).toEqual([]);
      expect(r.totals).toMatchObject({ propertiesTotal: 0, immediateUsd: 0 });
    } finally {
      db.close();
    }
  });

  it('takes the most recent report as current regardless of age or draft status, and keeps the rest as history', () => {
    const db = freshDb();
    try {
      writeRegister(db, parsed({
        reports: [
          report({ reportId: 'R09', propertyKey: 'info-lane', propertyLabel: 'Info Ln', reportDate: '2016-12-07', usabilityClass: 'stale', immediateUsd: 13000, reservesUninflUsd: 190000 }),
          report({ reportId: 'R08', propertyKey: 'info-lane', propertyLabel: 'Info Ln', reportDate: '2025-11', usabilityClass: 'draft', immediateUsd: 40000, reservesUninflUsd: 120000 }),
          report({ reportId: 'R16', propertyKey: 'sheriff-rd', propertyLabel: 'Sheriff', reportDate: '2007-07-19', usabilityClass: 'stale', immediateUsd: 11000, shortTermUsd: null, reservesUninflUsd: null, reservesInflUsd: 60000, sf: null }),
        ],
      }));
      const r = buildPropertyConditionReport(db, AS_OF);
      const info = r.properties.find((p) => p.propertyKey === 'info-lane');
      expect(info?.current.reportId).toBe('R08');
      expect(info?.current.usabilityClass).toBe('draft');
      expect(info?.history.map((h) => h.reportId)).toEqual(['R09']);
      expect(info?.ageYears).toBe(1);
      // An old report is still current when it is the newest we have.
      const sheriff = r.properties.find((p) => p.propertyKey === 'sheriff-rd');
      expect(sheriff?.current.reportId).toBe('R16');
      expect(sheriff?.ageYears).toBe(19);
      expect(sheriff?.reservesPsfYr).toBeNull();
    } finally {
      db.close();
    }
  });

  it('totals sum ONLY the current report per property (history is never summed)', () => {
    const db = freshDb();
    try {
      writeRegister(db, parsed({
        reports: [
          report({ reportId: 'A1', propertyKey: 'a', propertyLabel: 'A', reportDate: '2015-01-01', immediateUsd: 1000, shortTermUsd: 500, reservesUninflUsd: 9000 }),
          report({ reportId: 'A2', propertyKey: 'a', propertyLabel: 'A', reportDate: '2025-01-01', immediateUsd: 100, shortTermUsd: null, reservesUninflUsd: 900 }),
          report({ reportId: 'B1', propertyKey: 'b', propertyLabel: 'B', reportDate: '2024-01-01', immediateUsd: 10, shortTermUsd: 5, reservesUninflUsd: null }),
          report({ reportId: 'N1', propertyKey: 'n', propertyLabel: 'N narrative', reportDate: '2020-12-24', immediateUsd: null, shortTermUsd: null, reservesUninflUsd: null, reservesInflUsd: null, sf: null, termYears: null, psfYrStated: null, usabilityClass: 'limited' }),
        ],
      }));
      const r = buildPropertyConditionReport(db, AS_OF);
      expect(r.totals).toEqual({ propertiesTotal: 3, propertiesWithFigures: 2, immediateUsd: 110, shortTermUsd: 5, reservesUninflUsd: 900 });
      expect(r.properties.find((p) => p.propertyKey === 'n')?.hasDollarFigures).toBe(false);
    } finally {
      db.close();
    }
  });

  it('a STALE current report (pre-2024) with dollar figures is excluded from totals and the figures count (#474)', () => {
    const db = freshDb();
    try {
      writeRegister(db, parsed({
        reports: [
          report({ reportId: 'S1', propertyKey: 's', propertyLabel: 'S old', reportDate: '2019-06-01', immediateUsd: 7000, shortTermUsd: 3000, reservesUninflUsd: 50000 }),
          report({ reportId: 'C1', propertyKey: 'c', propertyLabel: 'C new', reportDate: '2025-06-01', immediateUsd: 100, shortTermUsd: 50, reservesUninflUsd: 900 }),
          report({ reportId: 'U1', propertyKey: 'u', propertyLabel: 'U undated', reportDate: null, immediateUsd: 5000, shortTermUsd: 1, reservesUninflUsd: 20000 }),
          report({ reportId: 'F1', propertyKey: 'f', propertyLabel: 'F flagged', reportDate: '2025-03-01', usabilityClass: 'stale', immediateUsd: 4000, shortTermUsd: 2, reservesUninflUsd: 10000 }),
        ],
      }));
      const r = buildPropertyConditionReport(db, AS_OF);
      expect(r.totals).toEqual({ propertiesTotal: 4, propertiesWithFigures: 1, immediateUsd: 100, shortTermUsd: 50, reservesUninflUsd: 900 });
    } finally {
      db.close();
    }
  });

  it('a same-date tie picks the code-unit-greatest report_id as current, whatever the insert order (ruled 2026-10-17)', () => {
    const rows = [
      report({ reportId: 'R09', propertyKey: 't', propertyLabel: 'T', reportDate: '2025-06-01', immediateUsd: 10000 }),
      report({ reportId: 'r08', propertyKey: 't', propertyLabel: 'T', reportDate: '2025-06-01', immediateUsd: 90000 }),
    ];
    for (const order of [rows, [...rows].reverse()]) {
      const db = freshDb();
      try {
        writeRegister(db, parsed({ reports: order }));
        const r = buildPropertyConditionReport(db, AS_OF);
        expect(r.properties[0]?.current.reportId).toBe('r08'); // 'r' (0x72) > 'R' (0x52); the locale compare said R09
        expect(r.totals.immediateUsd).toBe(90000);
      } finally {
        db.close();
      }
    }
  });

  it('derives reservesPsfYr = reserves ÷ SF ÷ term and orders by near-term exposure', () => {
    const db = freshDb();
    try {
      writeRegister(db, parsed({
        reports: [
          report({ reportId: 'F', propertyKey: 'e-fulton', propertyLabel: 'E Fulton', sf: 198576, immediateUsd: 25000, shortTermUsd: 475000, reservesUninflUsd: 780000, termYears: 12 }),
          report({ reportId: 'S', propertyKey: 'small', propertyLabel: 'Small', immediateUsd: 10, shortTermUsd: null }),
        ],
      }));
      const r = buildPropertyConditionReport(db, AS_OF);
      expect(r.properties[0]?.propertyKey).toBe('e-fulton');
      expect(r.properties[0]?.reservesPsfYr).toBeCloseTo(780000 / 198576 / 12, 3);
    } finally {
      db.close();
    }
  });
});

describe('buildPropertyConditionReport — schedule, lifecycle, price book', () => {
  it('#474: lifecycle rows come only from live (non-STALE) current reports, matching the totals and the client filter', () => {
    const db = freshDb();
    try {
      const comp = (reportId: string, system: string) => ({
        reportId, rowSeq: 1, system, qty: 1, uom: 'SF', unitCost: 5, factor: null, eul: 20, age: 17, rul: 3, rulRaw: '3', totalUsd: 1000, timing: 'Yr3', basis: 'estimate' as const, note: null,
      });
      writeRegister(db, parsed({
        reports: [
          report({ reportId: 'OLDCUR', propertyKey: 'old', propertyLabel: 'Old', reportDate: '2015-08-12', usabilityClass: 'stale' }),
          report({ reportId: 'FLAGGED', propertyKey: 'flg', propertyLabel: 'Flagged', reportDate: '2025-03-01', usabilityClass: 'stale' }),
          report({ reportId: 'UNDATED', propertyKey: 'und', propertyLabel: 'Undated', reportDate: null }),
          report({ reportId: 'LIVE', propertyKey: 'live', propertyLabel: 'Live', reportDate: '2026-04-07' }),
        ],
        components: [comp('OLDCUR', 'old roof'), comp('FLAGGED', 'flagged roof'), comp('UNDATED', 'undated roof'), comp('LIVE', 'live roof')],
      }));
      const r = buildPropertyConditionReport(db, AS_OF);
      expect(r.lifecycle.map((l) => l.system)).toEqual(['live roof']);
      // Price book keeps every report's unit costs (history), so a stale report still contributes there.
      expect(r.priceBook.map((p) => p.reportId).sort()).toEqual(['FLAGGED', 'LIVE', 'OLDCUR', 'UNDATED']);
    } finally {
      db.close();
    }
  });

  it('classifies warranty status from the stated end year only', () => {
    expect(warrantyStatus(null, 2026)).toBe('unknown');
    expect(warrantyStatus(2025, 2026)).toBe('expired');
    expect(warrantyStatus(2026, 2026)).toBe('ends-this-year');
    expect(warrantyStatus(2028, 2026)).toBe('expiring');
    expect(warrantyStatus(2037, 2026)).toBe('active');
  });

  it('sorts warranty problems first and computes install age', () => {
    const db = freshDb();
    try {
      writeRegister(db, parsed({
        assets: [
          { propertyKey: 'new-plant', propertyMasterId: null, propertyLabel: 'New Plant', component: 'Roof EPDM', installFact: null, installYear: 2017, warranty: '20-yr to 2037', warrantyEndYear: 2037, source: null, flag: null, rowSeq: 1 },
          { propertyKey: 'northwood', propertyMasterId: null, propertyLabel: 'Northwood', component: 'Roof', installFact: null, installYear: 2020, warranty: 'to 2025', warrantyEndYear: 2025, source: null, flag: null, rowSeq: 1 },
          { propertyKey: 'x', propertyMasterId: null, propertyLabel: 'X', component: 'HVAC', installFact: null, installYear: null, warranty: null, warrantyEndYear: null, source: null, flag: null, rowSeq: 1 },
        ],
      }));
      const r = buildPropertyConditionReport(db, AS_OF);
      expect(r.schedule.map((s) => s.warrantyStatus)).toEqual(['expired', 'active', 'unknown']);
      expect(r.schedule.find((s) => s.propertyKey === 'new-plant')?.ageYears).toBe(9);
      expect(r.schedule.find((s) => s.propertyKey === 'x')?.ageYears).toBeNull();
    } finally {
      db.close();
    }
  });

  it('lifecycle uses only each property\'s CURRENT report and derives dueYear = report year + integer RUL', () => {
    const db = freshDb();
    try {
      const comp = (reportId: string, rowSeq: number, system: string, rul: number | null, rulRaw: string | null, total: number | null) => ({
        reportId, rowSeq, system, qty: 1, uom: 'SF', unitCost: 5, factor: null, eul: 20, age: 17, rul, rulRaw, totalUsd: total, timing: 'Yr3', basis: 'estimate' as const, note: null,
      });
      writeRegister(db, parsed({
        reports: [
          report({ reportId: 'OLD', propertyKey: 'p', propertyLabel: 'P', reportDate: '2016-10' }),
          report({ reportId: 'NEW', propertyKey: 'p', propertyLabel: 'P', reportDate: '2026-04-07' }),
        ],
        components: [
          comp('OLD', 1, 'Old roof', 3, '3', 100),
          comp('NEW', 1, 'EPDM roof', 3, '3', 144000),
          comp('NEW', 2, 'TPO re-roof', null, '1-2', REDACTED-AMT),
        ],
      }));
      const r = buildPropertyConditionReport(db, AS_OF);
      expect(r.lifecycle.map((l) => l.system)).toEqual(['EPDM roof', 'TPO re-roof']);
      expect(r.lifecycle[0]?.dueYear).toBe(2029);
      expect(r.lifecycle[1]).toMatchObject({ dueYear: null, rulRaw: '1-2' });
    } finally {
      db.close();
    }
  });

  it('price book keeps unit costs only (no LS, no zero) and stays on the estimate basis', () => {
    const db = freshDb();
    try {
      const base = { qty: 1, factor: null, eul: null, age: null, rul: null, rulRaw: null, totalUsd: 1, timing: null, basis: 'estimate' as const, note: null };
      writeRegister(db, parsed({
        reports: [report({ reportId: 'R', propertyKey: 'p', propertyLabel: 'P' })],
        components: [
          { ...base, reportId: 'R', rowSeq: 1, system: 'Paving', uom: 'SY', unitCost: 42.5 },
          { ...base, reportId: 'R', rowSeq: 2, system: 'Allowance', uom: 'LS', unitCost: 2000 },
          { ...base, reportId: 'R', rowSeq: 3, system: 'Blank', uom: 'SF', unitCost: 0 },
        ],
      }));
      const r = buildPropertyConditionReport(db, AS_OF);
      expect(r.priceBook.map((p) => p.system)).toEqual(['Paving']);
      expect(r.priceBook[0]?.basis).toBe('estimate');
    } finally {
      db.close();
    }
  });
});

describe('buildPropertyConditionReport — calibration and quotes', () => {
  it('computes delta in dollars when both present, else $/SF, else null', () => {
    const db = freshDb();
    try {
      const pair = (rowSeq: number, o: Record<string, number | null>) => ({
        rowSeq, propertyKey: 'k', propertyMasterId: null, propertyLabel: 'K', scope: `s${rowSeq}`, estimateSource: null,
        estimateUsd: null, estimatePsf: null, contractorSource: null, contractorUsd: null, contractorPsf: null, comment: null, ...o,
      });
      writeRegister(db, parsed({
        pairs: [
          pair(1, { estimateUsd: REDACTED-AMT, estimatePsf: 7, contractorUsd: REDACTED-AMT, contractorPsf: 2.85 }),
          pair(2, { estimatePsf: 4, contractorPsf: 12.5 }),
          pair(3, { estimateUsd: 144000, estimatePsf: 6 }),
        ],
      }));
      const r = buildPropertyConditionReport(db, AS_OF);
      expect(r.calibration[0]?.deltaBasis).toBe('usd');
      expect(r.calibration[0]?.deltaPct).toBeCloseTo(-0.5953, 3);
      expect(r.calibration[1]).toMatchObject({ deltaBasis: 'psf' });
      expect(r.calibration[1]?.deltaPct).toBeCloseTo(2.125, 3);
      expect(r.calibration[2]).toMatchObject({ deltaPct: null, deltaBasis: null });
    } finally {
      db.close();
    }
  });

  it('classifies quote evidence and derives $/SF only for SF-basis rows (never an aggregate)', () => {
    const db = freshDb();
    try {
      const q = (quoteKey: string, o: Record<string, unknown>) => ({
        quoteKey, title: quoteKey, propertyKey: 'p', propertyMasterId: null, propertyLabel: 'P', vendor: null, recordType: 'Quote',
        status: 'Quoted', trade: 'Roofing', docDate: '2026-01', quotedUsd: null, actualUsd: null, qty: null, uom: null,
        scopeSummary: null, sourceRef: null, confidence: null, verified: false, fundingClass: null, leaseRecovery: null, notes: null, ...o,
      });
      writeRegister(db, parsed({
        quotes: [
          q('exec', { recordType: 'Contract', status: 'Awarded', quotedUsd: REDACTED-AMT, qty: 26700, uom: 'SF' }),
          q('budget', { recordType: 'Estimate', status: 'Quoted', quotedUsd: 657000, qty: 52500, uom: 'SF' }),
          q('super', { status: 'Superseded', quotedUsd: REDACTED-AMT, qty: 2376, uom: 'SF' }),
          q('live', { quotedUsd: REDACTED-AMT, qty: 2376, uom: 'SF' }),
          q('ls', { quotedUsd: 8300 }),
          q('sy', { quotedUsd: 1000, qty: 10, uom: 'SY' }),
        ],
      }));
      const r = buildPropertyConditionReport(db, AS_OF);
      const by = (k: string) => r.quotes.find((x) => x.quoteKey === k);
      expect(by('exec')).toMatchObject({ evidenceClass: 'executed' });
      expect(by('exec')?.unitPriceUsdPsf).toBeCloseTo(9.12, 2);
      expect(by('budget')?.evidenceClass).toBe('budget');
      expect(by('super')?.evidenceClass).toBe('superseded');
      expect(by('live')?.evidenceClass).toBe('quoted');
      expect(by('ls')?.unitPriceUsdPsf).toBeNull();
      expect(by('sy')?.unitPriceUsdPsf).toBeNull();
    } finally {
      db.close();
    }
  });

  it('prefers the actual total over the quoted total for the unit price', () => {
    const db = freshDb();
    try {
      writeRegister(db, parsed({
        quotes: [{
          quoteKey: 'k', title: 'k', propertyKey: 'p', propertyMasterId: null, propertyLabel: 'P', vendor: null, recordType: 'Contract',
          status: 'Completed', trade: 'Roofing', docDate: null, quotedUsd: 100, actualUsd: 200, qty: 10, uom: 'SF', scopeSummary: null,
          sourceRef: null, confidence: null, verified: true, fundingClass: null, leaseRecovery: null, notes: null,
        }],
      }));
      const q = buildPropertyConditionReport(db, AS_OF).quotes[0];
      expect(q?.unitPriceUsdPsf).toBe(20);
      expect(q?.verified).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('propertyConditionApi', () => {
  it('GET /report returns the parsed report', async () => {
    const db = freshDb();
    try {
      writeRegister(db, parsed({ reports: [report({})] }));
      const res = await propertyConditionApi(() => db).request('/report');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { loaded: boolean; properties: unknown[] };
      expect(body.loaded).toBe(true);
      expect(body.properties).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('GET /report is 503 when the warehouse is unavailable', async () => {
    const res = await propertyConditionApi(() => {
      throw new Error('nope');
    }).request('/report');
    expect(res.status).toBe(503);
  });
});
