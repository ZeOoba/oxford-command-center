// DataQualityView lists open issues across ALL imports with a one-click resolve. For a sign-undecidable issue that
// click is the reviewer's acknowledgement that unlocks Approve, so it must not read as a generic "Resolve"
// (refute wf_eb0ab66c-cf5): it is labelled as a sign verification and tells the reviewer to check the ledger first.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import type { ImportSummary, WarehouseIssue } from '../../src/modules/intel/hooks';

vi.mock('../../src/modules/intel/hooks', () => ({
  useResolveIssue: () => ({ mutate: vi.fn(), isPending: false }),
  useWarehouseLive: () => true,
}));

import { DataQualityView } from '../../src/modules/intel/DataQualityView';

afterEach(cleanup);

const issue = (id: number, kind: string): WarehouseIssue => ({
  id, kind, detail: `${kind} detail`, severity: 'warn', status: 'open', createdAt: '2026-10-15T00:00:00Z', resolvedAt: null,
  importId: 7, fileName: 'f.xlsx', propertyId: 'p1', propertyName: 'Rarig',
});

describe('DataQualityView — sign-undecidable resolve control', () => {
  it('labels the control for a sign-undecidable issue as a sign verification; other kinds keep "Resolve"', () => {
    render(<DataQualityView issues={[issue(1, 'sign-undecidable'), issue(2, 'foot-mismatch')]} />);
    expect(screen.getByRole('button', { name: /Mark sign verified/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resolve issue 2' })).toBeTruthy();
    // the sign one is NOT the generic Resolve control
    expect(screen.queryByRole('button', { name: 'Resolve issue 1' })).toBeNull();
  });
});

// approveImport refuses some pending imports before its sign gate (newer-version-committed, property-unresolved,
// property-mismatch), so verifying the sign cannot unlock Approve there. With the imports list the Data module already
// holds, the view mirrors those gates and stops offering the verify (refute wf_2e74b57b-da3, UI parity with ImportsView).
describe('DataQualityView — sign verify is not offered where Approve refuses whatever the sign', () => {
  const imp = (over: Partial<ImportSummary> = {}): ImportSummary => ({
    id: 7, fileName: 'f.xlsx', propertyId: 'p1', propertyName: 'Rarig', period: '2025', periodStart: '2025-01-01',
    periodEnd: '2025-12-31', grain: 'annual', basis: 'cash', sourceSystem: 'qb', version: 1, status: 'pending-review',
    confidence: 0.9, importedAt: '2026-10-15T00:00:00Z', ...over,
  });
  const signButton = () => screen.getByRole('button', { name: /Mark sign verified/ });
  const disabled = (el: HTMLElement) => el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';

  it('the batch property is unresolved (the same predicate as ImportsView)', () => {
    for (const unresolved of [null, '  ', 'unknown']) {
      render(<DataQualityView issues={[issue(1, 'sign-undecidable')]} imports={[imp({ propertyId: unresolved })]} />);
      expect(disabled(signButton())).toBe(true);
      expect(screen.getByText(/property is unresolved/i)).toBeTruthy();
      cleanup();
    }
  });

  it('a newer committed version of the same property and period exists', () => {
    render(<DataQualityView issues={[issue(1, 'sign-undecidable')]} imports={[imp(), imp({ id: 9, status: 'committed', version: 2 })]} />);
    expect(disabled(signButton())).toBe(true);
    expect(screen.getByText(/newer version of this period is already committed/i)).toBeTruthy();
  });

  it("the sign issue's ledger key differs from the batch property (property-mismatch)", () => {
    // ingest writes a sign-undecidable issue and the ledger rows from the same detection, so the issue's property is
    // the ledger's key (NULL means 'unknown').
    for (const ledgerKey of ['p2', null]) {
      const i = { ...issue(1, 'sign-undecidable'), propertyId: ledgerKey };
      render(<DataQualityView issues={[i]} imports={[imp({ propertyId: 'p1' })]} />);
      expect(disabled(signButton())).toBe(true);
      expect(screen.getByText(/keyed to a different property/i)).toBeTruthy();
      cleanup();
    }
  });

  it('control: resolved, matching and no newer version, so the verify stays enabled', () => {
    render(<DataQualityView issues={[issue(1, 'sign-undecidable')]} imports={[imp(), imp({ id: 3, status: 'committed', version: 0 })]} />);
    expect(disabled(signButton())).toBe(false);
  });
});
