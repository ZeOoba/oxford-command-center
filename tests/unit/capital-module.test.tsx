// tests/unit/capital-module.test.tsx
//
// Render-level tests for src/modules/capital/CapitalModule.tsx.
//
// CapitalModule now folds in the three capabilities that previously lived ONLY in the
// (now-deleted) orphan src/modules/capital/CapitalAllocationModule.tsx:
//   1. Market cap-rate positioning columns (impliedCapRate / capRateGap / capRatePercentile),
//      sourced from a SECOND query (GET /api/warehouse/capital-allocation → CapitalAllocationReport)
//      — a different engine/data shape than the primary AllocationCard panel (GET
//      /api/warehouse/capital/allocate → CapitalAllocationResponse).
//   2. An IC Memo export link (same anchor/href mechanic as the orphan).
//   3. A Notion-sync button (same POST + toast mechanic as the orphan).
//
// Both queries are seeded directly into the QueryClient cache (mirrors
// tests/unit/market-module-smoke.test.tsx) so the render is deterministic and network-free;
// the Notion-sync mutation POST is exercised against a stubbed global fetch.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../../src/primitives/Toast';
import { CapitalModule } from '../../src/modules/capital/CapitalModule';
import type { CapitalAllocationResponse } from '../../src/contracts/capital';
import type { CapitalAllocationReport } from '../../src/contracts/capital-allocation';

// The three absorbed modules are mocked so this suite stays about Capital (each has its own suite).
vi.mock('../../src/modules/debt/DebtModule', () => ({ DebtModule: () => <div>debt-panel</div> }));
vi.mock('../../src/modules/cash/CashModule', () => ({ CashModule: () => <div>cash-panel</div> }));
vi.mock('../../src/modules/close/CloseModule', () => ({ CloseModule: () => <div>close-panel</div> }));

function allocationResponse(): CapitalAllocationResponse {
  return {
    asOf: '2026-07-06',
    hurdleRate: {
      hurdleRatePct: 0.08,
      ratification: 'ratified',
      ratifiedBy: 'Gabriel',
      ratifiedDate: '2026-06-22',
      capitalConfigVersion: 2,
    },
    advisoryOnly: false,
    portfolio: {
      asOf: '2026-07-06',
      hurdleRatePct: 0.08,
      advisoryOnly: false,
      verdicts: [
        {
          propertyId: 'prop-1',
          propertyName: 'Prop One',
          period: '2026-07',
          action: 'hold',
          expectedReturnPct: 0.09,
          returnAboveHurdle: true,
          riskBand: 'moderate',
          timelineMonths: 12,
          horizonPeriods: 4,
          confidence01: 0.7,
          confidenceTier: 'derived',
          advisoryOnly: false,
          reasons: ['Steady NOI trend'],
          inputs: {
            healthBand: 'good',
            attentionBand: 'green',
            capitalAction: 'hold',
            debtSignal: 'hold',
            debtScoreBand: 'adequate',
            dscr: 1.4,
            dscrHeadroom: 0.2,
            ltv: 0.55,
            noiPerSf: 8.2,
            forecastPresent: true,
      bookTrust: 'trusted', // round 19d - fixture models a healthy book
          },
          dataQuality: [],
        },
      ],
      actionCounts: { buy: 0, hold: 1, sell: 0, refinance: 0, improve: 0 },
      pipeline: [],
    },
  };
}

