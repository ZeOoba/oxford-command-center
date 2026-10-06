// tests/unit/property-financials-explorer-view.test.tsx — T7 of
// docs/superpowers/plans/2026-10-05-property-financials-module.md. Render tests of the Property
// explorer on the REAL committed dataset: the 11-card grid (aria-pressed, golden latest-full-year
// NOI), URL-persisted selection (?view=explorer&p=), a smoke cycle through all 11 selections (no
// NaN / undefined text, lede + charts + tables present), the lease panel only for the four entities
// with a lease, annual-only honesty, the FVC confirm flag, missing-months notes, the timeline range
// toggle, the "What changed" period selector, tooltips on marks (pointer + keyboard), data-table
// fallbacks, and the shared workflow controls on open items.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { PF_ENTITY_IDS } from '@contracts/property-financials';
import { usd } from '@analytics/property-financials/format';
import { PropertyFinancialsModule } from '../../src/modules/property-financials/PropertyFinancialsModule';
import { PF_KEYS } from '../../src/modules/property-financials/hooks';
import { buildExplorer, propertyCards } from '../../src/modules/property-financials/explorer-model';
import type { PfDatasetResponse } from '../../src/modules/property-financials/types';
import { loadDataset } from './property-financials-helpers';

const D = loadDataset();

function response(): PfDatasetResponse {
  return {
    availability: 'ok',
    readError: null,
    lastGoodLoadedAt: '2026-10-05T12:00:00.000Z',
    issues: [],
    meta: { version: D.meta.version, generated: D.meta.generated, as_of: D.meta.as_of, basis: 'cash', sha256: 'x', csvSha256: 'y', csvError: null, ageDays: 5, staleness: 'fresh' },
    dataset: D,
  };
}

let lastSearch = '';
function LocationProbe() {
  lastSearch = useLocation().search;
  return null;
}

