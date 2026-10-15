// ImportsView: the approve gate for sign-undecidable imports needs a reviewer control, or it would be a dead
// end in the UI. An OPEN sign-undecidable issue on a PENDING import gets "Mark sign verified" (calls the
// resolve mutation); a resolved one shows a "sign verified" badge; other issue kinds never get the button.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import type { ImportDetail, ImportSummary } from '../../src/modules/intel/hooks';

const resolveMutate = vi.fn();
const actionMutate = vi.fn();
const detail: { data: ImportDetail | undefined } = { data: undefined };

vi.mock('../../src/modules/intel/hooks', () => ({
  useImportDetail: () => ({ isLoading: false, data: detail.data }),
  useImportAction: () => ({ mutate: actionMutate, isPending: false }),
  useAddMapping: () => ({ mutate: vi.fn(), isPending: false }),
  useResolveIssue: () => ({ mutate: resolveMutate, isPending: false }),
}));

import { ImportsView } from '../../src/modules/intel/ImportsView';

afterEach(() => {
  cleanup();
  resolveMutate.mockReset();
  actionMutate.mockReset();
});

const summary: ImportSummary = {
  id: 7, fileName: 'P&L 2025 -- 1100 Rarig.xlsx', propertyId: 'p1', propertyName: 'Rarig', period: '2025',
  periodStart: '2025-01-01', periodEnd: '2025-12-31', grain: 'annual', basis: 'cash', sourceSystem: 'qb',
  version: 1, status: 'pending-review', confidence: 0.9, importedAt: '2026-10-15T00:00:00Z',
};
const issue = (id: number, kind: string, status: string) => ({
  id, kind, detail: `${kind} detail`, severity: 'warn', status, createdAt: '2026-10-15T00:00:00Z', resolvedAt: null,
});
function open(status: string, issues: ReturnType<typeof issue>[]) {
  detail.data = { ...summary, status, rows: [], issues } as ImportDetail;
  render(<ImportsView imports={[{ ...summary, status }]} />);
  fireEvent.click(screen.getByText(summary.fileName));
}

describe('ImportsView — sign-undecidable verification control', () => {
  it('open sign-undecidable issue on a pending import shows "Mark sign verified", which resolves that issue', () => {
    open('pending-review', [issue(41, 'sign-undecidable', 'open'), issue(42, 'unmapped-account', 'open')]);
    const btn = screen.getByRole('button', { name: 'Mark sign verified' });
    fireEvent.click(btn);
    expect(resolveMutate).toHaveBeenCalledTimes(1);
    expect(resolveMutate).toHaveBeenCalledWith(41, expect.anything());
    // only the sign-undecidable issue gets the control
    expect(screen.getAllByRole('button', { name: 'Mark sign verified' })).toHaveLength(1);
  });

  it('a resolved sign-undecidable issue shows a "sign verified" badge and no button', () => {
    open('pending-review', [issue(41, 'sign-undecidable', 'resolved')]);
    expect(screen.getByText('sign verified')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mark sign verified' })).toBeNull();
  });

  it('no control once the import is no longer pending-review', () => {
    open('committed', [issue(41, 'sign-undecidable', 'open')]);
    expect(screen.queryByRole('button', { name: 'Mark sign verified' })).toBeNull();
  });

  const REFUSAL = 'sign convention undecidable for 1 statement side(s): no sign flip was applied';

  it('verifying the sign clears the stale approve refusal text', () => {
    actionMutate.mockImplementation((_v, opts) => opts.onSuccess({ ok: false, unmapped: [], reason: 'sign-undecidable', error: REFUSAL }));
    resolveMutate.mockImplementation((_id, opts) => opts?.onSuccess?.({ ok: true }));
    open('pending-review', [issue(41, 'sign-undecidable', 'open')]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.getByText(REFUSAL)).toBeTruthy(); // refusal shown
    fireEvent.click(screen.getByRole('button', { name: 'Mark sign verified' }));
    expect(screen.queryByText(REFUSAL)).toBeNull(); // stale red text gone once the reviewer acknowledges
  });

  it('a failed verify is surfaced, not silent', () => {
    resolveMutate.mockImplementation((_id, opts) => opts?.onSuccess?.({ ok: false, error: 'issue is resolved, not open' }));
    open('pending-review', [issue(41, 'sign-undecidable', 'open')]);
    fireEvent.click(screen.getByRole('button', { name: 'Mark sign verified' }));
    expect(screen.getByText('issue is resolved, not open')).toBeTruthy();
  });

  it('a thrown verify error is surfaced too', () => {
    resolveMutate.mockImplementation((_id, opts) => opts?.onError?.(new Error('brain server offline')));
    open('pending-review', [issue(41, 'sign-undecidable', 'open')]);
    fireEvent.click(screen.getByRole('button', { name: 'Mark sign verified' }));
    expect(screen.getByText('brain server offline')).toBeTruthy();
  });
});
