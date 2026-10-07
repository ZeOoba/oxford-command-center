// @vitest-environment node
//
// tests/unit/import-pca-register.test.ts
//
// PCA register → Property Condition ledger (migration 035). parseRegister is pure (in-memory ExcelJS
// workbook, never the OneDrive file); writeRegister is exercised against a fresh tmpdir warehouse.
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import {
  classifyUsability,
  knownMasterIds,
  parseArgs,
  parseRegister,
  resolveProperty,
  splitDateQualifier,
  warrantyEndYear,
  writeRegister,
} from '../../scripts/import-pca-register';

const KNOWN = new Set(['sepich-portfolio-columbus-oh-8-props', '55-new-plant-ct-owings-mills-md']);

const REG_HEADERS = [
  'Report ID', 'Property', 'Location', 'Consultant / report no.', 'Client (per report)', 'ORA-commissioned?', 'Purpose',
  'Inspection date', 'Report date', 'SF', 'Bldgs', 'Year built', 'Immediate $', 'Short-term (Yr1-2) $',
  'Reserves uninflated $', 'Reserves inflated $', 'Term (yrs)', '$/SF/yr (as stated)', 'Report age (yrs @2026)',
  'Usability for forecasting', 'Source file(s)', 'Notes',
];
const COMP_HEADERS = ['Report ID', 'Property', 'System', 'Qty', 'UOM', 'Unit cost $/UOM', '% / factor', 'EUL', 'Age', 'RUL', 'Total / scheduled $', 'Timing', 'Basis', 'Note'];
const QUOTE_HEADERS = ['Record (title)', 'Property', 'Vendor', 'Record Type', 'Status', 'Trade', 'Doc Date', 'Quoted Total', 'Actual Total', 'Qty', 'UOM', '$/UOM [DERIVED]', 'Scope Summary', 'Source Type', 'Source Ref', 'Confidence', 'Verified', 'Funding Class', 'Lease Recovery', 'Notes'];
const ASSET_HEADERS = ['Property', 'Component', 'Install / age fact', 'Derived install yr', 'Warranty', 'Source / as-of', 'Flag'];
const FLAG_HEADERS = ['#', 'Severity', 'Property', 'Issue', 'Action / decision needed'];

function reg(over: Record<string, unknown> = {}): unknown[] {
  const base: Record<string, unknown> = {
    'Report ID': 'R01', 'Property': '2800-2826 Banwick Rd', 'Location': 'Columbus OH', 'Consultant / report no.': 'Intertek',
    'Client (per report)': 'FVC LLC', 'ORA-commissioned?': 'Yes', 'Purpose': 'Refi', 'Inspection date': '2026-03-23',
    'Report date': '2026-04-07', 'SF': 24000, 'Bldgs': 1, 'Year built': '1981', 'Immediate $': 1050, 'Short-term (Yr1-2) $': null,
    'Reserves uninflated $': 221712, 'Reserves inflated $': 232985.52, 'Term (yrs)': 12, '$/SF/yr (as stated)': 0.77,
    'Report age (yrs @2026)': 0, 'Usability for forecasting': 'CURRENT', 'Source file(s)': 'x.pdf', 'Notes': null, ...over,
  };
  return REG_HEADERS.map((h) => base[h] ?? null);
}

function build(opts: { reg?: unknown[][]; comp?: unknown[][]; quote?: unknown[][]; asset?: unknown[][]; flag?: unknown[][] } = {}): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('PCA_Register').addRows([REG_HEADERS, ...(opts.reg ?? [reg()])]);
  wb.addWorksheet('Components').addRows([COMP_HEADERS, ...(opts.comp ?? [['R01', 'Banwick', 'Paving', 2230, 'SY', 42.5, '40%', 25, 24, 1, 37910, 'Yr1', 'Estimate', 'Poor']])]);
  wb.addWorksheet('Quotes_Actuals').addRows([QUOTE_HEADERS, ...(opts.quote ?? [[
    '55 New Plant roof', '55 New Plant Ct', 'R.D. Bean', 'Proposal', 'Completed', 'Roofing', '2017-02-03', 81870, null, 28700, 'SF', 2.85,
    'EPDM', 'SharePoint file', 'ref', 'Medium', 'No', 'Unknown', 'Unreviewed', null,
  ]])]);
  wb.addWorksheet('Asset_Facts').addRows([ASSET_HEADERS, ...(opts.asset ?? [[
    '55 New Plant Ct', 'Roof — EPDM', 'Completed 2017-12-05', 2017, 'JM 20-yr to 12-2037', 'warranty', null,
  ]])]);
  wb.addWorksheet('Flags_Open_Items').addRows([FLAG_HEADERS, ...(opts.flag ?? [[1, 'High', '3520 E Fulton', 'CBRE floor', 'Commission PCA']])]);
  return wb;
}