function renderExplorer(search = '?view=explorer') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  qc.setQueryData(PF_KEYS.dataset, response());
  qc.setQueryData(PF_KEYS.insightStatus, { records: [], orphanedIds: [] });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/property-financials${search}`]}>
        <PropertyFinancialsModule />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const explorer = () => screen.getByTestId('pf-explorer');
const card = (id: string) => explorer().querySelector(`.pf-pcard[data-entity="${CSS.escape(id)}"]`) as HTMLButtonElement;
const detail = () => explorer().querySelector('.pf-xdetail') as HTMLElement;

beforeEach(() => {
  lastSearch = '';
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('card grid', () => {
  it('11 cards, one aria-pressed (default = second PM asset), golden latest full-year NOI on each', () => {
    renderExplorer();
    const cards = explorer().querySelectorAll('.pf-pcard');
    expect(cards).toHaveLength(11);
    const pressed = [...cards].filter((c) => c.getAttribute('aria-pressed') === 'true');
    expect(pressed.map((c) => c.getAttribute('data-entity'))).toEqual(['1900 Broadway']);
    expect(card('1100 Rarig').textContent).toContain('$REDACTED-AMT');
    expect(card('1100 Rarig').textContent).toContain('NOI 2025');
    expect(card('9050 Red Branch').textContent).toContain('$912,337'); // was $905,390 before the v03.2 prepaid-rent ruling
    expect(card('FVC').textContent).toContain('$837,090');
    expect(card('55 New Plant (EGFLLC)').textContent).toContain('$422,488');
    expect(card('1851 South Club Solar').textContent).toContain('$507,472');
    for (const c of propertyCards(D)) if (c.noi !== null) expect(card(c.id).textContent).toContain(usd(c.noi));
  });

  it('YoY chip on the card: Rarig ▲ 27.3%; Livingston (partial only) n/m with a reason', () => {
    renderExplorer();
    expect(card('1100 Rarig').textContent).toContain('▲ 27.3%');
    const nm = within(card('3883 Livingston')).getByLabelText(/^not meaningful: partial period/);
    expect(nm.textContent).toBe('n/m');
  });

  it('a card click selects it and persists ?view=explorer&p=<entity> in the URL', () => {
    renderExplorer();
    fireEvent.click(card('FVC'));
    expect(card('FVC').getAttribute('aria-pressed')).toBe('true');
    expect(card('1900 Broadway').getAttribute('aria-pressed')).toBe('false');
    const q = new URLSearchParams(lastSearch);
    expect(q.get('view')).toBe('explorer');
    expect(q.get('p')).toBe('FVC');
  });

  it('deep link ?view=explorer&p=<entity> opens that property', () => {
    renderExplorer(`?view=explorer&p=${encodeURIComponent('3540 E 5th')}`);
    expect(card('3540 E 5th').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('pf-explorer-lede').textContent).toBe(buildExplorer(D, '3540 E 5th').lede);
  });
});

describe('smoke: cycle all 11 selections', () => {
  it('every property renders lede, charts, tables; no NaN / undefined / Infinity text', () => {
    renderExplorer();
    for (const id of PF_ENTITY_IDS) {
      fireEvent.click(card(id));
      const el = detail();
      expect(el.getAttribute('data-entity')).toBe(id);
      const text = el.textContent ?? '';
      expect(text, id).not.toMatch(/\bNaN\b|undefined|Infinity/);
      expect(screen.getByTestId('pf-explorer-lede').textContent).toBe(buildExplorer(D, id).lede);
      expect(within(el).getByTestId('pf-grouped-bars')).toBeTruthy();
      expect(within(el).getByTestId('pf-stacked-bars')).toBeTruthy();
      expect(within(el).getByTestId('pf-yoy')).toBeTruthy();
      expect(within(el).getByTestId('pf-categories')).toBeTruthy();
      expect(within(el).getByTestId('pf-explorer-insights').children.length).toBeGreaterThan(0);
      // every table scrolls inside its own container (phone: no page h-scroll)
      for (const t of el.querySelectorAll('table')) expect(t.closest('.pf-tbl'), id).not.toBeNull();
      // every SVG chart has a <details> data-table fallback
      for (const svg of el.querySelectorAll('svg[role="img"]')) expect(svg.closest('.pf-xchart')?.querySelector('details.pf-tablefb'), id).toBeTruthy();
      // all charts' drawn attributes are finite
      for (const n of el.querySelectorAll('svg [x],svg [y],svg [width],svg [height],svg [d],svg [cx]')) {
        for (const a of ['x', 'y', 'width', 'height', 'd', 'cx', 'cy']) expect(n.getAttribute(a) ?? '', `${id} ${a}`).not.toMatch(/NaN|Infinity/);
      }
    }
  });
});

describe('rules on the page', () => {
  it('lease panel ONLY for the four entities with a lease', () => {
    renderExplorer();
    const withLease: string[] = [];
    for (const id of PF_ENTITY_IDS) {
      fireEvent.click(card(id));
      if (detail().querySelector('[data-panel="lease"]')) withLease.push(id);
    }
    expect(withLease.sort()).toEqual(['3034 Westerville', '3540 E 5th', '3883 Livingston', '55 New Plant (EGFLLC)'].sort());
  });

  it('lease panel: current rent, $/SF on the lease SF, next step, step chart with today marker', () => {
    renderExplorer(`?view=explorer&p=${encodeURIComponent('3034 Westerville')}`);
    expect(screen.getByTestId('pf-lease-current').textContent).toBe(`Current rent ${usd(REDACTED-AMT * 12, 'f')} a year, $${((REDACTED-AMT * 12) / 18_360).toFixed(2)} per SF.`);
    expect(screen.getByTestId('pf-lease-next').textContent).toMatch(/^Next step 2027-04-01 to \$REDACTED-AMT per month/);
    expect(within(screen.getByTestId('pf-step-chart')).getByText('today')).toBeTruthy();
  });

  it('annual-only entity: no monthly timeline, honest note, no range toggle', () => {
    renderExplorer(`?view=explorer&p=${encodeURIComponent('1851 South Club Solar')}`);
    expect(screen.queryByTestId('pf-timeline')).toBeNull();
    expect(screen.getByTestId('pf-annual-only').textContent).toMatch(/annual statements only/i);
    expect(screen.queryByRole('group', { name: 'Timeline range' })).toBeNull();
    expect(screen.getByText('Annual statements only: see the year-over-year table for the rent change.')).toBeTruthy();
  });

  it('FVC: the confirm-me SF mapping flag is shown prominently; not on other properties', () => {
    renderExplorer(`?view=explorer&p=FVC`);
    const flag = screen.getByTestId('pf-fvc-flag');
    expect(flag.getAttribute('role')).toBe('note');
    expect(flag.textContent).toMatch(/Confirm/);
    expect(flag.textContent).toContain(D.sf.FVC.note);
    fireEvent.click(card('1100 Rarig'));
    expect(screen.queryByTestId('pf-fvc-flag')).toBeNull();
  });

  it('missing months noted on the page (Westerville Oct 2024)', () => {
    renderExplorer(`?view=explorer&p=${encodeURIComponent('3034 Westerville')}`);
    expect(screen.getByTestId('pf-missing-months').textContent).toMatch(/Oct 2024/);
  });

  it('YoY table: partial columns are n/m, Jan-Sep $/SF marked "9 mo", SF note cites current total SF', () => {
    renderExplorer(`?view=explorer&p=FVC`);
    const t = screen.getByTestId('pf-yoy');
    const head = [...t.querySelectorAll('thead th')].map((th) => th.textContent);
    const col = head.indexOf('2022 (8 mo)');
    expect(col).toBeGreaterThan(0);
    const noiRow = [...t.querySelectorAll('tbody tr')].find((r) => r.firstElementChild!.textContent === 'NOI')!;
    expect(noiRow.children[col]!.querySelector('.pf-nm')).not.toBeNull();
    expect(t.textContent).toContain('9 mo');
    expect(screen.getByText(/divide each period by current total building SF \(109,657 SF/)).toBeTruthy();
  });
});

describe('interaction', () => {
  it('timeline range toggle: aria-pressed seg control, "Since" window is shorter', () => {
    renderExplorer(`?view=explorer&p=${encodeURIComponent('9050 Red Branch')}`);
    const seg = screen.getByRole('group', { name: 'Timeline range' });
    const [all, since] = within(seg).getAllByRole('button');
    expect(all!.getAttribute('aria-pressed')).toBe('true');
    expect(since!.textContent).toBe('Since Jan 2024');
    const rows = () => screen.getByTestId('pf-timeline').querySelectorAll('details tbody tr').length;
    const before = rows();
    fireEvent.click(since!);
    expect(since!.getAttribute('aria-pressed')).toBe('true');
    expect(all!.getAttribute('aria-pressed')).toBe('false');
    expect(rows()).toBeLessThan(before);
    expect(screen.getByTestId('pf-timeline').querySelectorAll('[data-marker]').length).toBeGreaterThan(0);
  });

  it('"What changed and why": period selector switches the comparison; nature tags carry [INFERRED]', () => {
    renderExplorer(`?view=explorer&p=${encodeURIComponent('1100 Rarig')}`);
    const why = screen.getByTestId('pf-why');
    expect(within(why).getByText(/Effect on NOI by line, Jan-Sep 2026 vs Jan-Sep 2025/)).toBeTruthy();
    expect(within(why).getAllByText('[INFERRED] from monthly timing').length).toBeGreaterThan(0);
    fireEvent.change(within(why).getByLabelText('Comparison'), { target: { value: '2025' } });
    expect(within(why).getByText(/Effect on NOI by line, 2025 vs 2024/)).toBeTruthy();
    // helps / hurts never colour alone: arrow + pattern class
    const rows = why.querySelectorAll('.pf-brow');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const kind = r.getAttribute('data-effect');
      expect(r.querySelector(kind === 'helps' ? 'i.pf-helps' : 'i.pf-hurts')).not.toBeNull();
      expect(r.textContent).toMatch(kind === 'helps' ? /▲/ : /▼/);
    }
  });

  it('bars: hover/tap a bar → tooltip; keyboard arrows walk the marks', () => {
    renderExplorer(`?view=explorer&p=${encodeURIComponent('1100 Rarig')}`);
    const chart = screen.getByTestId('pf-grouped-bars');
    const bar = chart.querySelector('rect[data-mark]')!;
    fireEvent.pointerEnter(bar);
    expect(within(chart).getByRole('status').textContent).toMatch(/Revenue/);
    const group = chart.querySelector('.pf-chart-focus') as HTMLElement;
    fireEvent.focus(group);
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(within(chart).getByRole('status').textContent).toMatch(/Operating expense/);
    fireEvent.keyDown(group, { key: 'Escape' });
    expect(within(chart).queryByRole('status')).toBeNull();
  });

  it('timeline: keyboard crosshair tooltip with month and both series', () => {
    renderExplorer(`?view=explorer&p=${encodeURIComponent('1100 Rarig')}`);
    const tl = screen.getByTestId('pf-timeline');
    const group = tl.querySelector('.pf-chart-focus') as HTMLElement;
    fireEvent.focus(group);
    const tip = within(tl).getByRole('status');
    expect(tip.textContent).toMatch(/Sep 2026/);
    expect(tip.textContent).toMatch(/Base rent \$/);
    expect(tip.textContent).toMatch(/Opex excl. tax/);
  });

  it('open review items carry the shared workflow controls', () => {
    renderExplorer(`?view=explorer&p=FVC`);
    const items = detail().querySelectorAll('article[data-insight]');
    expect([...items].map((i) => i.getAttribute('data-insight')).sort()).toEqual(['EXP-04', 'REC-01', 'REV-01']);
    expect(within(items[0] as HTMLElement).getByRole('button', { name: 'Update status' })).toBeTruthy();
  });
});
