// @vitest-environment node
//
// tests/unit/insurance-premium-history-tiv.test.ts
//
// Current-term TIV re-import (2026-09-24). The `Insurance Renewals` tab was re-laid-out to 13
// columns (RowID..Notes) — the positional tiv read at column 14 in parseInsurance has read an empty
// cell ever since, so every current-term property_insurance_policies row captured coverage_tiv NULL
// and the own-book rate benchmark collapsed to cohortN 0. The declaration-transcribed building
// limit lives on the `Insurance Premium History` tab (one row per property per policy year).
//
// Gabriel's rulings (2026-09-24): source = the Premium History tab, parsed on every capture; skip
// Cancelled rows; a reconstructed-basis term is attached but flagged; dec-page precedence — a TIV
// the importer wrote is never overwritten or erased by a capture (conflicts go to
// data_quality_issues), while a TIV a capture wrote follows the tab (refute wf_fb9dddc7-3a3 +
// ruling 2026-09-24 "provenance-aware"); expired terms are flagged and kept out of the own-book
// benchmark and rebid verdicts (ruling 2026-09-24 "exclude + flag").
//
// All names/figures below are synthetic.
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DataQualityFlag } from '../../src/contracts/common';
import type { InsurancePolicy } from '../../src/contracts/insurance';
import {
  attachPremiumHistoryTiv,
  parseInsurancePremiumHistory,
  type PremiumHistoryTivRow,
} from '../../server/workbook/parse';
import { openWarehouse, type WarehouseDb } from '../../server/warehouse/db';
import {
  captureInsurance,
  snapshotPoliciesToWarehouse,
  type WarehouseInsurancePolicy,
} from '../../server/warehouse/insurance';
import { buildInsuranceAnalysis, logRebidVerdicts } from '../../server/warehouse/insurance-analysis';

function policy(over: Partial<InsurancePolicy>): InsurancePolicy {
  return {
    id: 'ins-100main-pckg',
    property: '100 Main St, Columbus OH 43215',
    entity: '100 Main LLC',
    coverage: 'Package (PCKG)',
    effective: '2026-02-01',
    expires: '2027-02-01',
    policyNo: 'Q61-0000001',
    carrier: 'Carrier 01',
    premium: 10000,
    daysToExpiry: 100,
    status: 'Current',
    notes: null,
    flags: [],
    tiv: null,
    deductible: null,
    coverageLimit: null,
    ...over,
  };
}

function hist(over: Partial<PremiumHistoryTivRow>): PremiumHistoryTivRow {
  return {
    sheetRow: 7,
    property: '100 Main St, Columbus OH',
    namedInsured: '100 Main LLC',
    policyYearStart: 2026,
    packagePremium: 10000,
    tiv: 4_000_000,
    basis: 'Erie ESB dec.',
    ...over,
  };
}

