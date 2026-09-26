import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { overviewTotalDebtSublabel, externalDebtSublabel } from '../../src/modules/debt/debt-sublabels';
import type { PortfolioKpis } from '../../src/analytics/index';

const cell = (value: number) => ({ value, prov: { source: 't', confidence: 'derived' as const } });

describe('basis labels', () => {
  it('Overview NOI tile states its basis; the debt tile uses the shared sublabel builder', () => {
    const w = readFileSync('src/modules/overview/widgets.tsx', 'utf8');
    expect(w).toContain('Oxford share · workbook');
    expect(w).toContain('overviewTotalDebtSublabel(k)');
  });
  it('Financials briefing states full-asset ledger basis', () => {
    expect(readFileSync('src/modules/intel/OwnershipView.tsx', 'utf8')).toContain('full-asset P&L ledger');
  });
  it('Capital external debt uses the shared sublabel builder', () => {
    expect(readFileSync('src/modules/debt/DebtModule.tsx', 'utf8')).toContain('externalDebtSublabel(');
  });
});

describe('basis labels lead (KpiStat truncates from the end) — a disclosure clause, when present, leads the basis', () => {
  it('NOI basis is the start of its sublabel', () => {
    expect(readFileSync('src/modules/overview/widgets.tsx', 'utf8')).toContain('sublabel={`Oxford share · workbook · ');
  });
  it('Total Debt: basis leads when there is nothing to disclose', () => {
    const k = { ltv: cell(0.2), affiliateDebt: cell(0) } as unknown as PortfolioKpis;
    expect(overviewTotalDebtSublabel(k).startsWith('property loan balances · ')).toBe(true);
  });
  it('External Debt: basis leads when there is nothing to disclose', () => {
    expect(externalDebtSublabel({ affiliateDebt: 0 }, 3).startsWith('loan schedule · ')).toBe(true);
  });
});
