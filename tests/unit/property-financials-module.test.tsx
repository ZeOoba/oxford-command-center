// tests/unit/property-financials-module.test.tsx — T5 of
// docs/superpowers/plans/2026-10-05-property-financials-module.md. Render smoke tests of the Property
// Financials destination against the REAL committed dataset: masthead read from dataset meta, the
// six-view strip on ?view=, Overview KPIs equal to the calc-lib outputs (golden +2.6% / +6.6%), the
// computed lede, chart crosshair + tooltips, the insight workflow (dismiss requires a reason; PUT
// carries X-ORA-Client), Scorecard n/m reasons, sorting, row detail and the Explorer hand-off.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { pct, usd } from '@analytics/property-financials/format';
import { PropertyFinancialsModule } from '../../src/modules/property-financials/PropertyFinancialsModule';
import { PF_KEYS } from '../../src/modules/property-financials/hooks';
import { overviewKpis, overviewLede, whereTheMoneyIs } from '../../src/modules/property-financials/model';
import type { PfDatasetResponse, PfInsightStatusResponse } from '../../src/modules/property-financials/types';
import { loadDataset } from './property-financials-helpers';

const D = loadDataset();

function response(over: Partial<PfDatasetResponse> = {}): PfDatasetResponse {
  return {
    availability: 'ok',
    readError: null,
    lastGoodLoadedAt: '2026-10-05T12:00:00.000Z',
    issues: [],
    meta: { version: D.meta.version, generated: D.meta.generated, as_of: D.meta.as_of, basis: 'cash', sha256: 'x', csvSha256: 'y', csvError: null, ageDays: 5, staleness: 'fresh' },
    dataset: D,
    ...over,
  };
}

let lastSearch = '';
function LocationProbe() {
  lastSearch = useLocation().search;
  return null;
}

