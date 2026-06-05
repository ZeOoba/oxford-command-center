import { describe, it, expect } from 'vitest';
import { QbActuals, NoiBudgetInput } from '../../src/contracts/quickbooks';
import { parseQuickbooksCsv } from '../../server/sources/quickbooks';
import type { Property } from '../../src/contracts/index';

describe('QuickBooks contract', () => {
  it('defaults a QbActuals with empty properties', () => {
    const a = QbActuals.parse({ parsedAt: '2026-06-05T00:00:00.000Z' });
    expect(a.properties).toEqual([]);
    expect(a.sourceFile).toBeNull();
  });
  it('validates the budget action input', () => {
    expect(NoiBudgetInput.safeParse({ propertyId: 'p1', amount: 250000 }).success).toBe(true);
    expect(NoiBudgetInput.safeParse({ propertyId: '', amount: 1 }).success).toBe(false);
    expect(NoiBudgetInput.safeParse({ propertyId: 'p1', amount: -5 }).success).toBe(false);
  });
});

const props = [
  { id: 'rarig', name: '1100 Rarig Ave' },
  { id: 'northwood', name: '2207 Northwood' },
] as unknown as Property[];

const CSV = `Property,Month,Account,Type,Amount
1100 Rarig,2026-01,Rental Income,Income,"$42,000"
1100 Rarig,2026-01,Repairs & Maintenance,Expense,3100
1100 Rarig,2026-02,Rental Income,Income,42000
1100 Rarig,2026-02,Insurance,Expense,900
2207 Northwood,2026-01,Rental Income,Income,38000
Unknown Strip Mall,2026-01,Rental Income,Income,5000`;

const NOW = '2026-06-05T00:00:00.000Z';

describe('parseQuickbooksCsv', () => {
  const qb = parseQuickbooksCsv(CSV, props, NOW)!;

  it('groups by property and sums annual income/expense/NOI', () => {
    const rarig = qb.properties.find((p) => p.propertyKey === '1100 Rarig')!;
    expect(rarig.annualIncome).toBe(84000); // 42k + 42k
    expect(rarig.annualExpense).toBe(4000); // 3100 + 900
    expect(rarig.annualNoi).toBe(80000);
    expect(rarig.monthly).toHaveLength(2);
  });

  it('resolves propertyId by name containment; leaves unmatched null', () => {
    expect(qb.properties.find((p) => p.propertyKey === '1100 Rarig')!.propertyId).toBe('rarig');
    expect(qb.properties.find((p) => p.propertyKey === 'Unknown Strip Mall')!.propertyId).toBeNull();
  });

  it('itemizes GL expense per property (no hardcoded categories)', () => {
    const rarig = qb.properties.find((p) => p.propertyKey === '1100 Rarig')!;
    expect(rarig.glExpense.map((g) => g.account).sort()).toEqual(['Insurance', 'Repairs & Maintenance']);
  });

  it('parses tolerant amounts ($ and commas) and stamps parsedAt', () => {
    expect(qb.parsedAt).toBe(NOW);
    const rarig = qb.properties.find((p) => p.propertyKey === '1100 Rarig')!;
    expect(rarig.monthly.find((m) => m.month === '2026-01')!.income).toBe(42000);
  });

  it('infers type from the account when no Type column is present', () => {
    const noType = `Property,Month,Account,Amount\n1100 Rarig,2026-01,Rental Income,1000\n1100 Rarig,2026-01,Landscaping,200`;
    const r = parseQuickbooksCsv(noType, props, NOW)!.properties[0]!;
    expect(r.annualIncome).toBe(1000); // "Rental Income" → income
    expect(r.annualExpense).toBe(200); // "Landscaping" → expense
  });

  it('returns null for empty/headerless content', () => {
    expect(parseQuickbooksCsv('', props, NOW)).toBeNull();
    expect(parseQuickbooksCsv('not,a,recognized,header', props, NOW)).toBeNull();
  });
});
