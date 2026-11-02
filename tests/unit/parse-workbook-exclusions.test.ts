// tests/unit/parse-workbook-exclusions.test.ts
//
// Rulings 2026-10-30 (Gabriel), through the real parseWorkbook path on a synthetic workbook:
//  1. A Residence row never reaches the snapshot (no property, lease or flag names it) and the
//     workbook's Portfolio Total is restated net of it, so reconcile-runtime still ties at $1.
//  2. An income property whose expenses read $0 is NNN-not-absolute: it is flagged
//     landlord-costs-not-sourced on the property and in dataQuality, and its values are unchanged.
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWorkbook } from '../../server/workbook/parse';
import { checkSnapshot } from '../../server/reconcile-runtime';
import { LANDLORD_COSTS_NOT_SOURCED_FIELD, landlordCostsNotSourced } from '../../src/analytics/property-basis';
import { slug } from '@contracts/index';

const INDUSTRIAL = 'Fixture Industrial Alpha';
const NNN_ZERO = 'Fixture Flex Beta';
const HOME = '77 Gamma Lane Residence (Fixture)';

// col: idx, name, type, sf, tenantCount, occ, acqDate, estValue100, oxfordOwnPct, oxfordValue,
//      grossIncome, expenses, noi, noiScenarioAdj, debtService, netCashFlow, capRate, dscr,
//      lender, loanBalance, ltv, valuePerSf, rentPerSf, equityInvested, cashOnCash, holdYrs
const row = (idx: number, name: string, type: string, value: number, income: number, expenses: number | null, noi: number) => [
  idx, name, type, 10000, 1, 1, new Date('2020-01-01'), value, 1, value, income, expenses, noi, noi, 0, noi,
  null, null, null, 0, null, null, null, 100000, null, null,
];

async function writeWorkbook(path: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const props = wb.addWorksheet('Property NOI');
  props.addRow(row(1, INDUSTRIAL, 'Industrial', 3_000_000, 300_000, 100_000, 200_000));
  props.addRow(row(2, NNN_ZERO, 'Flex', 1_000_000, 90_000, null, 90_000));
  props.addRow(row(3, HOME, 'Residence', 2_000_000, 0, 0, 0));
  // Portfolio Total INCLUDES the residence, as the live workbook's does.
  props.addRow([null, 'Portfolio Total', null, null, null, null, null, null, null, 6_000_000, null, null, 290_000]);

  const rentRoll = wb.addWorksheet('Master Tenant Rent Roll');
  rentRoll.addRow([INDUSTRIAL, 'Fixture Tenant Co', 'Suite 100', 'Fixture Tenant Co', 10000, 25000, 30, new Date('2022-01-01'), new Date('2029-01-01'), null, null, 'Active', 300000]);
  // A RENTED residence line (refute wf_4b941bed-52e: the rent total must be restated too).
  rentRoll.addRow([HOME, 'Fixture Occupant', null, null, 0, 3000, null, new Date('2022-01-01'), new Date('2029-01-01'), null, null, 'Active', 36000]);
  // Rent-roll Portfolio Total INCLUDES the residence line (legacy total column 14).
  rentRoll.addRow(['Portfolio Total', null, null, null, null, null, null, null, null, null, null, null, null, 336000]);

  wb.addWorksheet('Loan Index');
  wb.addWorksheet('Cash Balances');
  wb.addWorksheet('Insurance Renewals');
  wb.addWorksheet('Monthly Checklist');
  wb.addWorksheet('Assumptions');
  await wb.xlsx.writeFile(path);
}

async function parsed() {
  const file = join(mkdtempSync(join(tmpdir(), 'parse-exclusions-')), 'fixture.xlsx');
  await writeWorkbook(file);
  return parseWorkbook(file);
}