function capitalAllocationReport(): CapitalAllocationReport {
  return {
    asOf: '2026-07-06',
    propertyCount: 2,
    entries: [
      {
        propertyId: 'prop-1',
        propertyName: 'Prop One',
        market: 'Columbus, OH',
        sf: 42_000,
        capitalAction: 'invest',
        priorityScore: 61,
        healthScore: 78,
        attentionScore: 40,
        nearTermExpiryRent: 12_000,
        atRiskLikelihoodCount: 1,
        debtScore: 70,
        balloonMonths: null,
        dscr: 1.4,
        rationale: ['Above-market yield'],
        noi: 500_000,
        noiPerSf: 11.9,
        noiBasis: 'spine-a',
        leasingRisk: 20,
        impliedCapRate: 0.072,
        capRateGap: 0.008,
        capRatePercentile: 'top',
      },
      {
        propertyId: 'prop-2',
        propertyName: 'Prop Two',
        market: 'Indianapolis, IN',
        sf: 30_000,
        capitalAction: 'hold',
        priorityScore: 22,
        healthScore: 85,
        attentionScore: 15,
        nearTermExpiryRent: 0,
        atRiskLikelihoodCount: 0,
        debtScore: 88,
        balloonMonths: null,
        dscr: 1.9,
        rationale: [],
        noi: 300_000,
        noiPerSf: 10,
        noiBasis: 'spine-a',
        leasingRisk: 5,
        impliedCapRate: null,
        capRateGap: null,
        capRatePercentile: null,
      },
    ],
    portfolioNoi: 800_000,
    portfolioNoBasis: 'spine-a',
    investCount: 1,
    holdCount: 1,
    monitorCount: 0,
    dispositionCount: 0,
    macro: { tenYearRate: 4.1, cpi: 3.1, source: 'fred', asOf: '2026-07-01' },
    marketBenchmarks: { available: true, source: 'fred', asOf: '2026-07-01' },
    regionalMacro: null,
  };
}

/**
 * Round 8 fresh-sweep (adversarial refute, HIGH — reproduced with byte-identical rendered DOM):
 * AllocationCard/CapitalModule never read verdict.inputs.bookTrust or verdict.dataQuality at all,
 * so a withheld-because-distrusted verdict rendered pixel-identical to a genuine clean hold. Adds
 * one degraded owned-property verdict (must show the distrust badge + inline dataQuality text) and
 * one pipeline 'buy' verdict with bookTrust:'unknown' (must NOT show it — that value is a
 * documented "not applicable" placeholder for unowned candidates, not a real trust failure; see
 * buildBuyVerdict's docblock in capital-allocation.ts and filterTrustedVerdicts' in
 * capital-allocation-api.ts, which draw the identical distinction server-side).
 */
function allocationResponseWithTrustIssues(): CapitalAllocationResponse {
  const base = allocationResponse();
  const trustedVerdict = base.portfolio.verdicts[0]!;
  const degraded = {
    ...trustedVerdict,
    propertyId: 'prop-2',
    propertyName: 'Prop Two',
    action: 'hold' as const,
    riskBand: 'elevated' as const,
    inputs: {
      ...trustedVerdict.inputs,
      bookTrust: 'degraded' as const,
      dscr: null,
      ltv: null,
    },
    dataQuality: [
      {
        entity: 'prop-2',
        field: 'debtBook',
        issue: 'The debt book is DEGRADED — the last snapshot write lost rows.',
        severity: 'error' as const,
      },
    ],
  };
  const buy = {
    ...trustedVerdict,
    propertyId: 'pipeline:cand-1',
    propertyName: 'Pipeline Candidate One',
    action: 'buy' as const,
    riskBand: 'moderate' as const,
    inputs: {
      ...trustedVerdict.inputs,
      bookTrust: 'unknown' as const,
    },
    dataQuality: [],
  };
  return {
    ...base,
    portfolio: {
      ...base.portfolio,
      verdicts: [...base.portfolio.verdicts, degraded, buy],
      actionCounts: { buy: 1, hold: 2, sell: 0, refinance: 0, improve: 0 },
    },
  };
}

function seededClient(): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  // Primary panel — useCapitalAllocation (src/modules/capital/hooks.ts) keys on
  // ['warehouse', 'capital', 'allocation'].
  qc.setQueryData(['warehouse', 'capital', 'allocation'], allocationResponse());
  // Folded-in cap-rate panel — the local useCapitalAllocationReport() hook keys on
  // ['warehouse', 'capital-allocation', 'report'].
  qc.setQueryData(['warehouse', 'capital-allocation', 'report'], capitalAllocationReport());
  return qc;
}

