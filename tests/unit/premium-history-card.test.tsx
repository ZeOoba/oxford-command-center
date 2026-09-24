import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PremiumHistoryCard, PREMIUM_HISTORY_KEY } from '../../src/modules/insurance/PremiumHistoryCard';

// jsdom doesn't ship ResizeObserver; BarChart's useMeasure hook requires it (same stub as
// acquisitions-best-cap.test.tsx / lease-forecast-module.test.tsx / overview-module-wiring.test.tsx).
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('PremiumHistoryCard', () => {
  it('renders the policy-year chart and a sparkline for each multi-term line only', () => {
    const qc = new QueryClient();
    qc.setQueryData(PREMIUM_HISTORY_KEY, {
      byYear: [{ year: 2025, premium: 190000, lines: 30 }, { year: 2026, premium: 193014, lines: 30 }],
      lines: [
        { lineKey: 'a', property: '3034 Westerville Rd', policyType: 'PCKG', terms: [{ effectiveDate: '2025-07-05', premium: 7831 }, { effectiveDate: '2026-07-05', premium: 7522 }] },
        { lineKey: 'b', property: '1100 Rarig', policyType: 'BCL', terms: [{ effectiveDate: '2026-03-19', premium: 595 }] },
      ],
    });
    render(<QueryClientProvider client={qc}><PremiumHistoryCard /></QueryClientProvider>);
    expect(screen.getByText('Premium History')).toBeTruthy();
    expect(screen.getByText(/3034 Westerville Rd/)).toBeTruthy();
    expect(screen.queryByText(/1100 Rarig/)).toBeNull();
    expect(screen.getByText('-3.9%')).toBeTruthy();
  });
});
