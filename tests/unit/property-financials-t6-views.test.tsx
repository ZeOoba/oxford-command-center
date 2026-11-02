// tests/unit/property-financials-t6-views.test.tsx — T6 of
// docs/superpowers/plans/2026-10-05-property-financials-module.md. Render tests of the Rent & NOI
// levers, Expense watchlist and Evaluation scorecard views on the REAL committed dataset: lever values
// spot-checked independently from the raw figures, insight cards (pill icon + label, Next step, impact
// or verify) carrying the shared workflow record, watchlist filters, the movers table, the RAG matrix
// equal to the calc lib, a definitions table generated from THRESHOLDS, and status never colour-only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { PF_MONTHLY_ENTITY_IDS } from '@contracts/property-financials';
import { usd } from '@analytics/property-financials/format';
import { EVALUATION_TEST_IDS, RAG_LABEL, THRESHOLDS, thresholdText, type EvaluationTestId, type EvaluationThreshold } from '@analytics/property-financials/thresholds';
import { PropertyFinancialsModule } from '../../src/modules/property-financials/PropertyFinancialsModule';
import { EvaluationView } from '../../src/modules/property-financials/EvaluationView';
import { PF_KEYS } from '../../src/modules/property-financials/hooks';
import { evaluationMatrix, filterWatchlist, topOpexMovers, WATCHLIST_ALL } from '../../src/modules/property-financials/model';
import type { PfDatasetResponse, PfInsightStatusResponse } from '../../src/modules/property-financials/types';
import { loadDataset, loadDatasetText } from './property-financials-helpers';

const D = loadDataset();
const RAW = JSON.parse(loadDatasetText()) as { properties: Record<string, { kind: string; periods: Record<string, { opex_by: Record<string, number>; base_rent: number }> }> };

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

function client(statuses: PfInsightStatusResponse = { records: [], orphanedIds: [] }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  qc.setQueryData(PF_KEYS.dataset, response());
  qc.setQueryData(PF_KEYS.insightStatus, statuses);
  return qc;
}

