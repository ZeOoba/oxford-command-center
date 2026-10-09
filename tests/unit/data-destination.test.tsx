// IA decongestion Phase 4a — the Data destination: Imports · Quality · Mappings (extracted from
// Property Financials) · Calibration · Documents. Warehouse hooks and the child views are stubbed;
// each has its own suite.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

const q = {
  imports: { data: [{ status: 'committed' }, { status: 'pending-review' }] as unknown[], error: null as unknown, isLoading: false },
  issues: { data: [{}, {}, {}] as unknown[], error: null as unknown, isLoading: false },
  noi: { data: [{ propertyId: 'a', period: '2025' }, { propertyId: 'b', period: '2026-03' }] as unknown[], error: null as unknown, isLoading: false },
  live: true,
};
vi.mock('../../src/modules/intel/hooks', () => ({
  useWarehouseImports: () => q.imports,
  useWarehouseIssues: () => q.issues,
  useNoiMatrix: () => q.noi,
  isWarehouseUnavailable: (e: unknown) => e === 'unavailable',
  useWarehouseLive: () => q.live,
  useWarehouseFreshness: () => ({ detail: 'baked 2h ago' }),
}));
vi.mock('../../src/modules/intel/ImportsView', () => ({ ImportsView: () => <div>imports-panel</div> }));
vi.mock('../../src/modules/intel/DataQualityView', () => ({ DataQualityView: () => <div>quality-panel</div> }));
vi.mock('../../src/modules/intel/MappingsView', () => ({ MappingsView: () => <div>mappings-panel</div> }));
vi.mock('../../src/modules/calibration/CalibrationModule', () => ({ CalibrationModule: () => <div>calibration-panel</div> }));
vi.mock('../../src/modules/documents/DocumentsModule', () => ({ DocumentsModule: () => <div>documents-panel</div> }));
vi.mock('../../src/modules/property-financials/DataHealthPanel', () => ({ PfDataHealthPanel: () => <div>pf-health-panel</div> }));

import { DataModule } from '../../src/modules/data/DataModule';
import { tabIsSelected } from './tab-test-utils';

function Loc() {
  const l = useLocation();
  return <output data-testid="loc">{l.pathname + l.search}</output>;
}
const renderData = (entry = '/data') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <DataModule />
      <Loc />
    </MemoryRouter>,
  );

beforeEach(() => {
  q.imports.error = q.issues.error = q.noi.error = null;
  q.imports.isLoading = q.issues.isLoading = q.noi.isLoading = false;
  q.live = true;
});
afterEach(cleanup);

