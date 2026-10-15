// DataQualityView lists open issues across ALL imports with a one-click resolve. For a sign-undecidable issue that
// click is the reviewer's acknowledgement that unlocks Approve, so it must not read as a generic "Resolve"
// (refute wf_eb0ab66c-cf5): it is labelled as a sign verification and tells the reviewer to check the ledger first.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import type { WarehouseIssue } from '../../src/modules/intel/hooks';

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