describe('parseRegister', () => {
  it('parses a clean workbook with no rejects and maps Banwick to the Sepich master id', () => {
    const p = parseRegister(build(), KNOWN);
    expect(p.rejects).toEqual([]);
    expect(p.reports).toHaveLength(1);
    expect(p.reports[0]).toMatchObject({
      reportId: 'R01', propertyKey: 'banwick', propertyMasterId: 'sepich-portfolio-columbus-oh-8-props',
      oraCommissioned: true, immediateUsd: 1050, shortTermUsd: null, usabilityClass: 'current',
    });
    expect(p.components[0]).toMatchObject({ rowSeq: 1, basis: 'estimate', totalUsd: 37910 });
    expect(p.quotes[0]).toMatchObject({ propertyKey: 'new-plant', verified: false, quotedUsd: 81870, actualUsd: null });
    expect(p.assets[0]).toMatchObject({ installYear: 2017, warrantyEndYear: 2037 });
    expect(p.openItems[0]).toMatchObject({ itemNo: 1, severity: 'High' });
  });

  it('leaves property_master_id NULL when the mapped id is not a known master row', () => {
    const p = parseRegister(build(), new Set());
    expect(p.reports[0]?.propertyMasterId).toBeNull();
    expect(p.reports[0]?.propertyKey).toBe('banwick');
  });

  it('rejects a non-Estimate component basis (price-basis discipline)', () => {
    const p = parseRegister(build({ comp: [['R01', 'B', 'Roof', 1, 'LS', 5, null, 20, 1, 19, 5, 'Yr1', 'Quote', null]] }), KNOWN);
    expect(p.components).toHaveLength(0);
    expect(p.rejects[0]?.reason).toMatch(/Basis must be 'Estimate'/);
  });

  it('rejects an orphan component, a bad number, a negative dollar and a bad date', () => {
    const p = parseRegister(
      build({
        reg: [reg(), reg({ 'Report ID': 'R02', 'Immediate $': 'abc' }), reg({ 'Report ID': 'R03', 'Immediate $': -5 }), reg({ 'Report ID': 'R04', 'Report date': '04/07/2026' })],
        comp: [['R99', 'x', 'Roof', 1, 'LS', 5, null, 20, 1, 19, 5, 'Yr1', 'Estimate', null]],
      }),
      KNOWN,
    );
    expect(p.reports.map((r) => r.reportId)).toEqual(['R01']);
    const reasons = p.rejects.map((r) => r.reason).join('\n');
    expect(reasons).toMatch(/R02: immediateUsd is not a valid number/);
    expect(reasons).toMatch(/R03:/);
    expect(reasons).toMatch(/R04:/);
    expect(reasons).toMatch(/R99: no matching PCA_Register row/);
  });

  it('rejects a duplicate report id and a duplicate quote', () => {
    const q = ['dup', '55 New Plant Ct', 'v', 'Proposal', 'Open', 'Roofing', '2017-02', 1, null, null, null, null, null, null, null, null, 'No', null, null, null];
    const p = parseRegister(build({ reg: [reg(), reg()], quote: [q, q] }), KNOWN);
    expect(p.reports).toHaveLength(1);
    expect(p.quotes).toHaveLength(1);
    expect(p.rejects.map((r) => r.reason).join('\n')).toMatch(/duplicate Report ID R01/);
    expect(p.rejects.map((r) => r.reason).join('\n')).toMatch(/duplicate record for this property/);
  });

  it('throws when a required sheet or column is missing', () => {
    const wb = build();
    wb.removeWorksheet('Components');
    expect(() => parseRegister(wb, KNOWN)).toThrow(/missing sheet 'Components'/);
  });

  it('maps the R17 Sepich narrative to the portfolio key, not Banwick', () => {
    expect(resolveProperty('Sepich Portfolio — 8 Columbus groups (2800-2826 Banwick, 384 Morrison)', KNOWN).key).toBe('sepich-portfolio');
    expect(resolveProperty('3520 E Fulton St', KNOWN)).toEqual({ key: 'e-fulton', masterId: null });
    expect(resolveProperty('Somewhere New 123', KNOWN)).toEqual({ key: 'somewhere-new-123', masterId: null });
  });
});