// useTabParam needs a Router context. `entry` deep-links a tab (`?tab=`); default = Allocation.
function renderModule(entry = '/capital', qc: QueryClient = seededClient()) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <CapitalModule />
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CapitalModule — market cap-rate positioning (folded in from CapitalAllocationModule)', () => {
  it('renders impliedCapRate / capRateGap / capRatePercentile for a scored property', () => {
    renderModule();
    expect(screen.getByText('Market Cap-Rate Positioning')).toBeTruthy();
    // impliedCapRate 0.072 → "7.2%"
    expect(screen.getByText('7.2%')).toBeTruthy();
    // capRateGap 0.008 → "+80 bps"
    expect(screen.getByText('+80 bps')).toBeTruthy();
    // capRatePercentile 'top' → Badge "Above mkt"
    expect(screen.getByText('Above mkt')).toBeTruthy();
  });

  it('renders the em-dash fail-open state when cap-rate fields are null', () => {
    renderModule();
    // Prop Two has null impliedCapRate/capRateGap/capRatePercentile — all render '—'.
    const propTwoRow = screen.getByText('Prop Two').closest('tr')!;
    expect(propTwoRow.textContent).toContain('—');
  });

  it('shows a live cap-benchmark provenance badge when marketBenchmarks.source is fred', () => {
    renderModule();
    expect(screen.getByText('Cap benchmarks: live')).toBeTruthy();
  });
});

describe('CapitalModule — IC Memo export (folded in from CapitalAllocationModule)', () => {
  it('renders an enabled export link pointing at the ic-memo route when entries exist', () => {
    renderModule();
    const link = screen.getByText('Export IC Memo').closest('a')!;
    expect(link.getAttribute('href')).toBe('/api/warehouse/capital-allocation/ic-memo');
    expect(link.getAttribute('aria-disabled')).toBe('false');
  });

  it('disables the export link when the report has zero entries', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    qc.setQueryData(['warehouse', 'capital', 'allocation'], allocationResponse());
    qc.setQueryData(['warehouse', 'capital-allocation', 'report'], { ...capitalAllocationReport(), entries: [] });
    renderModule('/capital', qc);
    const link = screen.getByText('Export IC Memo').closest('a')!;
    expect(link.getAttribute('aria-disabled')).toBe('true');
    expect(link.getAttribute('href')).toBeNull();
  });
});

