// tests/unit/capex-irr-calc.test.tsx
//
// Render-level tests for CapexIrrCalc (item-8): gating by capitalAction, the hurdle-comparison
// verdict, the live-governor-sourced hurdle, and the invalid-input display branches. The pure
// IRR/NPV math itself is covered independently in tests/unit/capex-irr.test.ts — this file only
// exercises the component's own decision logic (when it renders, what it labels, which branch it
// takes, which hurdle it reads).
//
// The hurdle rate is read via useSnapshot() (TanStack Query) rather than the static
// CAPITAL_CONFIG.capexIrr import (refute-pass finding: the static constant silently contradicted
// the live capital-allocation engine's own improve-gate, which compares against the DB-governed
// hurdleRatePct). We seed the QueryClient cache directly (no network, no module mocking) —
// vitest.config.ts sets `isolate: false`, under which vi.mock can bleed across the suite, so
// cache-seeding is this repo's established safe pattern (see intel-ownership-smoke.test.tsx).
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CapexIrrCalc } from '../../src/modules/intel/CapexIrrCalc';
import { SNAPSHOT_KEY } from '../../src/data/queries';
import type { SnapshotResponse } from '../../src/data/client';
import { GOVERNOR_FALLBACK } from '@contracts/index';

function seededClient(hurdleRatePct?: number): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  const response: SnapshotResponse = {
    snapshot: {
      governors: hurdleRatePct === undefined ? null : { ...GOVERNOR_FALLBACK, hurdleRatePct },
    } as unknown as SnapshotResponse['snapshot'],
    state: { status: 'ready' } as unknown as SnapshotResponse['state'],
  };
  qc.setQueryData(SNAPSHOT_KEY, response);
  return qc;
}

function renderPanel(
  capitalAction: 'invest' | 'hold' | 'monitor' | 'disposition-candidate',
  propertyName: string | null = null,
  hurdleRatePct?: number,
) {
  return render(
    <QueryClientProvider client={seededClient(hurdleRatePct)}>
      <CapexIrrCalc capitalAction={capitalAction} propertyName={propertyName} />
    </QueryClientProvider>,
  );
}

function setInputs(capex: number, uplift: number, hold: number): void {
  fireEvent.change(screen.getByLabelText(/proposed capex/i), { target: { value: String(capex) } });
  fireEvent.change(screen.getByLabelText(/annual noi uplift/i), { target: { value: String(uplift) } });
  fireEvent.change(screen.getByLabelText(/hold period/i), { target: { value: String(hold) } });
}

afterEach(() => cleanup());

describe('CapexIrrCalc — capitalAction gating', () => {
  it('renders nothing for capitalAction: disposition-candidate', () => {
    const { container } = renderPanel('disposition-candidate');
    expect(container.firstChild).toBeNull();
  });

  it('renders the panel for capitalAction: invest', () => {
    renderPanel('invest');
    expect(screen.getByText(/Capex IRR Calculator/i)).toBeTruthy();
  });

  it('renders the panel for capitalAction: monitor', () => {
    renderPanel('monitor');
    expect(screen.getByText(/Capex IRR Calculator/i)).toBeTruthy();
  });

  it('renders the panel for capitalAction: hold (widened 2026-07-16 — hold is where routine capex decisions live)', () => {
    renderPanel('hold');
    expect(screen.getByText(/Capex IRR Calculator/i)).toBeTruthy();
  });
});

describe('CapexIrrCalc — hurdle sourced from the live governor payload, not the static constant', () => {
  it('uses the fallback (8%) hurdle when no live governors payload is present', () => {
    renderPanel('invest', null, undefined);
    expect(screen.getByText(/hurdle 8(\.0)?%/i)).toBeTruthy();
  });

  it('uses the LIVE payload hurdle when governors are present, even if it differs from the fallback', () => {
    renderPanel('invest', null, 0.10); // simulated DB-governed re-ratification
    expect(screen.getByText(/hurdle 10(\.0)?%/i)).toBeTruthy();
  });
});

describe('CapexIrrCalc — heading', () => {
  it('includes the property name in the heading when provided', () => {
    renderPanel('invest', '9050 Red Branch');
    expect(screen.getByText(/Capex IRR Calculator — 9050 Red Branch/i)).toBeTruthy();
  });

  it('omits the em-dash suffix when propertyName is null', () => {
    renderPanel('invest', null);
    expect(screen.getByText(/^Capex IRR Calculator$/i)).toBeTruthy();
  });
});