describe('real-register quirks', () => {
  it("keeps a range RUL ('1-2') as text with a null integer RUL", () => {
    const p = parseRegister(build({ comp: [['R01', 'x', 'TPO re-roof', 28900, 'SF', 7, null, null, null, '1-2', 202300, 'Immediate', 'Estimate', null]] }), KNOWN);
    expect(p.rejects).toEqual([]);
    expect(p.components[0]).toMatchObject({ rul: null, rulRaw: '1-2', totalUsd: 202300 });
  });

  it('accepts Med and Info severities as printed', () => {
    const p = parseRegister(build({ flag: [[5, 'Med', 'x', 'issue', null], [15, 'Info', 'y', 'fyi', null], [16, 'Bogus', 'z', 'bad', null]] }), KNOWN);
    expect(p.openItems.map((i) => i.severity)).toEqual(['Med', 'Info']);
    expect(p.rejects).toHaveLength(1);
  });

  it('splits a qualified report date and carries the qualifier into notes', () => {
    expect(splitDateQualifier('2020-12-24 (PDF metadata)')).toEqual({ date: '2020-12-24', qualifier: '(PDF metadata)' });
    expect(splitDateQualifier('2025-11')).toEqual({ date: '2025-11', qualifier: null });
    const p = parseRegister(build({ reg: [reg({ 'Report date': '2020-12-24 (PDF metadata)', 'Notes': 'n' })] }), KNOWN);
    expect(p.reports[0]).toMatchObject({ reportDate: '2020-12-24', notes: 'n | report date (PDF metadata)' });
  });
});

describe('helpers', () => {
  it('classifies usability text', () => {
    expect(classifyUsability('CURRENT')).toBe('current');
    expect(classifyUsability('CURRENT but DRAFT watermark')).toBe('draft');
    expect(classifyUsability('STALE (install dates only)')).toBe('stale');
    expect(classifyUsability('EXPIRED reserve window')).toBe('stale');
    expect(classifyUsability('USE WITH CAUTION')).toBe('limited');
    expect(classifyUsability('NARRATIVE ONLY — no $')).toBe('limited');
    expect(classifyUsability(null)).toBe('unknown');
  });

  it('reads a warranty end year only when stated, never derived', () => {
    expect(warrantyEndYear('JM Peak 20-yr to 12-2037')).toBe(2037);
    expect(warrantyEndYear('20-yr, warranty to 2028')).toBe(2028);
    expect(warrantyEndYear('20-yr Holcim from 10/2022')).toBeNull();
    expect(warrantyEndYear(null)).toBeNull();
  });

  it('parses CLI args', () => {
    expect(parseArgs(['r.xlsx', '--db', 'x.sqlite'])).toEqual({ xlsxPath: 'r.xlsx', db: 'x.sqlite' });
    expect(() => parseArgs([])).toThrow(/Usage/);
    expect(() => parseArgs(['r.xlsx', '--db'])).toThrow(/missing value/);
  });
});

describe('writeRegister', () => {
  function freshDb() {
    return openWarehouse(join(mkdtempSync(join(tmpdir(), 'pca-reg-')), 'finance.sqlite'));
  }

  it('loads rows, and a re-run replaces rather than duplicates', () => {
    const db = freshDb();
    try {
      const parsed = parseRegister(build(), knownMasterIds(db));
      expect(writeRegister(db, parsed)).toEqual({ reports: 1, components: 1, quotes: 1, assets: 1, openItems: 1 });
      writeRegister(db, parsed);
      const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      expect([count('pca_reports'), count('pca_components'), count('capex_quotes'), count('asset_facts'), count('pca_open_items')]).toEqual([1, 1, 1, 1, 1]);
      const r = db.prepare('SELECT ora_commissioned, usability_class FROM pca_reports').get() as { ora_commissioned: number; usability_class: string };
      expect(r).toEqual({ ora_commissioned: 1, usability_class: 'current' });
    } finally {
      db.close();
    }
  });

  it('a corrected register replaces the prior load', () => {
    const db = freshDb();
    try {
      writeRegister(db, parseRegister(build(), new Set()));
      writeRegister(db, parseRegister(build({ reg: [reg({ 'Report ID': 'R09', 'Immediate $': 7 })], comp: [] }), new Set()));
      const rows = db.prepare('SELECT report_id, immediate_usd FROM pca_reports').all();
      expect(rows).toEqual([{ report_id: 'R09', immediate_usd: 7 }]);
    } finally {
      db.close();
    }
  });

  it('the DB itself refuses a non-estimate component basis', () => {
    const db = freshDb();
    try {
      writeRegister(db, parseRegister(build(), new Set()));
      expect(() => db.prepare("UPDATE pca_components SET basis = 'quote'").run()).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });
});
