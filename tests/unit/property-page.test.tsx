// tests/unit/property-page.test.tsx
//
// Roadmap 2.2: /property/:id renders the two basis-labelled NOI tiles (ruling 2026-10-30), the
// NNN landlord-costs flag, the rollover ladder, and refuses the residence.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Lease, Property } from '../../src/contracts/index';

const property = (over: Partial<Property>): Property => ({
  id: 'p1',
  index: 1,
  name: '9050 Red Branch Rd, Columbia MD',
  address: '9050 Red Branch Rd',
  city: null,
  state: null,
  market: 'Mid-Atlantic',
  type: 'Flex',
  sf: 90000,
  tenantCount: 2,
  occPct: 0.94,
  acqDate: null,
  estValue100: 1,
  oxfordOwnPct: 0.5,
  oxfordValue: 1,
  grossIncome: 546943,
  expenses: 0,
  noi: 546943,
  noiScenarioAdj: 0,
  debtService: 0,
  netCashFlow: 0,
  capRate: null,
  dscr: 3.74,
  lender: null,
  loanBalance: 0,
  ltv: 0.154,
  valuePerSf: null,
  rentPerSf: 6.08,
  equityInvested: 0,
  cashOnCash: null,
  holdYrs: null,
  encumbered: false,
  flags: [{ entity: 'p1', field: 'landlordCosts', issue: 'NNN, not absolute', severity: 'info' }],
  ...over,
});

const lease: Lease = {
  id: 'L1',
  propertyKey: '9050 Red Branch',
  propertyId: 'p1',
  tenantName: 'Example Imaging',
  unit: 'O',
  company: null,
  sf: 5000,
  monthlyRent: 5625,
  rentPerSf: 13.5,
  leaseStart: null,
  leaseEnd: '2027-02-28',
  escalationDate: null,
  escalationPct: null,
  status: 'Active',
  annualRent: 67500,
  monthsToExpiry: 4,
  flags: [],
};

const snapshot = {
  meta: { asOf: '2026-10-30' },
  properties: [property({}), property({ id: 'res', name: '9510 Persimmon Tree Rd', type: 'Residence', flags: [] })],
  leases: [lease],
};

vi.mock('../../src/data/queries', () => ({ useSnapshot: () => ({ data: { snapshot } }) }));
vi.mock('../../src/shell/SnapshotGate', () => ({ useSnapshotGate: () => null }));
vi.mock('../../src/data/alerts', () => ({ useAlertView: () => ({ items: [] }) }));
vi.mock('../../src/brain/ui-context', () => ({ useUi: () => ({ openEntity: vi.fn() }) }));
vi.mock('../../src/modules/leasing/hooks', () => ({ useLeaseForecast: () => ({ data: undefined }) }));
vi.mock('../../src/modules/property/hooks', () => ({
  usePropertyLedger: () => ({
    entity: '9050 Red Branch',
    months: [],
    t12: [
      { month: '2026-08', value: 900_000 },
      { month: '2026-09', value: 912_000 },
    ],
    sf: 90000,
  }),
  usePropertyOccupancy: () => null,
}));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeEach(() => vi.stubGlobal('ResizeObserver', NoopResizeObserver));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderAt(path: string) {
  const { PropertyPage } = await import('../../src/modules/property/PropertyPage');
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path=":moduleId/*" element={<PropertyPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PropertyPage', () => {
  it('shows workbook (Oxford share) and ledger (entity 100%) NOI as separate tiles', async () => {
    await renderAt('/property/p1');
    expect(screen.getByText('NOI · workbook, Oxford 50%')).toBeTruthy();
    expect(screen.getByText('NOI · ledger T12')).toBeTruthy();
    expect(screen.getByText('entity 100% · T12 to 2026-09')).toBeTruthy();
  });

  it('flags NNN landlord costs not sourced on the workbook NOI', async () => {
    await renderAt('/property/p1');
    expect(screen.getByText('NNN · LL costs not sourced')).toBeTruthy();
  });

  it('lists the lease in the rollover ladder with an unsourced market rent', async () => {
    await renderAt('/property/p1');
    expect(screen.getByText('Example Imaging')).toBeTruthy();
    expect(screen.getByText('0–12 months')).toBeTruthy();
    expect(screen.getByText('not yet sourced')).toBeTruthy();
  });

  it('never renders the residence', async () => {
    await renderAt('/property/res');
    expect(screen.getByText('Property not found')).toBeTruthy();
    expect(screen.queryByText('9510 Persimmon Tree Rd')).toBeNull();
  });
});
