// tests/unit/overview-landlord-cost-caveat.test.tsx
//
// Design review 2026-10-31 finding 6: the Overview NOI tile and the weighted cap rate under it gave no
// sign that NNN-not-absolute properties with $0 expenses carry landlord-paid roof, structure and
// paving costs that are not sourced (parse.ts flagLandlordCostsNotSourced, ruling 2026-10-30). The
// Portfolio NOI cell and the property page already label them; the headline tile did not. The DSCR
// governor tile has the same exposure: a flagged levered property's DSCR is overstated by the same
// unsourced costs. Both now say so without restating any value.
// Fixture style mirrors tests/unit/overview-governor-tiles.test.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PortfolioSnapshot, Property } from '../../src/contracts/index';
import { SNAPSHOT_KEY } from '../../src/data/queries';
import { OVERVIEW_WIDGETS } from '../../src/modules/overview/widgets';
import { landlordCostCaveat } from '../../src/modules/overview/landlord-cost-caveat';

const ASOF = '2026-11-05';

const llFlag = (entity: string) => ({
  entity,
  field: 'landlordCosts',
  issue: 'NNN, not absolute: landlord-paid roof, structure and paving costs are not sourced (expenses are $0 or blank), so NOI is overstated by them until a PCA schedule supplies them',
  severity: 'info' as const,
});

const base: Property = {
  id: 'p1', index: 1, name: 'Alpha Industrial', address: '1 Alpha Way', city: null, state: null, market: 'Columbus OH', type: 'Flex',
  sf: 40_000, tenantCount: 3, occPct: 1, acqDate: null, estValue100: 0, oxfordOwnPct: 1, oxfordValue: 5_000_000,
  grossIncome: 500_000, expenses: 100_000, noi: 400_000, noiScenarioAdj: 400_000, debtService: 200_000, netCashFlow: 0,
  capRate: 0.08, dscr: 2.0, lender: 'REDACTED-672', loanBalance: 1_500_000, ltv: 0.3, valuePerSf: null, rentPerSf: null,
  equityInvested: 0, cashOnCash: null, holdYrs: null, encumbered: true, flags: [],
} as Property;
/** Levered, NNN-not-absolute, $0 expenses → flagged. */
const bravo: Property = {
  ...base, id: 'p2', index: 2, name: 'Bravo Flex', expenses: 0, noi: 300_000, noiScenarioAdj: 300_000, debtService: 150_000, dscr: 2.0,
  flags: [llFlag('p2')],
} as Property;
/** Unlevered and flagged. */
const charlie: Property = {
  ...base, id: 'p3', index: 3, name: 'Charlie Works', expenses: 0, noi: 90_000, noiScenarioAdj: 90_000, debtService: 0, dscr: null,
  lender: null, loanBalance: 0, ltv: null, encumbered: false, flags: [llFlag('p3')],
} as Property;
/** A non-investment row carrying the flag must never count (the residence is excluded at parse; this is defense in depth). */
const residence: Property = { ...charlie, id: 'p4', index: 4, name: 'Some Residence', type: 'Residence', flags: [llFlag('p4')] } as Property;

