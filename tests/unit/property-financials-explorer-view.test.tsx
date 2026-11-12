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
import { pctLevel, usd } from '@analytics/property-financials/format';
import { PropertyFinancialsModule } from '../../src/modules/property-financials/PropertyFinancialsModule';
import { StackedBars } from '../../src/modules/property-financials/charts/PeriodBars';
import { PF_KEYS } from '../../src/modules/property-financials/hooks';
import { buildExplorer, propertyCards } from '../../src/modules/property-financials/explorer-model';
import type { PfDatasetResponse } from '../../src/modules/property-financials/types';
import { loadDataset } from './property-financials-helpers';
import { pfGolden } from './golden-helpers';

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
    // Figures come from the dataset (synthetic in CI, real where present: ruling 2026-11-10).
    // Each card figure is also held to the ratified value lock, so the check is not circular.
    const fy25 = (id: (typeof PF_ENTITY_IDS)[number]) => {
      const noi = D.history[id].yr['2025']!.noi;
      expect(Math.round(noi), `${id} FY2025 value lock`).toBe(pfGolden().noi[id]!.FY2025);
      return usd(noi);
    };
    expect(card('1100 Rarig').textContent).toContain(fy25('1100 Rarig'));
    expect(card('1100 Rarig').textContent).toContain('NOI 2025');
    for (const id of ['9050 Red Branch', 'FVC', '55 New Plant (EGFLLC)', '1851 South Club Solar'] as const) expect(card(id).textContent).toContain(fy25(id));
    for (const c of propertyCards(D)) if (c.noi !== null) expect(card(c.id).textContent).toContain(usd(c.noi));
  });

  it('YoY chip on the card: Rarig FY25 vs FY24 as arrow + |percent|; Livingston (partial only) n/m with a reason', () => {
    renderExplorer();
    // The chip is computed from the dataset in place (a ratio of two drawn figures on the synthetic copy).
    const v = D.history['1100 Rarig'].yr['2025']!.noi / D.history['1100 Rarig'].yr['2024']!.noi - 1;
    expect(card('1100 Rarig').textContent).toContain(`${v > 0 ? '▲ ' : '▼ '}${pctLevel(Math.abs(v), 1)}`);
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
      for (const t of el.querySelectorAll('table')) expect(t.closest('.pf-tbl, .ck-tbl'), id).not.toBeNull();
      // every SVG chart has a <details> data-table fallback
      for (const svg of el.querySelectorAll('svg[role="img"]')) expect(svg.closest('.pf-xchart, .ck-xchart')?.querySelector('details.pf-tablefb, details.ck-tablefb'), id).toBeTruthy();
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
    const rows = (D.leases.find((l) => l.property === '3034 Westerville') as unknown as { rent_schedule_monthly: Array<[string, string | null, number]> }).rent_schedule_monthly;
    const cur = rows.find((r) => r[0] === '2026-04-01')![2];
    const nxt = rows.find((r) => r[0] === '2027-04-01')![2];
    expect(cur).toBeCloseTo(pfGolden().locks.westervilleRent.current!, 2); // value locks
    expect(nxt).toBeCloseTo(pfGolden().locks.westervilleRent.next!, 2);
    expect(screen.getByTestId('pf-lease-current').textContent).toBe(`Current rent ${usd(cur * 12, 'f')} a year, $${((cur * 12) / 18_360).toFixed(2)} per SF.`);
    expect(screen.getByTestId('pf-lease-next').textContent).toContain(`Next step 2027-04-01 to ${usd(nxt, 'f')} per month`);
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

describe('M1: stacked opex total is signed', () => {
  it('9620 State 350 Jan-Sep 26: label and data-table Total show the opex NET of the tax credit, not the gross stack', () => {
    renderExplorer(`?view=explorer&p=${encodeURIComponent('9620 State 350')}`);
    const chart = screen.getByTestId('pf-stacked-bars');
    const row = [...chart.querySelectorAll('details tbody tr')].find((r) => r.firstElementChild!.textContent === 'Jan-Sep 26')!;
    // Figures come from the dataset (synthetic in CI, real where present: ruling 2026-11-10).
    const y = D.history['9620 State 350'].ytd['2026']!;
    const credit = y.cats['Real estate & property tax']!;
    const gross = y.opex - credit;
    expect(credit).toBeLessThan(0);
    expect(credit).toBeCloseTo(pfGolden().locks.credit9620ReTaxS26, 2); // value lock
    expect(row.lastElementChild!.textContent).toBe(`${usd(y.opex, 'f')} (incl. ${usd(credit, 'f')} credit)`);
    const labels = [...chart.querySelectorAll('svg text')].map((t) => t.textContent);
    expect(labels).toContain(`$${Math.round(y.opex / 1000)}K`); // the bar label is whole thousands
    expect(labels.some((l) => /^incl\. -\$[\d.,]+K? credit$/.test(l ?? ''))).toBe(true);
    expect(chart.textContent).not.toContain(Math.round(gross).toLocaleString('en-US'));
  });

  it('a category present only as a credit keeps its legend entry, marked as a credit', () => {
    const data = {
      columns: [{ key: '2025', label: '2025', partial: false, family: 'year' as const }],
      series: [
        { id: 'a', label: 'Tax', slot: 1 },
        { id: 'b', label: 'Insurance', slot: 2 },
      ],
      values: [[-100, 500]],
      tips: [[['2025 · Tax'], ['2025 · Insurance']]],
      stack: { totals: [400], credits: [-100], text: ['Total $400 (incl. -$100 credit)'], tableText: ['$400 (incl. -$100 credit)'], creditNote: ['incl. -$100 credit'] },
    };
    render(<StackedBars data={data} ariaLabel="t" />);
    const chart = screen.getByTestId('pf-stacked-bars');
    expect(chart.textContent).toContain('Tax (net credit, not drawn)');
    expect(chart.textContent).toContain('Insurance');
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
    const group = chart.querySelector('.ck-chart-focus') as HTMLElement;
    fireEvent.focus(group);
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(within(chart).getByRole('status').textContent).toMatch(/Operating expense/);
    fireEvent.keyDown(group, { key: 'Escape' });
    expect(within(chart).queryByRole('status')).toBeNull();
  });

  it('timeline: keyboard crosshair tooltip with month and both series', () => {
    renderExplorer(`?view=explorer&p=${encodeURIComponent('1100 Rarig')}`);
    const tl = screen.getByTestId('pf-timeline');
    const group = tl.querySelector('.ck-chart-focus') as HTMLElement;
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