describe('Data destination', () => {
  it('shows the five tabs in order with Imports as the default', () => {
    renderData();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Imports', 'Quality', 'Mappings', 'Calibration', 'Documents']);
    expect(tabIsSelected('Imports')).toBe(true);
    expect(screen.getByText('imports-panel')).toBeTruthy();
    expect(screen.queryByText('quality-panel')).toBeNull();
  });

  it.each([
    ['imports', 'imports-panel'],
    ['quality', 'quality-panel'],
    ['mappings', 'mappings-panel'],
  ])('?tab=%s renders its warehouse panel', (id, panel) => {
    renderData(`/data?tab=${id}`);
    expect(screen.getByText(panel)).toBeTruthy();
  });

  it.each([
    ['calibration', 'calibration-panel'],
    ['documents', 'documents-panel'],
  ])('?tab=%s renders the absorbed module (lazy)', async (id, panel) => {
    renderData(`/data?tab=${id}`);
    expect(await screen.findByText(panel)).toBeTruthy();
  });

  it('an unknown ?tab= (or an old Intel tab id like "lease-run") falls back to Imports', () => {
    renderData('/data?tab=lease-run');
    expect(tabIsSelected('Imports')).toBe(true);
  });

  it('the data-ops KPI band sits above the strip on the warehouse tabs only (R2)', async () => {
    renderData('/data?tab=quality');
    expect(screen.getByText('Committed Imports')).toBeTruthy();
    expect(screen.getByText('Open DQ Issues')).toBeTruthy();
    expect(screen.getByText('Properties Covered')).toBeTruthy();
    expect(screen.getByText('pending review', { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Calibration' }));
    expect(await screen.findByText('calibration-panel')).toBeTruthy();
    expect(screen.queryByText('Committed Imports')).toBeNull();
  });

  it('switching tabs writes ?tab= (replace) and keeps ?scenario=/?still=', async () => {
    renderData('/data?scenario=Upside&still=1');
    fireEvent.click(screen.getByRole('tab', { name: 'Documents' }));
    expect(await screen.findByText('documents-panel')).toBeTruthy();
    const params = new URLSearchParams(screen.getByTestId('loc').textContent!.split('?')[1]);
    expect(params.get('tab')).toBe('documents');
    expect(params.get('scenario')).toBe('Upside');
    expect(params.get('still')).toBe('1');
  });

  it('on the static mirror the three warehouse tabs show an explaining offline card (R7) while Calibration/Documents stay reachable', async () => {
    q.noi.error = 'unavailable';
    renderData('/data?tab=mappings');
    expect(screen.getAllByRole('tab')).toHaveLength(5); // no tab hidden
    expect(screen.getByText(/requires the live brain server/)).toBeTruthy();
    expect(screen.queryByText('mappings-panel')).toBeNull();
    expect(screen.queryByText('Committed Imports')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Documents' }));
    expect(await screen.findByText('documents-panel')).toBeTruthy();
  });

  it('shows a skeleton, not the view, while warehouse queries load', () => {
    q.imports.isLoading = true;
    renderData('/data?tab=imports');
    expect(screen.queryByText('imports-panel')).toBeNull();
  });

  it('flags the not-live badge with the freshness detail', () => {
    q.live = false;
    renderData();
    expect(screen.getByText(/Computed from snapshot · baked 2h ago/)).toBeTruthy();
  });

  // Plan T8 (property financials): the strip is at MAX_TABS_PER_DESTINATION, so the PF data-health
  // panel is a ?view= of Quality (R5 SegmentedControl), not a sixth tab.
  describe('Quality › Property Financials view (plan T8)', () => {
    it('Quality defaults to the warehouse view and offers a Warehouse / Property Financials switch', () => {
      renderData('/data?tab=quality');
      expect(screen.getByText('quality-panel')).toBeTruthy();
      expect(screen.getByRole('radio', { name: 'Warehouse' })).toBeTruthy();
      expect(screen.getByRole('radio', { name: 'Property Financials' })).toBeTruthy();
      expect(screen.getAllByRole('tab')).toHaveLength(5);
    });

    it('?view=property-financials renders the data-health panel, not the warehouse view or its KPI band', async () => {
      renderData('/data?tab=quality&view=property-financials');
      expect(await screen.findByText('pf-health-panel')).toBeTruthy();
      expect(screen.queryByText('quality-panel')).toBeNull();
      expect(screen.queryByText('Committed Imports')).toBeNull();
    });

    it('selecting Property Financials writes ?view= and keeps ?tab=quality', async () => {
      renderData('/data?tab=quality');
      fireEvent.click(screen.getByRole('radio', { name: 'Property Financials' }));
      expect(await screen.findByText('pf-health-panel')).toBeTruthy();
      const params = new URLSearchParams(screen.getByTestId('loc').textContent!.split('?')[1]);
      expect(params.get('tab')).toBe('quality');
      expect(params.get('view')).toBe('property-financials');
    });

    it('the panel does not depend on the warehouse: it renders when the warehouse routes are offline', async () => {
      q.noi.error = 'unavailable';
      renderData('/data?tab=quality&view=property-financials');
      expect(await screen.findByText('pf-health-panel')).toBeTruthy();
      expect(screen.queryByText(/requires the live brain server/)).toBeNull();
    });

    it('leaving Quality clears ?view= (Rule H)', async () => {
      renderData('/data?tab=quality&view=property-financials');
      fireEvent.click(screen.getByRole('tab', { name: 'Imports' }));
      const search = screen.getByTestId('loc').textContent!.split('?')[1] ?? '';
      expect(new URLSearchParams(search).get('view')).toBeNull();
    });
  });
});
