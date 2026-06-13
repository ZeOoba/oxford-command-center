// tests/unit/warehouse-contracts.test.ts
import { describe, expect, it } from 'vitest';
import {
  Classification,
  ImportStatus,
  isNoiIncomeClass,
  isOpex,
  LedgerEntrySchema,
  NOI_CLASSES,
  NOI_INCOME_CLASSES,
  PropertyMasterRowSchema,
  RawStatementSchema,
} from '@contracts/warehouse';

describe('warehouse contracts', () => {
  it('accepts a valid property master row', () => {
    const row = PropertyMasterRowSchema.parse({
      id: '1100-rarig-ave-columbus-oh',
      name: '1100 Rarig Ave, Columbus OH',
      market: 'Columbus OH',
      propertyManager: 'Kohr Royer Griffith',
      pmContact: 'Paul Trautman',
      financialMode: 'pnl',
      ownershipPct: 1,
      rentableSf: 21000,
      acquisitionDate: '2023-10-06',
    });
    expect(row.financialMode).toBe('pnl');
  });

  it('rejects an unknown classification', () => {
    expect(() => Classification.parse('operating')).toThrow();
    expect(Classification.parse('opex')).toBe('opex');
  });

  it('NOI classes exclude capex, ti, leasing, debt-service, excluded', () => {
    expect(NOI_CLASSES).toEqual(['revenue', 'recovery', 'other-income', 'opex']);
  });

  it('derives NOI income classes and class predicates as the single source of truth', () => {
    // NOI_INCOME_CLASSES = NOI_CLASSES minus opex, preserving order. The four production NOI
    // codepaths (queries.noiMatrix, metrics.propertyPeriodMetrics, warehouse-verify, warehouse-backfill)
    // all derive from these; a regression here is meant to fail loudly in one place.
    expect(NOI_INCOME_CLASSES).toEqual(['revenue', 'recovery', 'other-income']);
    expect(NOI_INCOME_CLASSES).not.toContain('opex');
    // isNoiIncomeClass: true for exactly the income members, false for opex and all non-NOI classes.
    for (const c of ['revenue', 'recovery', 'other-income']) expect(isNoiIncomeClass(c)).toBe(true);
    for (const c of ['opex', 'capex', 'ti', 'leasing', 'debt-service', 'excluded', 'unknown']) {
      expect(isNoiIncomeClass(c)).toBe(false);
    }
    // isOpex: the single negative pivot; mutually exclusive with isNoiIncomeClass.
    expect(isOpex('opex')).toBe(true);
    for (const c of ['revenue', 'recovery', 'other-income', 'capex', 'excluded']) expect(isOpex(c)).toBe(false);
  });

  it('parses a ledger entry and an import status', () => {
    const e = LedgerEntrySchema.parse({
      importId: 1,
      propertyId: '1100-rarig-ave-columbus-oh',
      period: '2025',
      rawAccount: 'Rent',
      glCode: '5064',
      amount: 214557.21,
      normalizedCategory: 'Rental Revenue',
      classification: 'revenue',
    });
    expect(e.amount).toBeCloseTo(214557.21);
    expect(ImportStatus.parse('pending-review')).toBe('pending-review');
  });

  it('rejects non-finite amounts and invalid period months', () => {
    const base = {
      importId: 1, propertyId: 'p', period: '2025', rawAccount: 'Rent',
      amount: 1, normalizedCategory: 'Rental Revenue', classification: 'revenue',
    };
    expect(() => LedgerEntrySchema.parse({ ...base, amount: Infinity })).toThrow();
    expect(() => LedgerEntrySchema.parse({ ...base, amount: NaN })).toThrow();
    expect(() => LedgerEntrySchema.parse({ ...base, period: '2025-13' })).toThrow();
    expect(() => LedgerEntrySchema.parse({ ...base, period: '2025-00' })).toThrow();
    expect(LedgerEntrySchema.parse({ ...base, period: '2025-12' }).period).toBe('2025-12');
  });

  it('parses a raw statement from an adapter', () => {
    const s = RawStatementSchema.parse({
      propertyRaw: '1100 Rarig Ave',
      periodLabel: '01/01/25 - 12/31/25  (cash basis)',
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
      grain: 'year',
      basis: 'cash',
      sourceSystem: 'quickbooks',
      accounts: [{ code: '5064', name: 'Rent', section: 'INCOME', parent: 'RENTAL INCOME', total: 214557.21 }],
      totalIncome: 231187.84,
      totalExpense: 125539.93,
    });
    expect(s.accounts).toHaveLength(1);
  });
});