describe('parseInsurancePremiumHistory — header-anchored tab read', () => {
  function sheet(): ExcelJS.Worksheet {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Insurance Premium History');
    ws.getCell('A1').value = 'OXFORD REALTY ADVISORS';
    ws.getCell('A5').value = 'TERM-BY-TERM PREMIUM & TIV HISTORY';
    const header = ['Property', 'Named Insured', 'Term Start (anniv.)', 'Policy Year', 'Package Premium ($/yr)',
      'Umbrella Premium ($/yr)', 'Combined Premium ($/yr)', 'YoY Combined', 'Building Limit / TIV ($)', 'YoY TIV',
      'Rate per $100 TIV', 'AOP Deductible ($)', 'Basis / Note'];
    ws.getRow(6).values = header;
    ws.getRow(7).values = ['100 Main St, Columbus OH', '100 Main LLC', new Date('2026-02-01'), '2025-2026', 9500, 500, 10000, null, 3_800_000, null, 0.25, 5000, 'dec'];
    ws.getRow(8).values = ['100 Main St, Columbus OH', '100 Main LLC', new Date('2026-02-01'), '2026-2027', 10000, 500, 10500, null, 4_000_000, null, 0.25, 5000, 'IN FORCE'];
    ws.getRow(9).values = ['200 Oak Ave, Dayton OH', '200 Oak LLC', 'May 28 (anniv. MOVED)', '2026-2027 (Hartford — BOUND)', 7000, 0, 7000, null, 2_000_000, null, 0.35, 5000, 'BOUND'];
    ws.getRow(10).values = ['300 Elm Rd, Akron OH', '300 Elm LLC', new Date('2026-01-01'), '2026-2027', null, 584, 'n/a — base dec MISSING', null, null, null, null, 5000, 'DATA GAP'];
    // blank row 11 terminates the term block; the portfolio-total block below must NOT parse.
    ws.getRow(12).values = ['PORTFOLIO TOTAL — ORA-insured assets in this review'];
    ws.getRow(13).values = [null, null, null, '2026-2027', 17000, 500, 17500, null, 6_000_000];
    return ws;
  }

  it('reads property, insured, policy-year start, package premium, TIV and basis by header', () => {
    const rows = parseInsurancePremiumHistory(sheet()) ?? [];
    expect(rows.map((r) => [r.property, r.policyYearStart, r.packagePremium, r.tiv])).toEqual([
      ['100 Main St, Columbus OH', 2025, 9500, 3_800_000],
      ['100 Main St, Columbus OH', 2026, 10000, 4_000_000],
      ['200 Oak Ave, Dayton OH', 2026, 7000, 2_000_000],
      ['300 Elm Rd, Akron OH', 2026, null, null],
    ]);
    expect(rows[0]?.namedInsured).toBe('100 Main LLC');
    expect(rows[2]?.basis).toBe('BOUND');
  });

  it('returns null when the TIV header is absent (never guesses a column position)', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Insurance Premium History');
    ws.getRow(6).values = ['Property', 'Named Insured', 'Term Start (anniv.)', 'Policy Year', 'Package Premium ($/yr)'];
    ws.getRow(7).values = ['100 Main St', '100 Main LLC', null, '2026-2027', 10000];
    expect(parseInsurancePremiumHistory(ws)).toBeNull();
  });

  it('reads the building-limit column even when "YoY TIV" / "Rate per $100 TIV" sit left of it (refute: column-order dependence)', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Insurance Premium History');
    ws.getRow(6).values = ['Property', 'Named Insured', 'Policy Year', 'Rate per $100 TIV', 'YoY TIV', 'Package Premium ($/yr)', 'Building Limit / TIV ($)'];
    ws.getRow(7).values = ['100 Main St, Columbus OH', '100 Main LLC', '2026-2027', 0.25, 0.05, 10000, 4_000_000];
    expect(parseInsurancePremiumHistory(ws)?.map((r) => r.tiv)).toEqual([4_000_000]);
  });

  it('returns null when a header matches more than one column (ambiguous layout — refuse, never pick the first)', () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Insurance Premium History');
    ws.getRow(6).values = ['Property', 'Named Insured', 'Policy Year', 'Package Premium ($/yr)', 'Building Limit / TIV ($)', 'Building Limit (prior)'];
    ws.getRow(7).values = ['100 Main St, Columbus OH', '100 Main LLC', '2026-2027', 10000, 4_000_000, 3_800_000];
    expect(parseInsurancePremiumHistory(ws)).toBeNull();
  });
});

