// tests/unit/calibration-module-smoke.test.tsx
//
// Render-level SMOKE test for the Calibration panel. The explicit Phase-2 requirement: the panel
// must render correctly on EMPTY data (the normal state until outcomes accrue) — no crash, no NaN,
// an explicit "no resolved outcomes yet" state. We seed a local TanStack QueryClient cache with the
// CALIBRATION_KEYS so the hooks resolve from cache with NO network and NO module mocking.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { CalibrationModule } from '../../src/modules/calibration/CalibrationModule';
import { ReportView } from '../../src/modules/calibration/ReportView';
import { CALIBRATION_KEYS } from '../../src/modules/calibration/hooks';
import type { CalibrationReportResponse } from '../../src/contracts/warehouse';

const EMPTY_REPORT: CalibrationReportResponse = {
  from: null, to: null, kind: null,
  totalVerdicts: 0, resolvedVerdicts: 0, scoreableVerdicts: 0,
  overallHitRate: null, treatmentAdjustedHitRate: null, treatmentAdjustedScoreable: 0,
  byKind: [],
  dataMaturityNote: 'The first ~5 years are data-accumulation, not actionable calibration.',
};

function seededClient(report: CalibrationReportResponse): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(CALIBRATION_KEYS.report, report);
  qc.setQueryData(CALIBRATION_KEYS.pending, []);
  qc.setQueryData(CALIBRATION_KEYS.log(null, null, null), []);
  return qc;
}

function renderWith(qc: QueryClient) {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <CalibrationModule />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('CalibrationModule — empty data (the normal Phase-2 state)', () => {
  it('mounts without throwing and shows the explicit "no resolved outcomes yet" state', () => {
    renderWith(seededClient(EMPTY_REPORT));
    expect(screen.getByText('Score-vs-Outcome Calibration')).toBeTruthy();
    expect(screen.getByText(/no resolved outcomes yet/i)).toBeTruthy();
    // No NaN leaks into the DOM anywhere.
    expect(document.body.textContent).not.toMatch(/NaN/);
  });

  it('renders zeroed report counts as a dash for rates, never NaN / 0-of-0', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ReportView report={EMPTY_REPORT} />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/no resolved outcomes yet/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/NaN/);
  });
});

describe('ReportView — populated data renders rates without NaN', () => {
  it('a kind with 0 scoreable shows a dash hit-rate, not 0/0 → NaN', () => {
    const report: CalibrationReportResponse = {
      ...EMPTY_REPORT,
      totalVerdicts: 4, resolvedVerdicts: 2, scoreableVerdicts: 2, overallHitRate: 0.5,
      treatmentAdjustedHitRate: null, treatmentAdjustedScoreable: 0,
      byKind: [
        {
          verdictKind: 'capital-action', total: 4, resolved: 2, scoreable: 2, hits: 1, hitRate: 0.5,
          wilsonLow: 0.09, wilsonHigh: 0.91, directionalScoreable: 2, directionalHits: 1,
          directionalAccuracy: 0.5, meanSignedError: null, byBand: [],
        },
        {
          // A kind with NOTHING scoreable: hitRate null, Wilson null — must show dashes, not NaN.
          verdictKind: 'anomaly', total: 1, resolved: 0, scoreable: 0, hits: 0, hitRate: null,
          wilsonLow: null, wilsonHigh: null, directionalScoreable: 0, directionalHits: 0,
          directionalAccuracy: null, meanSignedError: null, byBand: [],
        },
      ],
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ReportView report={report} />
      </QueryClientProvider>,
    );
    // The treatment-adjusted KPI (0 clean tests) renders a dash, not NaN.
    expect(screen.getByText('Treatment-Adjusted')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/NaN/);
    // Both kinds present.
    expect(screen.getByText('capital-action')).toBeTruthy();
    expect(screen.getByText('anomaly')).toBeTruthy();
  });
});
