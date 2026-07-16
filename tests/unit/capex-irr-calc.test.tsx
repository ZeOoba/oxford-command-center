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

// Deliberately a partial cast, not a full typed PortfolioSnapshot/BrainState fixture like
// intel-ownership-smoke.test.tsx builds: CapexIrrCalc reads ONLY snapshot.governors, so a
// full-shape fixture would be pure unused boilerplate here. Documented trade-off (a refute pass
// flagged the cast): if this component ever reads another snapshot field, that field will read
// as `undefined` against this fixture with no type error -- extend the cast then, not preemptively.
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
  // Verdict copy deliberately avoids "deploy capital"/"do not deploy": CAPITAL_VERB
  // (property-intel.ts) reserves "Deploy capital" for capitalAction 'invest' specifically, and
  // this panel also renders for 'hold'/'monitor' — reusing that phrasing would contradict a
  // "Hold" verdict header directly above it (second refute-round finding).
  it('shows "Clears the hurdle" when the computed IRR clears the 8% fallback hurdle', () => {
    renderPanel('invest');
    setInputs(100_000, 15_000, 10); // IRR ~8.14%, cross-checked in capex-irr.test.ts
    expect(screen.getByText(/Clears the hurdle \(8(\.0)?%\)/i)).toBeTruthy();
  });

  it('shows "Does not clear the hurdle" when the computed IRR misses the 8% fallback hurdle', () => {
    renderPanel('invest');
    setInputs(100_000, 12_000, 10); // well under 8% at this capex/hold
    expect(screen.getByText(/Does not clear the hurdle \(8(\.0)?%\)/i)).toBeTruthy();
  });

  it('shows "No positive return" verdict and −∞ IRR when uplift is 0 (destroy-value case)', () => {
    renderPanel('invest');
    setInputs(100_000, 0, 10);
    expect(screen.getByText('−∞')).toBeTruthy();
    expect(screen.getByText(/No positive return at these inputs/i)).toBeTruthy();
  });

  it('shows a distinct "Invalid inputs" verdict (not "No positive return") when capex is 0 (NaN case)', () => {
    renderPanel('invest');
    fireEvent.change(screen.getByLabelText(/proposed capex/i), { target: { value: '0' } });
    expect(screen.getByText(/Invalid inputs/i)).toBeTruthy();
  });

  // Second refute round: a rounding-based comparison here previously reintroduced the exact
  // self-contradiction it was meant to fix (at non-exact hurdle values, roundToDisplay disagreed
  // with fmtPct's own toFixed rounding), AND it made the NPV figure's sign independently
  // inconsistent with the verdict (NPV computed raw, verdict computed rounded). The comparison is
  // now RAW (matching the engine's own strict `>`), which makes the NPV sign and the verdict
  // provably agree by construction (NPV(hurdle) > 0 iff irr > hurdle -- the same inequality).
  it('the verdict and the NPV sign always agree (same raw inequality, not two independently-rounded ones)', () => {
    renderPanel('invest');
    // capex=100850/uplift=15000/hold=10: raw IRR 0.079563 (just under the 8% hurdle) -- DISPLAYS
    // as "8.0%" (same as the hurdle badge) due to 1-decimal rounding. The decision is correct and
    // matches what the live engine would compute; the display collision at this razor-thin band is
    // an accepted, documented precision limit (see the "pre-tax..." caption), not something papered
    // over with a second, competing rounding scheme.
    setInputs(100_850, 15_000, 10);
    expect(screen.getByText('8.0%')).toBeTruthy(); // the bare IRR figure, same text as the hurdle
    expect(screen.getByText(/Does not clear the hurdle \(8\.0%\)/i)).toBeTruthy();
    const npvValue = screen.getByText(/^-?\$[\d,]+$/); // the bare NPV figure (Intl.NumberFormat uses ASCII '-')
    expect(npvValue.textContent?.startsWith('-')).toBe(true); // negative, agreeing with the verdict
  });

  it('the verdict reads against the LIVE payload hurdle, not just the badge (closes a split-brain test gap)', () => {
    // A prior version of this suite only asserted the CardHeader badge text for a non-default
    // hurdle, never the verdict itself -- a regression back to the static/fallback constant for
    // the DECISION (while the badge kept reading the live value) would have stayed green.
    renderPanel('invest', null, 0.10); // simulated DB-governed re-ratification to 10%
    setInputs(100_000, 15_000, 10); // IRR ~8.14% -- clears 8% but misses a 10% hurdle
    expect(screen.getByText(/Does not clear the hurdle \(10(\.0)?%\)/i)).toBeTruthy();
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
  // KNOWN COVERAGE GAP, flagged by two independent refute-pass rounds, deliberately not closed
  // here: this test proves the React key/remount MECHANISM resets state — it does NOT exercise
  // PropertyIntelView.tsx's own key={selectedId} call site. Deleting that one prop would
  // reintroduce the original bug (property A's numbers under property B's heading) with zero
  // test failures anywhere in the suite. Closing this properly needs a PropertyIntelView render
  // harness (useScores/useMetrics/useGrowth/useAnomalies/useDrivers all seeded, the last with a
  // dynamic per-property query key) that does not exist in this repo yet for ANY intel view of
  // this shape — building one was judged disproportionate scope for this fix pass and deferred
  // as an explicit, surfaced decision rather than silently left uncovered.
  it('a key change on re-render resets the local capex/uplift/hold state (mechanism only, not the PropertyIntelView call site)', () => {
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
