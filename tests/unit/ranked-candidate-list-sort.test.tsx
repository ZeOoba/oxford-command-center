// tests/unit/ranked-candidate-list-sort.test.tsx
//
// Ranked acquisition list default order (2026-11-03 audit, finding acq-ranked-list-tier-string-sort).
// The Tier column sorted the tier STRING ascending, so localeCompare put KILLED and PASS above T1.
// The client order must match the server's /acq/intel ORDER BY: verdict rank (PURSUE, WATCH, PASS,
// KILLED), composite descending within a rank. Rows with no parsed score (unscored, unparseable) sort
// last — a deliberate, documented divergence for unparseable rows (see ranked-sort.ts).
//
// Renders the real RankedCandidateList (harness pattern from edge-overlay.test.tsx), so a regression in
// the production column wiring or initialSort is caught, not just in the sort-key function.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RankedCandidate } from '@contracts/acquisition';
import { RankedCandidateList } from '../../src/modules/acquisitions/RankedCandidateList';

type Shape = { tier: string; verdict: string; composite: number; reasons?: string[] } | null;

function cand(id: string, score: Shape, scoreState?: RankedCandidate['scoreState']): RankedCandidate {
  return {
    candidate: {
      id, source: 'manual', sourceBatchId: null, address: `addr-${id}`, county: null, state: null, market: null,
      rentableSf: null, yearBuilt: null, ownerName: null, parcelScreenScore: null, status: 'active', notionDealId: null,
      createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
    },
    latestScore: score as never,
    governorDscrCleared: null, governorLtvCleared: null, calibrationHitRate: null, scoredAt: null,
    ...(scoreState ? { scoreState } : {}),
  };
}

function renderList(items: RankedCandidate[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  qc.setQueryData(['snapshot'], { snapshot: { deals: [], governors: null } as never, state: {} as never });
  return render(
    <QueryClientProvider client={qc}>
      <RankedCandidateList items={items} advisoryOnly={false} writesEnabled={false} edgeEnabled={false} />
    </QueryClientProvider>,
  );
}

/** Candidate ids in rendered row order. */
const order = (): string[] => screen.getAllByText(/^addr-/).map((el) => (el.textContent ?? '').replace(/^addr-/, ''));
/** The Tier cell text of a candidate's row. */
const badgeOf = (id: string): string => {
  const row = screen.getByText(`addr-${id}`).closest('tr');
  if (!row) throw new Error(`no row for ${id}`);
  return within(row).getAllByRole('cell')[0]!.textContent ?? '';
};

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ROWS = [
  cand('killed-90', { tier: 'KILLED', verdict: 'KILLED', composite: 90 }),
  cand('unscored', null, 'unscored'),
  cand('pass-80', { tier: 'PASS', verdict: 'PASS', composite: 80 }),
  cand('t2-60', { tier: 'T2', verdict: 'WATCH', composite: 60 }),
  cand('t1-76', { tier: 'T1', verdict: 'PURSUE', composite: 76 }),
  cand('t1-88', { tier: 'T1', verdict: 'PURSUE', composite: 88 }),
];

describe('RankedCandidateList — tier sort', () => {
  it('default order is PURSUE, WATCH, PASS, KILLED, then unscored', () => {
    renderList(ROWS);
    expect(order()).toEqual(['t1-88', 't1-76', 't2-60', 'pass-80', 'killed-90', 'unscored']);
  });

  it('a high-composite KILLED or PASS never outranks a live PURSUE', () => {
    renderList([
      cand('killed-99', { tier: 'KILLED', verdict: 'KILLED', composite: 99 }),
      cand('pass-99', { tier: 'PASS', verdict: 'PASS', composite: 99 }),
      cand('t1-75', { tier: 'T1', verdict: 'PURSUE', composite: 75 }),
    ]);
    expect(order()[0]).toBe('t1-75');
  });

  it('a legacy governor-demoted row (tier T1, verdict PASS) ranks as PASS, matching the server', () => {
    renderList([
      cand('legacy-t1-pass', { tier: 'T1', verdict: 'PASS', composite: 95 }),
      cand('watch', { tier: 'T2', verdict: 'WATCH', composite: 50 }),
    ]);
    expect(order()).toEqual(['watch', 'legacy-t1-pass']);
  });

  it('an unparseable row (latestScore null) sorts last, below KILLED — deliberate divergence', () => {
    renderList([
      cand('unparseable', null, 'unparseable'),
      cand('killed-10', { tier: 'KILLED', verdict: 'KILLED', composite: 10 }),
    ]);
    expect(order()).toEqual(['killed-10', 'unparseable']);
  });

  it('desc toggle reverses the ranking and keeps rows with no score last', () => {
    renderList(ROWS);
    fireEvent.click(screen.getByText('Tier'));
    expect(order()).toEqual(['killed-90', 'pass-80', 't2-60', 't1-76', 't1-88', 'unscored']);
  });
});

describe('RankedCandidateList — tier badge agrees with the sort', () => {
  it('a legacy governor-demoted row reads PASS, not "T1 · PURSUE"', () => {
    renderList([cand('legacy-t1-pass', { tier: 'T1', verdict: 'PASS', composite: 95 })]);
    expect(badgeOf('legacy-t1-pass')).toContain('PASS');
    expect(badgeOf('legacy-t1-pass')).not.toContain('PURSUE');
  });

  it('a legacy governor-demoted row keeps the demotion visible with a was-T1 marker', () => {
    renderList([
      cand('legacy-t1-pass', { tier: 'T1', verdict: 'PASS', composite: 95 }),
      cand('t1', { tier: 'T1', verdict: 'PURSUE', composite: 80 }),
    ]);
    expect(badgeOf('legacy-t1-pass')).toContain('Governor-demoted (was T1)');
    expect(badgeOf('t1')).not.toContain('Governor-demoted');
  });

  it('a current-engine demotion (tier PASS + Governor demotion reason) is marked; a native PASS is not', () => {
    renderList([
      cand('engine-demoted', { tier: 'PASS', verdict: 'PASS', composite: 85, reasons: ['Governor demotion: PURSUE → PASS (tier T1 → PASS) — DSCR proxy failed or the live governor set is invalid.'] }),
      cand('native-pass', { tier: 'PASS', verdict: 'PASS', composite: 40, reasons: ['Composite below T2'] }),
    ]);
    expect(badgeOf('engine-demoted')).toContain('PASS · Governor-demoted (was T1)');
    expect(badgeOf('native-pass')).not.toContain('Governor-demoted');
  });

  it('coherent rows keep their tier label', () => {
    renderList([cand('t1', { tier: 'T1', verdict: 'PURSUE', composite: 80 }), cand('t2', { tier: 'T2', verdict: 'WATCH', composite: 60 })]);
    expect(badgeOf('t1')).toContain('T1 · PURSUE');
    expect(badgeOf('t2')).toContain('T2 · WATCH');
  });

  it('a row with no score shows "—", not a fake PASS', () => {
    renderList([cand('unscored', null, 'unscored')]);
    expect(badgeOf('unscored')).toBe('—');
  });
});
