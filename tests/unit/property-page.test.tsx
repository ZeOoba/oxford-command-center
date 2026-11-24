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
  name: 'Example Flex Park, Anytown MD',
  address: '100 Example Pkwy',
  city: null,
  state: null,
  market: 'Mid-Atlantic',
  type: 'Flex',
  sf: 72000,
  tenantCount: 2,
  occPct: 0.88,
  acqDate: null,
  estValue100: 1,
  oxfordOwnPct: 0.5,
  oxfordValue: 1,
  grossIncome: 431250,
  expenses: 0,
  noi: 431250,
  noiScenarioAdj: 0,
  debtService: 0,
  netCashFlow: 0,
  capRate: null,
  dscr: 2.41,
  lender: null,
  loanBalance: 0,
  ltv: 0.237,
  valuePerSf: null,
  rentPerSf: 5.99,
  equityInvested: 0,
  cashOnCash: null,
  holdYrs: null,
  encumbered: false,
  flags: [{ entity: 'p1', field: 'landlordCosts', issue: 'NNN, not absolute', severity: 'info' }],
  ...over,
});

const lease: Lease = {
  id: 'L1',
  propertyKey: 'Example Flex Park',
  propertyId: 'p1',
  tenantName: 'Tenant 214 LLC',
  unit: 'K',
  company: null,
  sf: 3600,
  monthlyRent: 3450,
  rentPerSf: 11.5,
  leaseStart: null,
  leaseEnd: '2027-04-30',
  escalationDate: null,
  escalationPct: null,
  status: 'Active',
  annualRent: 41400,
  monthsToExpiry: 6,
  flags: [],
};

const snapshot = {
  meta: { asOf: '2026-10-30' },
  properties: [
    property({}),
    property({ id: 'res', name: '9510 Persimmon Tree Rd', type: 'Residence', flags: [] }),
    property({ id: 'p2', name: 'Example Blank Bldg', noi: 0, lender: 'Example Bank', debtService: 50_000, flags: [{ entity: 'p2', field: 'governorInputBlank', issue: 'blank', rawValue: 'noi', severity: 'warn' }] }),
  ],
  leases: [lease],
};

vi.mock('../../src/data/queries', () => ({ useSnapshot: () => ({ data: { snapshot } }) }));
vi.mock('../../src/shell/SnapshotGate', () => ({ useSnapshotGate: () => null }));
vi.mock('../../src/data/alerts', () => ({ useAlertView: () => ({ items: [] }) }));
vi.mock('../../src/brain/ui-context', () => ({ useUi: () => ({ openEntity: vi.fn() }) }));
vi.mock('../../src/modules/leasing/hooks', () => ({ useLeaseForecast: () => ({ data: undefined }) }));
const READY_LEDGER = {
  entity: 'Example Flex Park',
  months: [],
  t12: [
    { month: '2026-08', value: 780_000 },
    { month: '2026-09', value: 795_000 },
  ],
  sf: 72000,
};
let ledgerState: { status: string; ledger: unknown; error?: unknown } = { status: 'ready', ledger: READY_LEDGER };
vi.mock('../../src/modules/property/hooks', () => ({
  usePropertyLedgerState: () => ledgerState,
  usePropertyOccupancy: () => null,
}));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeEach(() => vi.stubGlobal('ResizeObserver', NoopResizeObserver));
afterEach(() => {
  ledgerState = { status: 'ready', ledger: READY_LEDGER };
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
  // Review round 2 (2026-11-24): loading and failure used to read as "not in the P&L ledger".
  it('says the ledger is loading, never "not in the P&L ledger", while it loads', async () => {
    ledgerState = { status: 'loading', ledger: null };
    await renderAt('/property/p1');
    expect(screen.getByText('loading the P&L ledger…')).toBeTruthy();
    expect(screen.queryByText('not in the P&L ledger')).toBeNull();
    expect(screen.queryByText(/not in the P&L ledger set yet/)).toBeNull();
  });

  it('says the ledger did not load when it failed, with the reason under Details', async () => {
    ledgerState = { status: 'error', ledger: null, error: new Error('HTTP 500: dataset parse') };
    await renderAt('/property/p1');
    expect(screen.getByText('P&L ledger did not load')).toBeTruthy();
    expect(screen.getByText("Couldn't load the P&L ledger.")).toBeTruthy();
    expect(screen.queryByText(/not in the P&L ledger set yet/)).toBeNull();
  });

  it('still says "not in the P&L ledger" once loaded with no entity for the property', async () => {
    ledgerState = { status: 'ready', ledger: null };
    await renderAt('/property/p1');
    expect(screen.getByText('not in the P&L ledger')).toBeTruthy();
  });

  it('shows workbook (Oxford share) and ledger (entity 100%) NOI as separate tiles', async () => {
    await renderAt('/property/p1');
    expect(screen.getByText('NOI · workbook, Oxford 50%')).toBeTruthy();
    expect(screen.getByText('NOI · ledger T12')).toBeTruthy();
    expect(screen.getByText('entity 100% · T12 to 2026-09')).toBeTruthy();
  });

  it('shows a blank workbook NOI as blank, never $0 (audit 2026-11-12 HIGH #2)', async () => {
    await renderAt('/property/p2');
    expect(screen.getByText(/blank in workbook/)).toBeTruthy();
    expect(screen.queryByText('$0')).toBeNull();
  });

  it('flags NNN landlord costs not sourced on the workbook NOI', async () => {
    await renderAt('/property/p1');
    expect(screen.getByText('NNN · LL costs not sourced')).toBeTruthy();
  });

  it('lists the lease in the rollover ladder with an unsourced market rent', async () => {
    await renderAt('/property/p1');
    expect(screen.getByText('Tenant 214 LLC')).toBeTruthy();
    expect(screen.getByText('0–12 months')).toBeTruthy();
    expect(screen.getByText('not yet sourced')).toBeTruthy();
  });

  it('never renders the residence', async () => {
    await renderAt('/property/res');
    expect(screen.getByText('Property not found')).toBeTruthy();
    expect(screen.queryByText('9510 Persimmon Tree Rd')).toBeNull();
  });
});