function renderModule(search = '', opts: { data?: PfDatasetResponse | null; statuses?: PfInsightStatusResponse } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  if (opts.data !== null) qc.setQueryData(PF_KEYS.dataset, opts.data ?? response());
  qc.setQueryData(PF_KEYS.insightStatus, opts.statuses ?? { records: [], orphanedIds: [] });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/property-financials${search}`]}>
        <PropertyFinancialsModule />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const fetchMock = vi.fn();
beforeEach(() => {
  lastSearch = '';
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'warehouse unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('masthead + view strip', () => {
  it('reads as-of, exclusions and prepared date from dataset meta; labels the NOI basis', () => {
    renderModule();
    expect(screen.getByRole('heading', { level: 1, name: 'Property Financials' })).toBeTruthy();
    const meta = screen.getByTestId('pf-meta');
    expect(within(meta).getByText('Cash basis · data through 30 Sep 2026')).toBeTruthy();
    expect(within(meta).getByText('2203-2207 Northwood excluded (pending)')).toBeTruthy();
    expect(within(meta).getByText('Prepared 5 Oct 2026')).toBeTruthy();
    expect(within(meta).getByText(/Normalized NOI/)).toBeTruthy();
    expect(within(meta).queryByText(/STALE/)).toBeNull();
  });

  it('a stale dataset says so in the masthead', () => {
    renderModule('', { data: response({ meta: { ...response().meta!, ageDays: 12, staleness: 'stale' } }) });
    expect(screen.getByText(/STALE · 12 days since 30 Sep 2026/)).toBeTruthy();
  });

  it('six views in a role=tablist; ?view= selects; arrow keys move the selection into the URL', () => {
    renderModule();
    const list = screen.getByRole('tablist', { name: 'Property Financials views' });
    const tabs = within(list).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Overview', 'Property explorer', 'Scorecard table', 'Rent & NOI levers', 'Expense watchlist', 'Evaluation scorecard']);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
    expect(within(list).getByRole('tab', { name: 'Property explorer' }).getAttribute('aria-selected')).toBe('true');
    expect(new URLSearchParams(lastSearch).get('view')).toBe('explorer');
  });

  it('every view is built: the explorer renders the property explorer, no not-built placeholder (T7)', () => {
    renderModule('?view=explorer');
    expect(screen.getByRole('heading', { name: 'Property explorer' })).toBeTruthy();
    expect(screen.queryByText(/not built yet/)).toBeNull();
  });

  it('no dataset → empty state with the loader issues, no tab strip', () => {
    renderModule('', { data: response({ availability: 'invalid', dataset: null, issues: ['properties.FVC: invalid_type'] }) });
    expect(screen.getByRole('heading', { name: 'No property financials dataset' })).toBeTruthy();
    expect(screen.getByText('properties.FVC: invalid_type')).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
  });
});

describe('Overview (real dataset)', () => {
  const k = overviewKpis(D);

  it('lede is the computed sentence', () => {
    renderModule();
    expect(screen.getByTestId('pf-lede').textContent).toBe(overviewLede(D));
  });

  it('KPI tiles equal the calc-lib outputs: base rent +2.6%, opex excl. RE tax +6.6%', () => {
    renderModule();
    const kpis = screen.getByTestId('pf-kpis');
    expect(within(kpis).getByText(usd(k.baseRent.current))).toBeTruthy();
    expect(within(kpis).getByText('+2.6%')).toBeTruthy();
    expect(pct(k.baseRent.change.value)).toBe('+2.6%');
    expect(within(kpis).getByText(usd(k.opexExTax.current))).toBeTruthy();
    expect(within(kpis).getByText('+6.6%')).toBeTruthy();
    expect(within(kpis).getByText(usd(k.noiFy.current))).toBeTruthy();
    expect(within(kpis).getByText(pct(k.noiFy.change.value))).toBeTruthy();
    expect(within(kpis).getByText(String(k.high.count))).toBeTruthy();
    expect(within(kpis).getByText(new RegExp(`${usd(k.high.grossSwing, 'k').replace('$', '\\$')} gross annual swing`))).toBeTruthy();
  });

  it('both charts render with a legend, a keyboard crosshair tooltip and a data table', () => {
    renderModule();
    expect(screen.getByRole('img', { name: /same-store base rent and operating cost/i })).toBeTruthy();
    const group = screen.getByRole('group', { name: /same-store base rent/i });
    fireEvent.focus(group);
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    const tip = within(group).getByRole('status');
    expect(tip.textContent).toMatch(/^Aug 2026Base rent \$[\d,]+\/mo/);
    expect(screen.getByTestId('pf-crosshair')).toBeTruthy();
    expect(screen.getAllByText('Data table').length).toBeGreaterThanOrEqual(2);
    // diverging bars: every bar is a focusable mark with a tooltip; both directions in the legend
    expect(screen.getByText('Cost up')).toBeTruthy();
    expect(screen.getByText('Cost down')).toBeTruthy();
    const util = screen.getByRole('img', { name: /^Utilities: \+/ });
    fireEvent.focus(util);
    expect(screen.getAllByRole('status').some((s) => s.textContent?.startsWith('Utilities'))).toBe(true);
    expect(screen.getByTestId('pf-tax-note').textContent).toMatch(/cash basis/);
  });

  it('"Where the money is" lists High items by |impact| with icon+label severity pills', () => {
    const { container } = renderModule();
    const rows = [...container.querySelectorAll('[data-insight]')].map((e) => e.getAttribute('data-insight'));
    expect(rows).toEqual(whereTheMoneyIs(D.insights).map((i) => i.id));
    const first = container.querySelector('[data-insight]') as HTMLElement;
    const pill = within(first).getByText('High');
    expect(pill.className).toContain('pf-pill High');
    expect(pill.getAttribute('data-icon')).toBe('filled circle');
  });

  it('dismissing requires a reason; a valid save PUTs with X-ORA-Client', async () => {
    const id = whereTheMoneyIs(D.insights)[0]!.id;
    // A tiny stand-in for the status store: PUT stores, GET returns what was stored.
    const stored: unknown[] = [];
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const rec = { insightId: id, ...body, updatedAt: '2026-10-05T12:00:00.000Z' };
        stored.push(rec);
        return new Response(JSON.stringify(rec), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ records: stored, orphanedIds: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const { container } = renderModule();
    const row = container.querySelector(`[data-insight="${id}"]`) as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Update status' }));
    const form = within(row).getByRole('form', { name: `Workflow for ${id}` });
    fireEvent.change(within(form).getByLabelText('Owner'), { target: { value: 'Gabriel' } });
    fireEvent.change(within(form).getByLabelText('Status'), { target: { value: 'dismissed' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(within(form).getByText('A reason is required to dismiss an item.')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toBe(false);

    fireEvent.change(within(form).getByLabelText(/Reason for dismissing/), { target: { value: 'covered by the solar O&M review' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toBe(true));
    const [url, init] = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'PUT')! as [string, RequestInit];
    expect(url).toBe(`/api/warehouse/property-financials/insight-status/${id}`);
    expect((init.headers as Record<string, string>)['X-ORA-Client']).toBe('1');
    expect(JSON.parse(String(init.body))).toEqual({ owner: 'Gabriel', dueDate: null, status: 'dismissed', dismissReason: 'covered by the solar O&M review' });
    await waitFor(() => expect(within(row).getByText('Dismissed')).toBeTruthy());
  });

  it('"View property" hands off to the Explorer with ?view=explorer&p=<entity>', () => {
    const fvc = whereTheMoneyIs(D.insights).find((i) => i.property === 'FVC')!;
    const { container } = renderModule();
    const row = container.querySelector(`[data-insight="${fvc.id}"]`) as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'View property' }));
    const q = new URLSearchParams(lastSearch);
    expect(q.get('view')).toBe('explorer');
    expect(q.get('p')).toBe('FVC');
    const fvcCard = screen.getByTestId('pf-explorer').querySelector('.pf-pcard[data-entity="FVC"]')!;
    expect(fvcCard.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('pf-explorer-lede').textContent!.startsWith(`${D.properties.FVC.label}: NOI`)).toBe(true);
  });

  it('Portfolio-level items have no property link', () => {
    const portfolio = whereTheMoneyIs(D.insights).find((i) => i.property === 'Portfolio')!;
    const { container } = renderModule();
    const row = container.querySelector(`[data-insight="${portfolio.id}"]`) as HTMLElement;
    expect(within(row).queryByRole('button', { name: 'View property' })).toBeNull();
  });
});

describe('Scorecard (real dataset)', () => {
  const rowFor = (container: HTMLElement, id: string) => container.querySelector(`tr[data-entity="${id}"]`) as HTMLElement;

  it('one row per entity; partial periods are n/m with the reason', () => {
    const { container } = renderModule('?view=scorecard');
    expect(container.querySelectorAll('tr[data-entity]')).toHaveLength(Object.keys(D.properties).length);
    const west = rowFor(container, '3034 Westerville');
    const nm = within(west).getAllByText('n/m')[0]!;
    expect(nm.getAttribute('title')).toBe('partial period: 3 of 12 months');
    const solar = rowFor(container, '1851 South Club Solar');
    expect(within(solar).getAllByText('n/m').length).toBeGreaterThanOrEqual(3);
  });

  it('sorting a column orders by value, n/m last, and sets aria-sort', () => {
    const { container } = renderModule('?view=scorecard');
    fireEvent.click(screen.getByRole('button', { name: 'NOI FY25' }));
    const th = screen.getByRole('button', { name: /NOI FY25/ }).closest('th')!;
    expect(th.getAttribute('aria-sort')).toBe('descending');
    const ids = [...container.querySelectorAll('tr[data-entity]')].map((r) => r.getAttribute('data-entity')!);
    const vals = ids.map((id) => {
      const p = D.properties[id as keyof typeof D.properties];
      return p.periods.FY2025.n_months >= 12 ? p.periods.FY2025.noi : null;
    });
    const present = vals.filter((v): v is number => v !== null);
    expect(present).toEqual([...present].sort((a, b) => b - a));
    expect(vals.slice(present.length).every((v) => v === null)).toBe(true);
  });

  it('expanding a row shows category detail, movers, items and the Explorer hand-off', () => {
    const { container } = renderModule('?view=scorecard');
    const fvc = rowFor(container, 'FVC');
    const toggle = within(fvc).getByRole('button', { expanded: false });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const detail = screen.getByTestId('pf-detail-FVC');
    expect(within(detail).getByText('NOI (normalized)')).toBeTruthy();
    expect(within(detail).getByText(/Largest account movers, Jan-Sep 26 vs Jan-Sep 25/)).toBeTruthy();
    expect(within(detail).getByText(/Monthly base rent, Jan 2024 to Sep 2026/)).toBeTruthy();
    expect(within(detail).getAllByText('High').length).toBeGreaterThan(0);
    fireEvent.click(within(detail).getByRole('button', { name: 'Open full property view' }));
    const q = new URLSearchParams(lastSearch);
    expect(q.get('view')).toBe('explorer');
    expect(q.get('p')).toBe('FVC');
  });

  it('annual entities show their statement periods and below-NOI items', () => {
    const { container } = renderModule('?view=scorecard');
    fireEvent.click(within(rowFor(container, '55 New Plant (EGFLLC)')).getByRole('button', { expanded: false }));
    const detail = screen.getByTestId('pf-detail-55 New Plant (EGFLLC)');
    expect(within(detail).getByText('2026 YTD to 6/12')).toBeTruthy();
    expect(within(detail).getByText(/Interest expense:/)).toBeTruthy();
    expect(within(detail).getByRole('heading', { name: 'Lease' })).toBeTruthy();
  });
});
