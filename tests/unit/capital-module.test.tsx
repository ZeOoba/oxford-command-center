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
import { ToastProvider } from '../../src/primitives/Toast';
import { CapitalModule } from '../../src/modules/capital/CapitalModule';
import type { CapitalAllocationResponse } from '../../src/contracts/capital';
import type { CapitalAllocationReport } from '../../src/contracts/capital-allocation';

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

function renderModule() {
  return render(
    <QueryClientProvider client={seededClient()}>
      <ToastProvider>
        <CapitalModule />
      </ToastProvider>
    </QueryClientProvider>,
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
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <CapitalModule />
        </ToastProvider>
      </QueryClientProvider>,
    );
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