function snapshot(properties: Property[]): PortfolioSnapshot {
  return {
    meta: { schemaVersion: '1.0.0', asOf: ASOF, generatedAt: `${ASOF}T00:00:00.000Z`, source: 'test', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: ASOF },
    properties,
    leases: [],
    loans: [],
    cash: { asOf: ASOF, totalCash: 2_000_000, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
    insurance: [], deals: [], tasks: [], counterparties: [],
    renewalStages: {}, tenantNotes: {}, dealComps: {}, acquisitionInputs: {}, noiBudgets: {}, tenantArrears: {}, arBalances: [],
    quickbooks: null, governors: null, marketRents: {}, workbookTotals: { noi: null, value: null, rent: null }, dataQuality: [],
  } as unknown as PortfolioSnapshot;
}

function renderStrip(s: PortfolioSnapshot) {
  const def = OVERVIEW_WIDGETS.find((w) => w.id === 'kpis');
  if (!def) throw new Error('widget not registered: kpis');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  qc.setQueryData(SNAPSHOT_KEY, { snapshot: s, state: { status: 'fresh', source: 'workbook', lastUpdated: ASOF, lastError: null, workbookPath: 'test.xlsx', flagCount: 0 } });
  const Component = def.Component;
  return render(
    <QueryClientProvider client={qc}>
      <Component />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('landlordCostCaveat (pure)', () => {
  it('is null when no property in the population carries the landlordCosts flag', () => {
    expect(landlordCostCaveat([base], { measure: 'this NOI' })).toBeNull();
    expect(landlordCostCaveat([], { measure: 'this NOI' })).toBeNull();
  });

  it('counts flagged investment properties out of the investment population, never a non-investment row', () => {
    const c = landlordCostCaveat([base, bravo, charlie, residence], { measure: 'this NOI and the weighted cap rate', plural: true });
    expect(c).not.toBeNull();
    expect(c!.flagged.map((p) => p.id)).toEqual(['p2', 'p3']);
    expect(c!.of).toBe(3);
    expect(c!.text).toBe('LL costs not sourced · 2 of 3');
  });

  it('explains what is overstated, says nothing is restated, and names the properties', () => {
    const c = landlordCostCaveat([base, bravo, charlie], { measure: 'this NOI and the weighted cap rate', plural: true })!;
    expect(c.title).toMatch(/^2 of 3 properties are NNN but not absolute/);
    expect(c.title).toMatch(/landlord-paid roof, structure and paving costs are not sourced/);
    expect(c.title).toMatch(/this NOI and the weighted cap rate are overstated by them/);
    expect(c.title).toMatch(/Values are not restated/);
    expect(c.title).toMatch(/Bravo Flex, Charlie Works/);
  });

  it('uses the singular verb for one flagged property', () => {
    const c = landlordCostCaveat([base, bravo], { measure: 'this DSCR' })!;
    expect(c.title).toMatch(/^1 of 2 properties is NNN but not absolute/);
    expect(c.title).toMatch(/this DSCR is overstated by them/);
  });
});

describe('Overview KPI strip — landlord-cost caveat', () => {
  it('labels the NOI tile when investment properties carry unsourced landlord costs', () => {
    renderStrip(snapshot([base, bravo, charlie]));
    // Scoped to the NOI tile itself, not just anywhere in the strip.
    const noiTile = screen.getByText('Net Operating Income').closest('div.min-w-0');
    expect(noiTile).not.toBeNull();
    const badge = within(noiTile as HTMLElement).getByText('LL costs not sourced · 2 of 3');
    expect(badge.closest('[title]')?.getAttribute('title')).toMatch(/this NOI and the weighted cap rate are overstated/);
    // The explanation also reaches screen readers, not only the hover title.
    expect(noiTile!.querySelector('.sr-only')?.textContent).toMatch(/landlord-paid roof, structure and paving costs are not sourced/);
  });

  it('adds no caveat when nothing is flagged', () => {
    renderStrip(snapshot([base]));
    expect(screen.queryByText(/LL costs not sourced/)).toBeNull();
  });

  it('flags the DSCR tile with the levered properties only, out of the levered count', () => {
    // Levered: Alpha (clean) + Bravo (flagged). Charlie is flagged but unlevered: it carries no DSCR.
    renderStrip(snapshot([base, bravo, charlie]));
    const dscr = screen.getByRole('group', { name: 'DSCR vs governor' });
    const line = within(dscr).getByText('LL costs not sourced on 1 of 2 levered');
    // The caveat's denominator is the same levered set the tile's basis line counts (dscrHeadroom).
    expect(within(dscr).getByText(/^2 levered properties · /)).toBeTruthy();
    expect(line.getAttribute('title')).toMatch(/1 of 2 properties is NNN but not absolute.*this DSCR is overstated by them.*Bravo Flex/);
  });

  it('leaves the DSCR tile unlabelled when no levered property is flagged', () => {
    renderStrip(snapshot([base, charlie]));
    const dscr = screen.getByRole('group', { name: 'DSCR vs governor' });
    expect(within(dscr).queryByText(/LL costs not sourced/)).toBeNull();
  });
});
