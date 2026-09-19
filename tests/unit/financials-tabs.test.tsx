// IA decongestion Phase 4a — Financials (module id `intel`): tabs drop 8 -> 5. The Imports / Quality
// / Mappings data-ops tabs live ONLY in the Data destination now (R8); the /intel/:propertyId deep
// link and its defaultInitialTabRef behavior are unchanged.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const ui = { intelPropertyId: null as string | null, openIntelProperty: vi.fn() };
vi.mock('../../src/brain/ui-context', () => ({ useUi: () => ui }));
const noi = { data: [] as unknown[], error: null as unknown, isLoading: false };
vi.mock('../../src/modules/intel/hooks', () => ({
  useNoiMatrix: () => noi,
  isWarehouseUnavailable: (e: unknown) => e === 'unavailable',
  useWarehouseLive: () => true,
  useWarehouseFreshness: () => ({ detail: null }),
}));
vi.mock('../../src/modules/intel/analytics-hooks', () => ({ useMetrics: () => ({ data: [] }) }));
vi.mock('../../src/modules/intel/OwnershipView', () => ({ OwnershipView: () => <div>ownership-panel</div> }));
vi.mock('../../src/modules/intel/PropertyIntelView', () => ({ PropertyIntelView: ({ propertyId }: { propertyId: string | null }) => <div>property-panel:{propertyId ?? 'none'}</div> }));
vi.mock('../../src/modules/intel/LeaseRunView', () => ({ LeaseRunView: () => <div>lease-run-panel</div> }));
vi.mock('../../src/modules/intel/BenchmarksView', () => ({ BenchmarksView: () => <div>benchmarks-panel</div> }));
vi.mock('../../src/modules/intel/ManagersView', () => ({ ManagersView: () => <div>managers-panel</div> }));

import { IntelModule } from '../../src/modules/intel/IntelModule';
import { tabIsSelected } from './tab-test-utils';

const renderIntel = (entry = '/intel') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <IntelModule />
    </MemoryRouter>,
  );

beforeEach(() => {
  ui.intelPropertyId = null;
  noi.error = null;
  noi.isLoading = false;
});
afterEach(cleanup);

describe('Financials (intel) — five intelligence tabs', () => {
  it('shows exactly Ownership · Property · Lease Run · Benchmarks · Managers, Ownership default', () => {
    renderIntel();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Ownership', 'Property', 'Lease Run', 'Benchmarks', 'Managers']);
    expect(tabIsSelected('Ownership')).toBe(true);
    expect(screen.getByText('ownership-panel')).toBeTruthy();
  });

  it.each([
    ['property', 'property-panel:none'],
    ['lease-run', 'lease-run-panel'],
    ['benchmarks', 'benchmarks-panel'],
    ['managers', 'managers-panel'],
  ])('?tab=%s renders', (id, panel) => {
    renderIntel(`/intel?tab=${id}`);
    expect(screen.getByText(panel)).toBeTruthy();
  });

  it('the departed data-ops tab ids fall back to Ownership here (the router alias sends them to Data)', () => {
    for (const gone of ['imports', 'quality', 'mappings']) {
      renderIntel(`/intel?tab=${gone}`);
      expect(tabIsSelected('Ownership')).toBe(true);
      cleanup();
    }
  });

  it('preserves the /intel/:propertyId deep link: lands on Property with the id, no flash of Ownership', () => {
    ui.intelPropertyId = '9050-red-branch';
    renderIntel('/intel/9050-red-branch');
    expect(tabIsSelected('Property')).toBe(true);
    expect(screen.getByText('property-panel:9050-red-branch')).toBeTruthy();
  });

  it('no data-ops KPI band and no data-ops panels leak into Financials', () => {
    renderIntel();
    expect(screen.queryByText('Committed Imports')).toBeNull();
    expect(screen.queryByText('Open DQ Issues')).toBeNull();
  });

  it('degrades to the offline card on the static mirror', () => {
    noi.error = 'unavailable';
    renderIntel();
    expect(screen.getByText(/require the live brain server/)).toBeTruthy();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });
});
