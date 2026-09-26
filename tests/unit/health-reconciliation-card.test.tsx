import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DataQualityFlag } from '../../src/contracts/index';
import { reconciliationCardState } from '../../src/modules/health/reconciliation-card';

const snap: { data: unknown } = { data: undefined };
vi.mock('../../src/data/queries', () => ({ useSnapshot: () => snap }));
vi.mock('../../src/data/brain-context', () => ({ useBrain: () => ({ state: null }) }));

import { HealthModule } from '../../src/modules/health/HealthModule';

const basis: DataQualityFlag = { entity: 'debt', field: 'debt.basis.property.p1', issue: 'Alpha: gap $39,388', severity: 'warn' };
const reconWarn: DataQualityFlag = { entity: 'reconciliation', field: 'cash.history.date', issue: 'missing rows', severity: 'warn' };
const reconError: DataQualityFlag = { entity: 'reconciliation', field: 'properties.noi', issue: 'Σ NOI ≠ workbook', severity: 'error' };
const other: DataQualityFlag = { entity: 'lease', field: 'lease.l1.leaseEnd', issue: 'stale', severity: 'warn' };

describe('reconciliationCardState', () => {
  it('green "Consistent" only when there is neither a reconciliation nor a debt-basis flag', () => {
    expect(reconciliationCardState([other])).toEqual({ badgeTone: 'green', badgeLabel: 'Consistent', rows: [] });
  });
  it('a debt-basis flag alone is amber and never "Consistent"', () => {
    expect(reconciliationCardState([basis])).toEqual({ badgeTone: 'amber', badgeLabel: '1 debt basis gap', rows: [basis] });
  });
  it('warn-only reconciliation rows are amber, not red (item 8 on this card)', () => {
    expect(reconciliationCardState([reconWarn, basis])).toMatchObject({ badgeTone: 'amber', badgeLabel: '2 warnings' });
  });
  it('any error-severity reconciliation flag is red', () => {
    expect(reconciliationCardState([reconError, basis])).toMatchObject({ badgeTone: 'red', badgeLabel: '2 issues', rows: [reconError, basis] });
  });
});

describe('HealthModule Reconciliation card', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  it('shows the debt-basis row and no "Consistent" badge', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) }));
    snap.data = { snapshot: { dataQuality: [basis] } };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><HealthModule /></QueryClientProvider>);
    expect(screen.queryByText('Consistent')).toBeNull();
    expect(screen.getByText('1 debt basis gap')).toBeTruthy();
    expect(screen.getAllByText('Alpha: gap $39,388').length).toBeGreaterThan(0); // Reconciliation + Data Quality cards
  });
});