describe('CapexIrrCalc — verdict branches, against the live (fallback 8%) hurdle', () => {
  it('shows "Above hurdle" when the computed IRR clears the 8% fallback hurdle', () => {
    renderPanel('invest');
    setInputs(100_000, 15_000, 10); // IRR ~8.14%, cross-checked in capex-irr.test.ts
    expect(screen.getByText(/Above hurdle \(8(\.0)?%\) — deploy capital/i)).toBeTruthy();
  });

  it('shows "Below hurdle" when the computed IRR misses the 8% fallback hurdle', () => {
    renderPanel('invest');
    setInputs(100_000, 12_000, 10); // well under 8% at this capex/hold
    expect(screen.getByText(/Below hurdle \(8(\.0)?%\) — do not deploy/i)).toBeTruthy();
  });

  it('shows "No return" verdict and −∞ IRR when uplift is 0 (destroy-value case)', () => {
    renderPanel('invest');
    setInputs(100_000, 0, 10);
    expect(screen.getByText('−∞')).toBeTruthy();
    expect(screen.getByText(/No return — do not deploy capital/i)).toBeTruthy();
  });

  it('shows a distinct "Invalid inputs" verdict (not "No return") when capex is 0 (NaN case)', () => {
    renderPanel('invest');
    fireEvent.change(screen.getByLabelText(/proposed capex/i), { target: { value: '0' } });
    expect(screen.getByText(/Invalid inputs/i)).toBeTruthy();
  });

  it('rounding-boundary fix: a raw IRR of 0.079563 (below the 8% hurdle) that DISPLAYS as "8.0%" reads "Above hurdle", not a self-contradictory "Below hurdle (8.0%)" beside an "8.0%" IRR', () => {
    // Verified via independent bisection: capex=100850, uplift=15000, hold=10 -> raw IRR
    // 0.079563 (< 0.08) but fmtPct's 1-decimal rounding displays it as "8.0%" -- identical to the
    // hurdle's own displayed "8.0%". Comparing the RAW (unrounded) irr>=hurdle previously showed
    // "Below hurdle (8.0%)" next to an "8.0%" IRR figure -- numerically self-contradictory to a
    // reader. The fix compares both values at fmtPct's own display precision before deciding.
    renderPanel('invest');
    setInputs(100_850, 15_000, 10);
    expect(screen.getByText('8.0%')).toBeTruthy(); // the bare IRR figure
    expect(screen.getByText(/Above hurdle \(8\.0%\) — deploy capital/i)).toBeTruthy();
  });
});

describe('CapexIrrCalc — disclosure captions', () => {
  it('discloses the model is unlevered with no growth/terminal value', () => {
    renderPanel('invest');
    expect(screen.getByText(/unlevered/i)).toBeTruthy();
  });

  it('flags the default inputs as example figures, not property-specific data', () => {
    renderPanel('invest', '9050 Red Branch');
    expect(screen.getByText(/example starting values, not this property's projected capex/i)).toBeTruthy();
  });
});

describe('CapexIrrCalc — state resets on property switch (refute-pass finding)', () => {
  it('a key change on re-render resets the local capex/uplift/hold state (the PropertyIntelView fix pattern)', () => {
    // PropertyIntelView never unmounts on property selection change, so CapexIrrCalc's internal
    // useState previously carried property A's numbers under property B's heading. The fix adds
    // key={selectedId} at the call site; this test proves changing the key actually remounts and
    // resets state, using the same React mechanism directly on the component under test.
    const client = seededClient(undefined);
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <CapexIrrCalc key="property-a" capitalAction="invest" propertyName="Property A" />
      </QueryClientProvider>,
    );
    setInputs(450_000, 85_000, 7);
    expect((screen.getByLabelText(/proposed capex/i) as HTMLInputElement).value).toBe('450000');

    rerender(
      <QueryClientProvider client={client}>
        <CapexIrrCalc key="property-b" capitalAction="invest" propertyName="Property B" />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Capex IRR Calculator — Property B/i)).toBeTruthy();
    // State reset to the defaults, not carried over from Property A's entered values.
    expect((screen.getByLabelText(/proposed capex/i) as HTMLInputElement).value).toBe('100000');
  });
});

describe('CapexIrrCalc — hold-period clamp', () => {
  it('clamps the hold-period input to [1, 10]', () => {
    renderPanel('invest');
    fireEvent.change(screen.getByLabelText(/hold period/i), { target: { value: '25' } });
    expect((screen.getByLabelText(/hold period/i) as HTMLInputElement).value).toBe('10');
    fireEvent.change(screen.getByLabelText(/hold period/i), { target: { value: '0' } });
    expect((screen.getByLabelText(/hold period/i) as HTMLInputElement).value).toBe('1');
  });
});
