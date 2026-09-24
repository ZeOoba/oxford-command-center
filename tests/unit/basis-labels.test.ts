import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('basis labels', () => {
  it('Overview NOI and debt tiles state their basis', () => {
    const w = readFileSync('src/modules/overview/widgets.tsx', 'utf8');
    expect(w).toContain('Oxford share · workbook');
    expect(w).toContain('property loan balances');
  });
  it('Financials briefing states full-asset ledger basis', () => {
    expect(readFileSync('src/modules/intel/OwnershipView.tsx', 'utf8')).toContain('full-asset P&L ledger');
  });
  it('Capital external debt states loan-schedule basis', () => {
    expect(readFileSync('src/modules/debt/DebtModule.tsx', 'utf8')).toContain('loan schedule');
  });
});