describe('attachPremiumHistoryTiv — join onto current-term package rows', () => {
  it('attaches TIV by street address + policy-year start year', () => {
    const flags: DataQualityFlag[] = [];
    const [p] = attachPremiumHistoryTiv([policy({})], [hist({ policyYearStart: 2025, tiv: 1 }), hist({})], flags);
    expect(p?.tiv).toBe(4_000_000);
    expect(flags).toEqual([]);
  });

  it('matches on named insured when the address text differs (portfolio label vs street)', () => {
    const [p] = attachPremiumHistoryTiv(
      [policy({ property: 'Sepich Portfolio (Several Locations, Columbus OH)', entity: 'Fairground Village Center LLC' })],
      [hist({ property: 'Fairground Village Center (7 bldgs + land)', namedInsured: 'Fairground Village Center LLC' })],
      [],
    );
    expect(p?.tiv).toBe(4_000_000);
  });

  it('normalizes street suffixes (Court vs Ct) when matching addresses', () => {
    const [p] = attachPremiumHistoryTiv(
      [policy({ property: '55 New Plant Court, Owings Mills MD 21117', entity: 'X LLC' })],
      [hist({ property: '55 New Plant Ct, Owings Mills MD', namedInsured: 'Y LLC' })],
      [],
    );
    expect(p?.tiv).toBe(4_000_000);
  });

  it('prefers the address match over a named-insured match (loss-payee LLC on a tenant policy)', () => {
    const flags: DataQualityFlag[] = [];
    const [p] = attachPremiumHistoryTiv(
      [policy({ property: '401 Sunburst Hwy, Cambridge MD 21613', entity: 'Fairground Village Center LLC (loss payee)' })],
      [
        hist({ sheetRow: 20, property: 'Fairground Village Center (7 bldgs + land)', namedInsured: 'Fairground Village Center LLC', tiv: 12_000_000 }),
        hist({ sheetRow: 21, property: '401 Sunburst Hwy, Cambridge MD', namedInsured: '(tenant-insured)', tiv: 800_000, packagePremium: 10000 }),
      ],
      flags,
    );
    expect(p?.tiv).toBe(800_000);
    expect(flags).toEqual([]);
  });

  it('skips $0-premium lines (tenant-insured ACORD evidence — no rate is computable)', () => {
    const [p] = attachPremiumHistoryTiv([policy({ premium: 0, coverage: 'Evidence of Property Insurance (ACORD 28)' })], [hist({ packagePremium: null })], []);
    expect(p?.tiv).toBeNull();
  });

  it('never attaches to a non-property line (BCL / GL / umbrella)', () => {
    const [p] = attachPremiumHistoryTiv([policy({ coverage: 'Business Catastrophe Liability (BCL)', premium: 594 })], [hist({})], []);
    expect(p?.tiv).toBeNull();
  });

  it('skips Cancelled rows (ruling 2026-09-24 — a replaced policy stays out of the own-book median)', () => {
    const [p] = attachPremiumHistoryTiv([policy({ status: 'Cancelled' })], [hist({})], []);
    expect(p?.tiv).toBeNull();
  });

  it('does not attach across policy years', () => {
    const [p] = attachPremiumHistoryTiv([policy({ effective: '2025-02-01' })], [hist({ policyYearStart: 2026 })], []);
    expect(p?.tiv).toBeNull();
  });

  it('leaves a row with no TIV on its history term null (a data gap is never filled from another year)', () => {
    const [p] = attachPremiumHistoryTiv([policy({})], [hist({ tiv: null, policyYearStart: 2026 }), hist({ policyYearStart: 2025 })], []);
    expect(p?.tiv).toBeNull();
  });

  it('keeps a TIV the Renewals row already carries', () => {
    const [p] = attachPremiumHistoryTiv([policy({ tiv: 9_999 })], [hist({})], []);
    expect(p?.tiv).toBe(9_999);
  });

  it('refuses the join and flags when the package premium disagrees (wrong-term risk)', () => {
    const flags: DataQualityFlag[] = [];
    const [p] = attachPremiumHistoryTiv([policy({ premium: 12_000 })], [hist({ packagePremium: 10_000 })], flags);
    expect(p?.tiv).toBeNull();
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ entity: 'ins-100main-pckg', field: 'tiv', severity: 'warn' });
    expect(p?.flags).toHaveLength(1);
  });

  it('refuses the join and flags when two history rows match one policy term', () => {
    const flags: DataQualityFlag[] = [];
    const [p] = attachPremiumHistoryTiv([policy({})], [hist({}), hist({ sheetRow: 8, tiv: 5_000_000 })], flags);
    expect(p?.tiv).toBeNull();
    expect(flags[0]?.issue).toMatch(/2 Insurance Premium History rows/);
  });

  it('refuses a history row that would attach to two policies (building limit double-count)', () => {
    const flags: DataQualityFlag[] = [];
    const out = attachPremiumHistoryTiv(
      [policy({}), policy({ id: 'ins-100main-prop', coverage: 'Property' })],
      [hist({})],
      flags,
    );
    expect(out.map((p) => p.tiv)).toEqual([null, null]);
    expect(flags).toHaveLength(2);
  });

  it('attaches but flags a term whose basis note says reconstructed (ruling 2026-09-24)', () => {
    const flags: DataQualityFlag[] = [];
    const [p] = attachPremiumHistoryTiv(
      [policy({})],
      [hist({ basis: 'IN FORCE AS ENDORSED; base dec MISSING — $10,000 is reconstructed.' })],
      flags,
    );
    expect(p?.tiv).toBe(4_000_000);
    expect(p?.flags[0]).toMatchObject({ field: 'tiv', severity: 'warn' });
    expect(p?.flags[0]?.issue).toMatch(/reconstructed/i);
  });

  it('refuses and flags a history TIV no larger than the premium (a ratio/percentage, not a building limit)', () => {
    const flags: DataQualityFlag[] = [];
    const [p] = attachPremiumHistoryTiv([policy({})], [hist({ tiv: 0.05 })], flags);
    expect(p?.tiv).toBeNull();
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ field: 'tiv', severity: 'warn' });
  });

  it('refuses and flags when the history package premium is blank (the premium tie cannot be verified)', () => {
    const flags: DataQualityFlag[] = [];
    const [p] = attachPremiumHistoryTiv([policy({})], [hist({ packagePremium: null })], flags);
    expect(p?.tiv).toBeNull();
    expect(flags).toHaveLength(1);
    expect(flags[0]?.issue).toMatch(/package premium/i);
  });

  it('flags (info) a property line with no same-year history row instead of dropping it silently', () => {
    const flags: DataQualityFlag[] = [];
    const [p] = attachPremiumHistoryTiv([policy({})], [hist({ policyYearStart: 2025 })], flags);
    expect(p?.tiv).toBeNull();
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ entity: 'ins-100main-pckg', field: 'tiv', severity: 'info' });
    expect(flags[0]?.issue).toMatch(/no Insurance Premium History row.*2026/);
  });

  it('flags (info) a matched history term whose TIV cell is blank', () => {
    const flags: DataQualityFlag[] = [];
    const [p] = attachPremiumHistoryTiv([policy({})], [hist({ tiv: null })], flags);
    expect(p?.tiv).toBeNull();
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ field: 'tiv', severity: 'info' });
  });

  it('flags an expired property term as not rolled, naming a successor term already on the tab (ruling 2026-09-24)', () => {
    const flags: DataQualityFlag[] = [];
    const [p] = attachPremiumHistoryTiv(
      [policy({ effective: '2025-09-18', expires: '2026-09-18', daysToExpiry: -6, status: 'Expired' })],
      [hist({ policyYearStart: 2025 }), hist({ policyYearStart: 2026, sheetRow: 8, packagePremium: REDACTED-AMT })],
      flags,
    );
    // The expired term still carries its own term's TIV (basis-consistent, displayed) ...
    expect(p?.tiv).toBe(4_000_000);
    // ... but is flagged so the Renewals row gets rolled; the analysis keeps it out of the benchmark.
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ field: 'tiv', severity: 'warn' });
    expect(flags[0]?.issue).toMatch(/expired.*not rolled.*2026-2027/i);
  });

  it('does not flag an in-force term just because a later year is already on the tab', () => {
    const flags: DataQualityFlag[] = [];
    attachPremiumHistoryTiv([policy({})], [hist({}), hist({ policyYearStart: 2027, sheetRow: 9 })], flags);
    expect(flags).toEqual([]);
  });

  it('flags once when policies need TIV but the Premium History tab is absent', () => {
    const flags: DataQualityFlag[] = [];
    const [p] = attachPremiumHistoryTiv([policy({})], null, flags);
    expect(p?.tiv).toBeNull();
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ entity: 'insurance', field: 'tiv' });
  });

  it('flags an empty history block like a missing tab (one warn, not per-policy info notes)', () => {
    const flags: DataQualityFlag[] = [];
    attachPremiumHistoryTiv([policy({})], [], flags);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ entity: 'insurance', severity: 'warn' });
  });

  it('does not flag a missing tab when no policy needs TIV', () => {
    const flags: DataQualityFlag[] = [];
    attachPremiumHistoryTiv([], null, flags);
    expect(flags).toEqual([]);
  });
});

