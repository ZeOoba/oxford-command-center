// Close page KPI tiles must not present a zero total as a real figure when no budget/actual pairs exist
// (audit close-noi-paired-totals-false-ontrack). pairedCount alone decides figure-vs-dash.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const snap: { data: unknown } = { data: undefined };
vi.mock('../../src/data/queries', () => ({ useSnapshot: () => snap, SNAPSHOT_KEY: ['snapshot'] }));
vi.mock('../../src/shell/SnapshotGate', () => ({ useSnapshotGate: () => null }));

import { CloseModule } from '../../src/modules/close/CloseModule';

afterEach(cleanup);

const qbProp = (id: string, name: string, noi: number) => ({
  propertyKey: name, propertyId: id, annualIncome: noi + 10000, annualExpense: 10000, annualNoi: noi, monthly: [], glExpense: [],
});

function renderWith(noiBudgets: Record<string, number>) {
  snap.data = {
    snapshot: {
      properties: [{ id: 'a', name: 'Prop A' }, { id: 'b', name: 'Prop B' }],
      noiBudgets,
      quickbooks: { sourceFile: null, parsedAt: '2026-06-05T00:00:00.000Z', properties: [qbProp('a', 'Prop A', 90000), qbProp('b', 'Prop B', 60000)] },
    },
  };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><CloseModule /></QueryClientProvider>);
}

describe('CloseModule — pairing coverage', () => {
  it('QuickBooks actuals with zero budgets: Actual, Budget and Variance tiles all show a dash, never $0', () => {
    const { container } = renderWith({});
    const text = container.textContent ?? '';
    expect(text).toContain('no budget/actual pairs');
    expect(text).toContain('0 of 2 paired');
    // none of the three NOI tiles may render a $0 figure
    expect(screen.queryByText('$0')).toBeNull();
    expect(screen.queryByText('$0K')).toBeNull();
  });

  it('each tile\'s "n of m paired" sublabel uses its own denominator (actual / budgeted / all properties)', () => {
    // a = paired; b, d = budget only (no QuickBooks); c = QuickBooks only (no budget).
    // paired 1 · budgeted 3 · actual 2 · rows 4 — every denominator is different.
    snap.data = {
      snapshot: {
        properties: [{ id: 'a', name: 'Prop A' }, { id: 'b', name: 'Prop B' }, { id: 'c', name: 'Prop C' }, { id: 'd', name: 'Prop D' }],
        noiBudgets: { a: 100000, b: 50000, d: 20000 },
        quickbooks: { sourceFile: null, parsedAt: '2026-06-05T00:00:00.000Z', properties: [qbProp('a', 'Prop A', 90000), qbProp('c', 'Prop C', 60000)] },
      },
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><CloseModule /></QueryClientProvider>);
    const tile = (label: string): string => {
      let el: HTMLElement | null = screen.getByText(label);
      while (el && !/paired/.test(el.textContent ?? '')) el = el.parentElement;
      return el?.textContent ?? '';
    };
    expect(tile('Actual NOI')).toContain('1 of 2 paired');
    expect(tile('Budget NOI')).toContain('1 of 3 paired');
    expect(tile('Portfolio Variance')).toContain('1 below budget · 1 of 4 paired');
  });

  it('with pairs, shows the figures and the "n of m paired" coverage', () => {
    const { container } = renderWith({ a: 100000, b: 50000 });
    const text = container.textContent ?? '';
    expect(text).toContain('2 of 2 paired');
    expect(text).not.toContain('no budget/actual pairs');
    expect(text).toContain('$150K'); // paired actual and budget are both 150,000
  });
});