describe('parseWorkbook — residence exclusion (ruling 2026-10-30)', () => {
  it('drops the residence row, its leases and its flags from the snapshot', async () => {
    const { snapshot } = await parsed();
    const homeId = slug(HOME);
    expect(snapshot.properties.map((p) => p.id)).toEqual([slug(INDUSTRIAL), slug(NNN_ZERO)]);
    expect(snapshot.properties.some((p) => p.type === 'Residence')).toBe(false);
    expect(snapshot.leases.some((l) => l.propertyId === homeId || l.propertyKey === HOME)).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain(HOME);
    expect(JSON.stringify(snapshot)).not.toContain(homeId);
    expect(JSON.stringify(snapshot).toLowerCase()).not.toContain('gamma');
  });

  it('restates the workbook totals net of the residence so the runtime tie-out still holds', async () => {
    const { snapshot, excludedHoldings } = await parsed();
    expect(excludedHoldings).toEqual({ count: 1, noi: 0, oxfordValue: 2_000_000, annualRent: 36_000 });
    expect(snapshot.workbookTotals.value).toBe(4_000_000);
    expect(snapshot.workbookTotals.noi).toBe(290_000);
    expect(snapshot.workbookTotals.rent).toBe(300_000);
    const tieFlags = checkSnapshot(snapshot).filter((f) =>
      f.field === 'properties.noi' || f.field === 'properties.oxfordValue' || f.field === 'leases.annualRent');
    expect(tieFlags).toEqual([]);
  });

  it('a rent-roll line removed with the residence is never silent: it blocks persist and bake', async () => {
    const { snapshot } = await parsed();
    const err = snapshot.dataQuality.find((f) => f.field === 'leases.excludedHoldings');
    expect(err).toMatchObject({ entity: 'reconciliation', severity: 'error' });
    expect(err!.issue).not.toMatch(/gamma/i);
    const { refuseBakeOnReconciliation } = await import('../../scripts/bake-mirror');
    expect(refuseBakeOnReconciliation(snapshot)).toMatch(/leases\.excludedHoldings/);
  });
});

describe('parseWorkbook — NNN landlord costs not sourced (ruling 2026-10-30)', () => {
  it('flags only the income property whose expenses read $0, without changing its values', async () => {
    const { snapshot } = await parsed();
    const nnn = snapshot.properties.find((p) => p.id === slug(NNN_ZERO))!;
    const industrial = snapshot.properties.find((p) => p.id === slug(INDUSTRIAL))!;
    expect(landlordCostsNotSourced(nnn)).toBe(true);
    expect(landlordCostsNotSourced(industrial)).toBe(false);
    expect(nnn.expenses).toBe(0);
    expect(nnn.noi).toBe(90_000);
    const listed = snapshot.dataQuality.filter((f) => f.field === LANDLORD_COSTS_NOT_SOURCED_FIELD);
    expect(listed.map((f) => f.entity)).toEqual([nnn.id]);
    expect(listed[0]!.severity).toBe('info');
  });
});

describe('parseWorkbook — exclusion guards (refute wf_b6010683-4be)', () => {
  it('refuses the snapshot when a residence shares its name with an investment row', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'parse-exclusions-')), 'dup.xlsx');
    const wb = new ExcelJS.Workbook();
    const props = wb.addWorksheet('Property NOI');
    props.addRow(row(1, 'Fixture Beta', 'Residence', 1_000_000, 0, 0, 0));
    props.addRow(row(2, 'Fixture Beta', 'Flex', 1_000_000, 90_000, 10_000, 80_000));
    wb.addWorksheet('Master Tenant Rent Roll');
    for (const n of ['Loan Index', 'Cash Balances', 'Insurance Renewals', 'Monthly Checklist', 'Assumptions']) wb.addWorksheet(n);
    await wb.xlsx.writeFile(file);
    const { flags } = await parseWorkbook(file);
    expect(flags.some((f) => f.entity === 'reconciliation' && f.field === 'properties.excludedHoldings' && f.severity === 'error')).toBe(true);
  });

  it('appends the standing NNN disclosures after every other parse flag', async () => {
    const { snapshot } = await parsed();
    const firstNnn = snapshot.dataQuality.findIndex((f) => f.field === LANDLORD_COSTS_NOT_SOURCED_FIELD);
    expect(firstNnn).toBeGreaterThan(-1);
    expect(snapshot.dataQuality.slice(firstNnn).every((f) => f.field === LANDLORD_COSTS_NOT_SOURCED_FIELD)).toBe(true);
  });
});