describe('captureInsurance — TIV precedence (ruling 2026-09-24: dec page wins)', () => {
  function freshDb(): WarehouseDb {
    return openWarehouse(join(mkdtempSync(join(tmpdir(), 'ins-tiv-test-')), 'test.sqlite'));
  }
  const base: WarehouseInsurancePolicy = {
    propertyId: 'ins-100main-pckg',
    insurer: 'Carrier 01',
    policyNumber: 'Q61-0000001',
    effectiveDate: '2026-02-01',
    expirationDate: '2027-02-01',
    premiumAnnual: 10000,
    coverageTiv: null,
    policyType: 'Package (PCKG)',
    source: 'brain-server',
    sourceDate: '2026-09-23',
    ingestedBy: 'brain-server',
  };
  const tivOf = (db: WarehouseDb): Array<number | null> =>
    (db.prepare('SELECT coverage_tiv FROM property_insurance_policies').all() as Array<{ coverage_tiv: number | null }>)
      .map((r) => r.coverage_tiv);
  const dq = (db: WarehouseDb, kind: string): Array<{ detail: string; severity: string }> =>
    db.prepare('SELECT detail, severity FROM data_quality_issues WHERE kind = ?').all(kind) as Array<{ detail: string; severity: string }>;

  const IMPORTER = { source: 'dec.pdf', ingestedBy: 'import-insurance-data.ts --policies' };
  const rowOf = (db: WarehouseDb): Record<string, unknown> =>
    db.prepare('SELECT id, coverage_tiv, deductible, coverage_limit, premium_annual, source, source_date, ingested_by FROM property_insurance_policies').get() as Record<string, unknown>;

  it('a capture carrying null never erases an importer-written (dec-page) TIV', () => {
    const db = freshDb();
    captureInsurance(db, [{ ...base, coverageTiv: 4_000_000, ...IMPORTER }]);
    captureInsurance(db, [{ ...base, sourceDate: '2026-09-24' }]);
    expect(tivOf(db)).toEqual([4_000_000]);
  });

  it('a differing capture TIV never overwrites an importer-written one; conflict logged once; importer provenance kept', () => {
    const db = freshDb();
    captureInsurance(db, [{ ...base, coverageTiv: 4_000_000, ...IMPORTER }]);
    captureInsurance(db, [{ ...base, coverageTiv: 4_200_000, sourceDate: '2026-09-24' }]);
    captureInsurance(db, [{ ...base, coverageTiv: 4_200_000, sourceDate: '2026-09-25' }]);
    expect(tivOf(db)).toEqual([4_000_000]);
    const rows = dq(db, 'insurance-tiv-conflict');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toMatch(/4000000.*4200000/);
    // The provenance that justifies the protection survives the capture ...
    expect(rowOf(db)).toMatchObject({ source: 'dec.pdf', ingested_by: 'import-insurance-data.ts --policies' });
    // ... while the capture still refreshes source_date (collapseToCurrentTerm's recency signal).
    expect(rowOf(db).source_date).toBe('2026-09-25');
  });

  it('a capture fills a missing TIV', () => {
    const db = freshDb();
    captureInsurance(db, [base]);
    captureInsurance(db, [{ ...base, coverageTiv: 4_000_000, sourceDate: '2026-09-24' }]);
    expect(tivOf(db)).toEqual([4_000_000]);
  });

  it('a capture-written TIV follows the tab: a corrected value replaces it (ruling 2026-09-24 provenance-aware)', () => {
    const db = freshDb();
    captureInsurance(db, [{ ...base, coverageTiv: REDACTED-AMT }]);
    captureInsurance(db, [{ ...base, coverageTiv: 13_000_000, sourceDate: '2026-09-24' }]);
    expect(tivOf(db)).toEqual([13_000_000]);
    expect(dq(db, 'insurance-tiv-conflict')).toEqual([]);
  });

  it('a capture-written TIV mirrors the tab when the tab no longer yields one (no stale same-term carry)', () => {
    const db = freshDb();
    captureInsurance(db, [{ ...base, coverageTiv: 4_000_000 }]);
    captureInsurance(db, [{ ...base, sourceDate: '2026-09-24' }]);
    expect(tivOf(db)).toEqual([null]);
  });

  it('updates a keyed row in place but advances its id, so id still means "captured most recently" (refute wf_2086e104-f2a)', () => {
    const db = freshDb();
    captureInsurance(db, [{ ...base, coverageTiv: 4_000_000 }]);
    const first = rowOf(db).id as number;
    captureInsurance(db, [{ ...base, coverageTiv: 4_000_000, premiumAnnual: 10_500, sourceDate: '2026-09-25' }]);
    const row = rowOf(db);
    expect(row).toMatchObject({ premium_annual: 10_500, source_date: '2026-09-25' });
    expect(row.id as number).toBeGreaterThan(first);
    expect((db.prepare('SELECT COUNT(*) AS n FROM property_insurance_policies').get() as { n: number }).n).toBe(1);
    // A later plain insert never collides with the advanced id.
    captureInsurance(db, [{ ...base, policyNumber: 'Q61-NEW', sourceDate: '2026-09-25' }]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM property_insurance_policies').get() as { n: number }).n).toBe(2);
  });

  it('a same-day edit-and-revert of a policy number leaves the reverted-to row current', () => {
    const db = freshDb();
    const other = { ...base, policyNumber: 'Q61-0000001-002', premiumAnnual: 9_000 };
    captureInsurance(db, [base]);
    captureInsurance(db, [other]);
    captureInsurance(db, [base]);
    const report = buildInsuranceAnalysis(db, '2026-09-24');
    expect(report.renewalCalendar.map((p) => p.premium)).toEqual([10_000]);
  });

  it('a capture carrying null never erases a dec-page deductible / coverage limit', () => {
    const db = freshDb();
    captureInsurance(db, [base]);
    db.prepare('UPDATE property_insurance_policies SET deductible = 25000, coverage_limit = 5000000').run(); // --dec-pages writes by id
    captureInsurance(db, [{ ...base, sourceDate: '2026-09-24' }]);
    expect(rowOf(db)).toMatchObject({ deductible: 25_000, coverage_limit: 5_000_000 });
  });

  it('a differing capture deductible / limit never overwrites a stored one; the conflict is logged once', () => {
    const db = freshDb();
    captureInsurance(db, [base]);
    db.prepare('UPDATE property_insurance_policies SET deductible = 25000').run();
    captureInsurance(db, [{ ...base, deductible: 10_000, sourceDate: '2026-09-24' }]);
    captureInsurance(db, [{ ...base, deductible: 10_000, sourceDate: '2026-09-25' }]);
    expect(rowOf(db)).toMatchObject({ deductible: 25_000 });
    expect(dq(db, 'insurance-decpage-conflict')).toHaveLength(1);
  });

  it('skips a second row with the same (property, policy number, effective) key in one capture, and logs it', () => {
    const db = freshDb();
    captureInsurance(db, [
      { ...base, coverageTiv: 4_000_000 },
      { ...base, policyType: 'Business Catastrophe Liability (BCL)', premiumAnnual: 594 },
    ]);
    expect(rowOf(db)).toMatchObject({ coverage_tiv: 4_000_000, premium_annual: 10_000 });
    expect(dq(db, 'insurance-ingest-duplicate-key')).toHaveLength(1);
  });

  it('writes per-policy TIV notes to data_quality_issues, deduped across captures', () => {
    const db = freshDb();
    const withNote: WarehouseInsurancePolicy = {
      ...base,
      coverageTiv: 4_000_000,
      dataQualityNotes: [{ detail: 'tiv: paired premium basis is reconstructed', severity: 'warn' }],
    };
    captureInsurance(db, [withNote]);
    captureInsurance(db, [{ ...withNote, sourceDate: '2026-09-24' }]);
    expect(dq(db, 'insurance-tiv-basis')).toEqual([{ detail: 'tiv: paired premium basis is reconstructed', severity: 'warn' }]);
  });

  it('snapshotPoliciesToWarehouse carries policy tiv flags through as data-quality notes', () => {
    const [w] = snapshotPoliciesToWarehouse(
      [policy({ tiv: 4_000_000, flags: [{ entity: 'ins-100main-pckg', field: 'tiv', issue: 'reconstructed basis', severity: 'warn' }] })],
      '2026-09-24',
    );
    expect(w?.coverageTiv).toBe(4_000_000);
    expect(w?.dataQualityNotes).toEqual([{ detail: 'tiv: reconstructed basis', severity: 'warn' }]);
  });
});

describe('own-book benchmark + rebid verdicts over captured TIV', () => {
  const AS_OF = '2026-09-24';
  function freshDb(): WarehouseDb {
    return openWarehouse(join(mkdtempSync(join(tmpdir(), 'ins-tiv-bench-')), 'test.sqlite'));
  }
  // Five in-force package terms at $0.20..$0.40 per $100 of a $1M building limit (median $0.30).
  const book = (sourceDate: string): WarehouseInsurancePolicy[] =>
    [2000, 2500, 3000, 3500, 4000].map((premium, i) => ({
      propertyId: `ins-p${i}-pckg`,
      insurer: 'Carrier 01',
      policyNumber: `Q61-${i}`,
      effectiveDate: '2026-06-01',
      expirationDate: '2027-06-01',
      premiumAnnual: premium,
      coverageTiv: 1_000_000,
      policyType: 'Package (PCKG)',
      source: 'brain-server',
      sourceDate,
      ingestedBy: 'brain-server',
    }));
  const verdictCount = (db: WarehouseDb): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM calibration_verdict WHERE verdict_kind = 'insurance-rebid'").get() as { n: number }).n;

  it('an expired term stays out of the cohort median and rebid candidates (ruling 2026-09-24 exclude + flag)', () => {
    const db = freshDb();
    captureInsurance(db, [
      ...book('2026-09-23'),
      {
        ...book('2026-09-23')[0]!,
        propertyId: 'ins-lapsed-pckg',
        policyNumber: 'Q61-L',
        effectiveDate: '2025-09-18',
        expirationDate: '2026-09-18',
        premiumAnnual: 10_000, // $1.00 per $100 — would drag the median up and top the rebid list
      },
    ]);
    const report = buildInsuranceAnalysis(db, AS_OF);
    expect(report.benchmark.cohortN).toBe(5);
    expect(report.benchmark.medianRatePer100Tiv).toBeCloseTo(0.3, 10);
    expect(report.rebidCandidates.map((p) => p.propertyId)).toEqual(['ins-p4-pckg', 'ins-p3-pckg']);
    // Still shown on the calendar (as expired) — excluded from the benchmark, not hidden.
    const lapsed = report.renewalCalendar.find((p) => p.propertyId === 'ins-lapsed-pckg');
    expect(lapsed).toMatchObject({ renewalBucket: 'expired', excessPremiumVsMedian: null });
  });

  it('re-capturing an unchanged book on later days never duplicates rebid verdicts (refute: re-minted ids)', () => {
    const db = freshDb();
    captureInsurance(db, book('2026-09-23'));
    logRebidVerdicts(db, buildInsuranceAnalysis(db, AS_OF));
    expect(verdictCount(db)).toBe(2);
    for (const day of ['2026-09-24', '2026-09-25']) {
      captureInsurance(db, book(day));
      logRebidVerdicts(db, buildInsuranceAnalysis(db, AS_OF));
    }
    expect(verdictCount(db)).toBe(2);
  });

  it('a changed book still forks the verdict inputs version (new verdicts are logged)', () => {
    const db = freshDb();
    captureInsurance(db, book('2026-09-23'));
    logRebidVerdicts(db, buildInsuranceAnalysis(db, AS_OF));
    const changed = book('2026-09-24').map((p, i) => (i === 4 ? { ...p, premiumAnnual: 4_500 } : p));
    captureInsurance(db, changed);
    const r = logRebidVerdicts(db, buildInsuranceAnalysis(db, AS_OF));
    expect(r.written).toBe(2);
    expect(verdictCount(db)).toBe(4);
  });
});