describe('CapitalModule — Notion sync (folded in from CapitalAllocationModule)', () => {
  it('POSTs to /api/warehouse/capital-allocation/sync-notion and shows a success toast', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/warehouse/capital-allocation/sync-notion')) {
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({ synced: 2, skipped: 0, errors: [], asOf: '2026-07-06' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderModule();
    fireEvent.click(screen.getByRole('button', { name: 'Sync capital decisions to Notion' }));

    await waitFor(() => expect(screen.getByText('Synced 2 to Notion')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/capital-allocation/sync-notion',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows an error toast when the sync fails (e.g. NOTION_TOKEN not configured)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'NOTION_TOKEN not configured' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })));

    renderModule();
    fireEvent.click(screen.getByRole('button', { name: 'Sync capital decisions to Notion' }));

    await waitFor(() => expect(screen.getByText('Notion sync failed')).toBeTruthy());
    expect(screen.getByText('NOTION_TOKEN not configured')).toBeTruthy();
  });
});

describe('CapitalModule / AllocationCard — round 8 fresh-sweep: debt-book trust surfacing', () => {
  function renderWithTrustIssues() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    qc.setQueryData(['warehouse', 'capital', 'allocation'], allocationResponseWithTrustIssues());
    qc.setQueryData(['warehouse', 'capital-allocation', 'report'], capitalAllocationReport());
    return renderModule('/capital', qc);
  }

  it('shows a "book not trusted" badge and the debtBook dataQuality text for a degraded verdict', () => {
    renderWithTrustIssues();
    expect(screen.getByText('book not trusted')).toBeTruthy();
    expect(screen.getByText(/DEGRADED — the last snapshot write lost rows/)).toBeTruthy();
  });

  it('does NOT show a distrust badge on a "buy" verdict whose bookTrust is the "not applicable" placeholder', () => {
    renderWithTrustIssues();
    // Only the one degraded owned-property verdict should carry the badge — the buy verdict's
    // bookTrust:'unknown' is a documented placeholder, not a real distrust signal.
    expect(screen.getAllByText('book not trusted')).toHaveLength(1);
    expect(screen.queryByText('book not loaded')).toBeNull();
  });

  it('surfaces a portfolio-level count of properties on an untrusted book, excluding buy verdicts', () => {
    renderWithTrustIssues();
    expect(screen.getByText('1 on untrusted book')).toBeTruthy();
  });

  it('renders no distrust indicator at all for a fully trusted portfolio (no false positive)', () => {
    renderModule();
    expect(screen.queryByText('book not trusted')).toBeNull();
    expect(screen.queryByText('book not loaded')).toBeNull();
    expect(screen.queryByText(/on untrusted book/)).toBeNull();
  });
});

describe('CapitalModule — Allocation / Pipeline tab structure', () => {
  function clientWithPipeline(): QueryClient {
    const qc = seededClient();
    const base = allocationResponse();
    qc.setQueryData(['warehouse', 'capital', 'allocation'], {
      ...base,
      portfolio: {
        ...base.portfolio,
        pipeline: [
          { candidateId: 'cand-1', address: '500 Commerce Dr', market: null, composite: 81.4, tier: 'T1', leveredIrr: 0.153, basisDiscountPct: 0.12 },
        ],
      },
    });
    return qc;
  }

  it('lands on Allocation: cards + cap-rate table + IC-memo/Notion buttons + footnote visible; Buy Pipeline not rendered', () => {
    renderModule('/capital', clientWithPipeline());
    expect(screen.getByRole('tab', { name: 'Allocation' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByText('Prop One').length).toBeGreaterThan(0);
    expect(screen.getByText('Market Cap-Rate Positioning')).toBeTruthy();
    expect(screen.getByText('Export IC Memo')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sync capital decisions to Notion' })).toBeTruthy();
    expect(screen.getByText(/Implied cap = Spine-A NOI/)).toBeTruthy();
    expect(screen.queryByText('Buy Pipeline')).toBeNull();
    expect(screen.queryByText('500 Commerce Dr')).toBeNull();
  });

  it('keeps each verdict beside its implied-cap-rate columns in the same tab (R1 same-glance pair)', () => {
    renderModule();
    // Verdict card (AllocationCard) and the cap-rate table row for the same property are co-resident.
    expect(screen.getByText('Market Cap-Rate Positioning')).toBeTruthy();
    expect(screen.getByText('7.2%')).toBeTruthy();
    expect(screen.getAllByText('Prop One').length).toBeGreaterThanOrEqual(2);
  });

  it('Pipeline tab is reachable and holds the Buy Pipeline (nothing lost); allocation content is unmounted', () => {
    renderModule('/capital', clientWithPipeline());
    fireEvent.click(screen.getByRole('tab', { name: 'Pipeline' }));
    expect(screen.getByText('Buy Pipeline')).toBeTruthy();
    expect(screen.getByText('500 Commerce Dr')).toBeTruthy();
    expect(screen.getByText('1 candidates')).toBeTruthy();
    expect(screen.queryByText('Market Cap-Rate Positioning')).toBeNull();
  });

  it('deep-links the Pipeline tab via ?tab=', () => {
    renderModule('/capital?tab=pipeline', clientWithPipeline());
    expect(screen.getByRole('tab', { name: 'Pipeline' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('500 Commerce Dr')).toBeTruthy();
  });

  it('an empty pipeline still renders the Pipeline tab with an explanatory empty state (R7)', () => {
    renderModule('/capital?tab=pipeline');
    expect(screen.getByRole('tab', { name: 'Pipeline' })).toBeTruthy();
    expect(screen.getByText('Buy Pipeline')).toBeTruthy();
    expect(screen.getByText(/No T1\/T2 buy candidates/)).toBeTruthy();
  });
});

describe('CapitalModule — Phase 4b destination (Allocation · Pipeline · Debt · Cash · Close)', () => {
  it('shows five tabs in order, Allocation default', () => {
    renderModule();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Allocation', 'Pipeline', 'Debt', 'Cash', 'Close']);
    expect(screen.getByRole('tab', { name: 'Allocation' }).getAttribute('aria-selected')).toBe('true');
  });

  it.each([['debt', 'debt-panel'], ['cash', 'cash-panel'], ['close', 'close-panel']])('?tab=%s mounts %s', async (id, text) => {
    renderModule(`/capital?tab=${id}`);
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByText('Market Cap-Rate Positioning')).toBeNull();
  });

  it('Rule G: Debt/Cash/Close stay usable while capital queries load and after they FAIL', async () => {
    // Real failure path: every fetch (allocation, report, mirror) returns 503 -> WarehouseUnavailableError
    // -> useCapitalAllocation ends in status 'error'. (QUERY_OPTS retry:1 means the error lands ~1s in.)
    const fetchMock = vi.fn(async () => new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderModule('/capital?tab=debt', qc);
    // While the capital query is still loading (no data yet) the tab panel is already usable.
    expect(await screen.findByText('debt-panel')).toBeTruthy();
    // ...and once the query has actually errored it still is.
    await waitFor(() => expect(qc.getQueryState(['warehouse', 'capital', 'allocation'])?.status).toBe('error'), { timeout: 5000 });
    expect(screen.getByText('debt-panel')).toBeTruthy();
    expect(screen.queryByText(/Capital allocation data unavailable/)).toBeNull();
    for (const id of ['cash', 'close']) {
      fireEvent.click(screen.getByRole('tab', { name: id === 'cash' ? 'Cash' : 'Close' }));
      expect(await screen.findByText(`${id}-panel`)).toBeTruthy();
    }
  });

  it('the Allocation tab shows the unavailable card (not a dead page) when capital data is missing', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    renderModule('/capital', qc);
    expect(await screen.findByText(/Capital allocation data unavailable/, undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Debt' })).toBeTruthy(); // the strip is still there
  });

  it('a failed refetch that retains stale data hides the verdict-count strip alongside the unavailable card', async () => {
    const qc = seededClient();
    renderModule('/capital', qc);
    // Precondition: good data is rendered.
    expect(screen.getByText('Hold 1')).toBeTruthy();
    expect(screen.getByText('Capital Allocation')).toBeTruthy();
    // Server goes down; window-refocus style refetch fails. TanStack v5 keeps the old data.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    void qc.refetchQueries({ queryKey: ['warehouse', 'capital', 'allocation'] });
    await waitFor(() => expect(qc.getQueryState(['warehouse', 'capital', 'allocation'])?.status).toBe('error'), { timeout: 5000 });
    // Non-vacuous: data is still retained while status is 'error'.
    expect(qc.getQueryState(['warehouse', 'capital', 'allocation'])?.data).toBeTruthy();
    expect(await screen.findByText(/Capital allocation data unavailable/, undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText('Hold 1')).toBeNull();
    expect(screen.queryByText('Capital Allocation')).toBeNull();
  });

  it('R2 (revised): the verdict-count strip sits above the strip on Allocation/Pipeline only', () => {
    renderModule('/capital?tab=pipeline');
    expect(screen.getByText('Capital Allocation')).toBeTruthy();
    expect(screen.getByText('Hold 1')).toBeTruthy();
  });

  it('the verdict-count strip is absent on Debt (it is about allocation, not loans)', async () => {
    renderModule('/capital?tab=debt');
    await screen.findByText('debt-panel');
    expect(screen.queryByText('Hold 1')).toBeNull();
    expect(screen.queryByText('Capital Allocation')).toBeNull();
  });
});