describe('parseWorkbook — exact-only exclusion (refute wf_305adf92-ca4)', () => {
  async function parseWith(build: (wb: ExcelJS.Workbook) => void) {
    const file = join(mkdtempSync(join(tmpdir(), 'parse-exclusions-')), 'x.xlsx');
    const wb = new ExcelJS.Workbook();
    build(wb);
    for (const n of ['Loan Index', 'Master Tenant Rent Roll', 'Cash Balances', 'Insurance Renewals', 'Monthly Checklist', 'Assumptions']) {
      if (!wb.getWorksheet(n)) wb.addWorksheet(n);
    }
    await wb.xlsx.writeFile(file);
    return parseWorkbook(file);
  }
  const blocked = (flags: { entity: string; field: string; severity: string }[]) =>
    flags.some((f) => f.entity === 'reconciliation' && f.field === 'properties.excludedHoldings' && f.severity === 'error');

  it('a punctuation-only name difference between a residence and an investment row blocks the persist', async () => {
    const { flags } = await parseWith((wb) => {
      const props = wb.addWorksheet('Property NOI');
      props.addRow(row(1, '20 Oak Ln.', 'Residence', 1_000_000, 0, 0, 0));
      props.addRow(row(2, '20 Oak Ln', 'Flex', 1_000_000, 90_000, 10_000, 80_000));
    });
    expect(blocked(flags)).toBe(true);
  });

  it('keeps an unresolved investment lease whose label merely resembles the residence', async () => {
    const { snapshot, excludedHoldings } = await parseWith((wb) => {
      const props = wb.addWorksheet('Property NOI');
      props.addRow(row(1, '20 Oak Ln (Fixture)', 'Residence', 1_000_000, 0, 0, 0));
      props.addRow(row(2, INDUSTRIAL, 'Industrial', 3_000_000, 300_000, 100_000, 200_000));
      wb.addWorksheet('Master Tenant Rent Roll').addRow(
        ['20 Oakland Business Park', 'Fixture Tenant Co', 'Suite 1', null, 1000, 25000, 30, new Date('2022-01-01'), new Date('2029-01-01'), null, null, 'Active', 300000],
      );
    });
    expect(snapshot.leases.map((l) => l.propertyKey)).toEqual(['20 Oakland Business Park']);
    expect(excludedHoldings.annualRent).toBe(0);
  });

  it('a loan that resolves to the residence is not dropped silently: it blocks the persist', async () => {
    const { snapshot, flags } = await parseWith((wb) => {
      const props = wb.addWorksheet('Property NOI');
      props.addRow(row(1, HOME, 'Residence', 2_000_000, 0, 0, 0));
      props.addRow(row(2, INDUSTRIAL, 'Industrial', 3_000_000, 300_000, 100_000, 200_000));
      const loans = wb.addWorksheet('Loan Index');
      loans.addRow(['IS BORROWER']);
      loans.addRow([1, 'Fixture Mortgage', 'Fixture Bank', 400000, 0.05, 2500, new Date('2040-01-01'), 160, null, 'Current', HOME]);
    });
    expect(snapshot.loans).toHaveLength(1);
    expect(blocked(flags)).toBe(true);
    expect(flags.filter((f) => f.field === 'properties.excludedHoldings').every((f) => !f.issue.includes('Gamma'))).toBe(true);
  });
});
