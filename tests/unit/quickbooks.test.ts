import { describe, it, expect } from 'vitest';
import { QbActuals, NoiBudgetInput } from '../../src/contracts/quickbooks';

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