function wrap(node: ReactNode, search: string, statuses?: PfInsightStatusResponse) {
  return render(
    <QueryClientProvider client={client(statuses)}>
      <MemoryRouter initialEntries={[`/property-financials${search}`]}>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}
const renderView = (view: string, statuses?: PfInsightStatusResponse) => wrap(<PropertyFinancialsModule />, `?view=${view}`, statuses);
const panel = () => screen.getByRole('tabpanel');

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function allTablesScrollInside(root: HTMLElement) {
  const tables = root.querySelectorAll('table');
  expect(tables.length).toBeGreaterThan(0);
  for (const t of tables) expect(t.closest('.pf-tbl, .ck-tbl'), 'table must scroll inside .pf-tbl / .ck-tbl').not.toBeNull();
}

describe('Rent & NOI levers', () => {
  it('lede, eleven levers, values equal independent arithmetic, [SPECULATIVE] note', () => {
    renderView('levers');
    const p = panel();
    expect(within(p).getByRole('heading', { name: 'Rent and NOI levers' })).toBeTruthy();
    expect(within(p).getByText(/nine PM-reported assets/)).toBeTruthy();
    const sens = within(p).getByTestId('pf-levers');
    const rows = within(sens).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(11);
    let util = 0;
    for (const id of Object.keys(RAW.properties)) if (RAW.properties[id]!.kind === 'monthly') util += RAW.properties[id]!.periods.TTM26!.opex_by.Utilities!;
    const utilRow = rows.find((r) => r.textContent!.includes('Utilities: 10% reduction'))!;
    expect(utilRow.textContent).toContain(usd(util * 0.1, 'f'));
    const fishel = rows.find((r) => r.textContent!.includes('Fishel'))!;
    expect(fishel.textContent).toContain('$24,000');
    expect(fishel.textContent).toContain('Lease Executed 2021 -- 7658 Fishel.pdf');
    expect(within(p).getByText(/\[SPECULATIVE\]/)).toBeTruthy();
    allTablesScrollInside(p);
  });

  it('revenue + recovery cards: pill icon+label, id/type/property, Next step, impact or verify, workflow control', () => {
    renderView('levers');
    const p = panel();
    const want = D.insights.filter((i) => i.type === 'Revenue' || i.type === 'Recovery');
    const cards = p.querySelectorAll('article[data-insight]');
    expect([...cards].map((c) => c.getAttribute('data-insight')).sort()).toEqual(want.map((i) => i.id).sort());
    const rev09 = p.querySelector('article[data-insight="REV-09"]') as HTMLElement;
    const pill = rev09.querySelector('.pf-pill')!;
    expect(pill.textContent).toBe('High');
    expect(pill.getAttribute('data-icon')).toBe('filled circle');
    expect(within(rev09).getByText('REV-09')).toBeTruthy();
    expect(within(rev09).getByText('1851 South Club Solar')).toBeTruthy();
    expect(within(rev09).getByText('Next step')).toBeTruthy();
    expect(within(rev09).getByTestId('pf-impact').textContent).toContain(`-${usd(104_932, 'k')}`);
    const rev06 = p.querySelector('article[data-insight="REV-06"]') as HTMLElement;
    expect(within(rev06).getByTestId('pf-impact').textContent).toMatch(/verify.*No dollar estimate/);
    expect(within(rev06).getByRole('button', { name: 'Update status' })).toBeTruthy();
  });

  it('base-rent run-rate table: nine rows; lease-up gaps are n/m with a reason', () => {
    renderView('levers');
    const t = within(panel()).getByTestId('pf-runrate');
    const rows = within(t).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(PF_MONTHLY_ENTITY_IDS.length);
    const liv = rows.find((r) => r.textContent!.includes('Livingston'))!;
    const nms = within(liv).getAllByLabelText(/^not meaningful: /);
    expect(nms.length).toBeGreaterThanOrEqual(4);
    expect(nms[0]!.getAttribute('title')).toMatch(/Jul-Sep 2024/);
  });

  it('one persisted record per insight id: the same status shows in Overview and Levers', () => {
    const statuses = { records: [{ insightId: 'REC-01', owner: 'Asset mgmt', dueDate: '2026-11-01', status: 'in_progress' as const, dismissReason: null, updatedAt: '2026-10-05T00:00:00Z' }], orphanedIds: [] };
    renderView('levers', statuses);
    const card = panel().querySelector('article[data-insight="REC-01"]') as HTMLElement;
    expect(within(card).getByText('In progress')).toBeTruthy();
    expect(within(card).getByText('Owner: Asset mgmt')).toBeTruthy();
    cleanup();
    renderView('overview', statuses);
    const row = panel().querySelector('[data-insight="REC-01"]') as HTMLElement;
    expect(within(row).getByText('In progress')).toBeTruthy();
    expect(within(row).getByText('Owner: Asset mgmt')).toBeTruthy();
  });
});

describe('L4: status set against an earlier version of an item', () => {
  const rec = (version?: 'current' | 'earlier' | 'unknown') => ({
    records: [{ insightId: 'REC-01', owner: 'Asset mgmt', dueDate: null, status: 'resolved' as const, dismissReason: null, updatedAt: '2026-10-05T00:00:00Z', ...(version ? { version } : {}) }],
    orphanedIds: [],
  });

  it('"earlier": the record is shown with a visible label, status kept (not reopened)', () => {
    renderView('levers', rec('earlier'));
    const card = panel().querySelector('article[data-insight="REC-01"]') as HTMLElement;
    expect(within(card).getByText('Resolved')).toBeTruthy();
    expect(within(card).getByTestId('pf-status-version').textContent).toBe('Status set against an earlier dataset version: figures restated since');
  });

  it('"unknown": labelled as an unknown version; "current" or absent: no label', () => {
    renderView('levers', rec('unknown'));
    expect(within(panel().querySelector('article[data-insight="REC-01"]') as HTMLElement).getByTestId('pf-status-version').textContent).toBe(
      'Status set against an unknown dataset version',
    );
    cleanup();
    renderView('levers', rec('current'));
    expect(within(panel().querySelector('article[data-insight="REC-01"]') as HTMLElement).queryByTestId('pf-status-version')).toBeNull();
  });
});

describe('Expense watchlist', () => {
  const ids = (root: HTMLElement) => [...root.querySelectorAll('article[data-insight]')].map((c) => c.getAttribute('data-insight'));

  it('labelled selects; default lists every Expense item sorted severity then |impact|', () => {
    renderView('watchlist');
    const p = panel();
    const prop = within(p).getByLabelText('Property') as HTMLSelectElement;
    const sev = within(p).getByLabelText('Severity') as HTMLSelectElement;
    expect(prop.tagName).toBe('SELECT');
    expect(sev.tagName).toBe('SELECT');
    expect(ids(p)).toEqual(filterWatchlist(D.insights, { property: WATCHLIST_ALL, severity: WATCHLIST_ALL }).map((i) => i.id));
  });

  it('filters narrow the list; a no-match combination shows the empty state', () => {
    renderView('watchlist');
    const p = panel();
    fireEvent.change(within(p).getByLabelText('Severity'), { target: { value: 'High' } });
    expect(ids(p)).toEqual(filterWatchlist(D.insights, { property: WATCHLIST_ALL, severity: 'High' }).map((i) => i.id));
    fireEvent.change(within(p).getByLabelText('Property'), { target: { value: 'Portfolio' } });
    expect(ids(p)).toEqual(filterWatchlist(D.insights, { property: 'Portfolio', severity: 'High' }).map((i) => i.id));
    fireEvent.change(within(p).getByLabelText('Property'), { target: { value: '1100 Rarig' } });
    expect(ids(p)).toEqual([]);
    expect(within(p).getByText('No items match.')).toBeTruthy();
    expect(within(p).getByRole('status').textContent).toMatch(/0 items/);
  });

  it('workflow controls stay disabled until the status store has loaded (no blank-draft overwrite)', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    qc.setQueryData(PF_KEYS.dataset, response());
    // insight-status deliberately NOT seeded: the query is pending (fetch never resolves)
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/property-financials?view=watchlist']}>
          <PropertyFinancialsModule />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const card = panel().querySelector('article[data-insight="EXP-01"]') as HTMLElement;
    expect((within(card).getByRole('button', { name: 'Update status' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('cards carry the workflow controls', () => {
    renderView('watchlist');
    const card = panel().querySelector('article[data-insight="EXP-01"]') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Update status' }));
    expect(within(card).getByRole('form', { name: 'Workflow for EXP-01' })).toBeTruthy();
  });

  it('movers table: top 24 opex movers by |change|; a cost decrease reads favourable with its sign', () => {
    renderView('watchlist');
    const p = panel();
    const t = within(p).getByTestId('pf-movers');
    const rows = within(t).getAllByRole('row').slice(1);
    const { rows: want, excluded } = topOpexMovers(D);
    expect(rows).toHaveLength(want.length);
    expect(rows.some((r) => r.textContent!.includes('Livingston'))).toBe(false);
    expect(excluded.map((e) => e.entity)).toEqual(['3883 Livingston']);
    expect(within(p).getByTestId('pf-movers-excluded').textContent).toBe(
      `Left out (partial comparison period, no year-over-year): ${D.properties['3883 Livingston'].label}: partial period: 3 of 9 months (Jan-Sep 25).`,
    );
    want.forEach((w, k) => {
      const cells = rows[k]!.querySelectorAll('td');
      expect(cells[0]!.textContent).toBe(w.label);
      const chg = cells[4]!;
      expect(chg.textContent).toBe(`${w.mover.delta > 0 ? '+' : '-'}${usd(Math.abs(w.mover.delta))}`);
      expect(chg.className).toBe(w.mover.delta < 0 ? 'pf-pos' : 'pf-neg');
    });
    allTablesScrollInside(p);
  });
});

describe('Evaluation scorecard', () => {
  const SHAPE = { g: 'circle', a: 'diamond', r: 'triangle', n: 'hollow circle' } as const;

  it('nine x eight matrix equal to the calc lib; every cell has icon shape + value text + status word', () => {
    renderView('evaluation');
    const p = panel();
    const m = evaluationMatrix(D);
    const t = within(p).getByTestId('pf-eval');
    const rows = within(t).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(9);
    m.forEach((row, k) => {
      const cells = rows[k]!.querySelectorAll('.pf-rag');
      expect(cells).toHaveLength(8);
      EVALUATION_TEST_IDS.forEach((test, j) => {
        const c = cells[j] as HTMLElement;
        const st = row.cells[test].status;
        expect(c.getAttribute('data-status'), `${row.id}/${test}`).toBe(st);
        expect(c.getAttribute('data-icon')).toBe(SHAPE[st]);
        // never colour-only: the status word is in the cell text (visually hidden), no aria-label on a span
        expect(c.textContent).toContain(st === 'n' ? 'not meaningful' : RAG_LABEL[st]);
        expect(c.getAttribute('aria-label')).toBeNull();
        if (st === 'n') {
          const reason = row.cells[test].result.reason!;
          expect(c.getAttribute('title')).toBe(reason);
          // the reason is also readable without a mouse: in the text and shown on focus (data-reason)
          expect(c.textContent).toContain(reason);
          expect(c.getAttribute('data-reason')).toBe(reason);
          expect(c.tabIndex).toBe(0);
        }
      });
    });
    allTablesScrollInside(p);
  });

  it('definitions table is generated from THRESHOLDS; notes and review rhythm render', () => {
    renderView('evaluation');
    const p = panel();
    // The intro states the three bases actually used (TTM ratios, Q3 vs Q3 run-rate, Jan-Sep growth),
    // not "every status from trailing-twelve-month data".
    const intro = within(p).getByText(/tests to run on every property each month/).textContent!;
    expect(intro).not.toMatch(/computed from trailing-twelve-month data using/);
    expect(intro).toMatch(/trailing-twelve-month/);
    expect(intro).toMatch(/Q3/);
    expect(intro).toMatch(/Jan-Sep/);
    const defs = within(within(p).getByTestId('pf-eval-defs')).getAllByRole('row').slice(1);
    expect(defs.map((r) => r.querySelectorAll('td')[2]!.textContent)).toEqual(EVALUATION_TEST_IDS.map((t) => thresholdText(THRESHOLDS[t])));
    expect(within(p).getByText(/lease-up/).textContent).toMatch(/9620 State 350.*3034 Westerville Rd.*3875-3883 E Livingston/);
    expect(within(p).getByText(/not meaningful for single-tenant NNN/)).toBeTruthy();
    expect(within(p).getByRole('heading', { name: 'Review rhythm' })).toBeTruthy();
  });

  it('a mutated cloned config flips exactly the governed cells and rewrites its definition row', () => {
    const clone = structuredClone(THRESHOLDS) as Record<EvaluationTestId, EvaluationThreshold>;
    clone.recoveryRatio = { ...clone.recoveryRatio, amber: 0.1 };
    const before = evaluationMatrix(D);
    wrap(<EvaluationView dataset={D} thresholds={clone} />, '');
    const rows = within(screen.getByTestId('pf-eval')).getAllByRole('row').slice(1);
    let flipped = 0;
    before.forEach((row, k) => {
      const cells = rows[k]!.querySelectorAll('.pf-rag');
      EVALUATION_TEST_IDS.forEach((test, j) => {
        const shown = cells[j]!.getAttribute('data-status');
        const v = row.cells[test].result.value;
        const shouldFlip = test === 'recoveryRatio' && v !== null && v >= 0.1 && v < 0.5;
        expect(shown !== row.cells[test].status, `${row.id}/${test}`).toBe(shouldFlip);
        if (shouldFlip) {
          expect(shown).toBe('a');
          flipped++;
        }
      });
    });
    expect(flipped).toBeGreaterThan(0);
    const defs = within(screen.getByTestId('pf-eval-defs')).getAllByRole('row').slice(1);
    expect(defs[2]!.textContent).toContain('Green ≥ 85%, amber 10-85%, red < 10%');
  });
});
