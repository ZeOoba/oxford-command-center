// tests/unit/calendar-module-horizon.test.tsx
//
// Render-level tests for CalendarModule's horizon band selector.
//
// Why this file exists: the calendar shipped with a two-band window filter (90d / 12mo) and
// fetched events at a fixed 12-month horizon. Against the live portfolio that hid 72.6% of
// annual rent — including REDACTED-659, the single largest tenant by rent, expiring in ~15 months.
// A third 36-month band exposes it.
//
// The trap this file guards: criticalDateKpis() returns `next12mo: events.length`, i.e. it
// reports whatever horizon it was handed. Widening the fetch horizon without narrowing the KPI
// input would silently relabel a 36-month count as "Next 12 Months" — a portfolio metric
// changing meaning with a filter the operator thought only narrowed a list. CalendarModule.tsx
// states that invariant in a comment; the last test here is what actually enforces it.
//
// Conventions follow tests/unit/market-module-smoke.test.tsx: seed the QueryClient cache directly
// rather than vi.mock the query hook. Cache-seeding is preferred here because it exercises the
// real useSnapshot code path — the component reads through TanStack Query exactly as it does in
// the app — instead of replacing it with a stub whose shape can drift from the hook's. (Do not
// repeat the claim in capex-irr-calc.test.tsx that vitest.config.ts sets `isolate: false`: it
// sets isolate TRUE, and its comment says that MUST stay true precisely because the old
// isolate:false let vi.mock registrations bleed across files.)
// useUi() needs no provider (UiContext's default value is all no-ops).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CalendarModule } from '../../src/modules/calendar/CalendarModule';
import { SNAPSHOT_KEY } from '../../src/data/queries';
import type { SnapshotResponse } from '../../src/data/client';

// CalendarModule passes `new Date().toISOString().slice(0,10)` as the reference date (run-date
// basis, deliberately NOT the frozen workbook asOf), so the fixture dates below are meaningless
// unless "now" is pinned. Fake ONLY Date: useCountUp drives itself off requestAnimationFrame and
// performance.now(), and faking those deadlocks the render.
const NOW = new Date('2026-09-18T12:00:00Z');

// Horizon maths in critical-dates.ts: horizonDays = round(months * 30.4375).
//   12mo -> 365d   |   36mo -> 1096d
// Distances from 2026-09-18:
const OVERDUE = '2026-08-19'; //  -30d  — holdover, must survive EVERY band
const NEAR = '2026-11-17'; //   ~60d  — inside both bands
const EDGE_IN = '2027-09-18'; //  365d  — exactly the 12-month cut, inclusive
const EDGE_OUT = '2027-09-19'; // 366d  — one day past it
const MID = '2027-12-31'; //     469d  — OUTSIDE 12mo, inside 36mo  (the REDACTED-659 analogue)
const FAR = '2030-06-30'; //    1381d  — outside both

function snapshotFixture(): SnapshotResponse {
  return {
    snapshot: {
      meta: { asOf: '2026-09-18' },
      leases: [
        { id: 'L-OVERDUE', company: 'Holdover Metals', tenantName: 'Holdover', propertyKey: '200 B', unit: null, annualRent: 40000, leaseEnd: OVERDUE, escalationDate: null },
        { id: 'L-NEAR', company: 'Acme Freight', tenantName: 'Acme', propertyKey: '100 A', unit: '1', annualRent: 120000, leaseEnd: NEAR, escalationDate: null },
        { id: 'L-EDGE-IN', company: 'Edgein Partners', tenantName: 'Edgein', propertyKey: '400 D', unit: null, annualRent: 50000, leaseEnd: EDGE_IN, escalationDate: null },
        { id: 'L-EDGE-OUT', company: 'Edgeout Partners', tenantName: 'Edgeout', propertyKey: '401 D', unit: null, annualRent: 50000, leaseEnd: EDGE_OUT, escalationDate: null },
        { id: 'L-MID', company: 'Longhaul Systems', tenantName: 'Longhaul', propertyKey: '55 New Plant', unit: null, annualRent: REDACTED-AMT, leaseEnd: MID, escalationDate: null },
        { id: 'L-FAR', company: 'Farhorizon Corp', tenantName: 'Farhorizon', propertyKey: '300 C', unit: null, annualRent: 90000, leaseEnd: FAR, escalationDate: null },
      ],
      loans: [],
      insurance: [],
    } as unknown as SnapshotResponse['snapshot'],
    state: { status: 'ready' } as unknown as SnapshotResponse['state'],
  };
}

function renderCalendar() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  qc.setQueryData(SNAPSHOT_KEY, snapshotFixture());
  return render(
    <QueryClientProvider client={qc}>
      <CalendarModule />
    </QueryClientProvider>,
  );
}

/** Read a KpiStat's rendered value by its label. KpiStat puts label and value in one wrapper. */
function kpiValue(label: string): string {
  const box = screen.getByText(label).parentElement;
  if (!box) throw new Error(`no wrapper around KPI label "${label}"`);
  return (box.textContent ?? '').replace(label, '').trim();
}

const windowSelect = () => screen.getByLabelText('Filter by window') as HTMLSelectElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  // useCountUp animates via rAF unless the user prefers reduced motion, which would leave the
  // KPI mid-tween and make the assertions below timing-dependent. jsdom ships no matchMedia.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent: () => false,
  }));
  // CalendarModule now mounts the "At Stake by Month" BarChart, which measures via
  // ResizeObserver — jsdom ships none. Same no-op stub as the other chart-bearing module tests
  // (see e.g. tests/unit/market-module-smoke.test.tsx, tests/unit/premium-history-card.test.tsx).
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('CalendarModule horizon bands', () => {
  it('defaults to the 12-month band and hides events beyond it', () => {
    renderCalendar();
    expect(windowSelect().value).toBe('12mo');
    expect(screen.getByText('Acme Freight')).toBeTruthy();
    expect(screen.queryByText('Longhaul Systems')).toBeNull();
    expect(screen.queryByText('Farhorizon Corp')).toBeNull();
  });

  it('offers a 36-month band that reveals events 12-36 months out', () => {
    renderCalendar();
    fireEvent.change(windowSelect(), { target: { value: '36mo' } });

    expect(windowSelect().value).toBe('36mo');
    expect(screen.getByText('Longhaul Systems')).toBeTruthy(); // 469d — the point of the band
    expect(screen.getByText('Acme Freight')).toBeTruthy(); // near events still listed
  });

  it('still narrows to 90 days', () => {
    renderCalendar();
    fireEvent.change(windowSelect(), { target: { value: '90d' } });

    expect(screen.getByText('Acme Freight')).toBeTruthy();
    expect(screen.queryByText('Edgein Partners')).toBeNull();
    expect(screen.queryByText('Longhaul Systems')).toBeNull();
  });

  // Pins TWELVE_MONTH_DAYS to exactly round(12 * 30.4375) = 365, inclusive, matching the
  // `within = d <= horizonDays` rule in critical-dates.ts. Without this, the 12-month cut could
  // drift by a day against the fetch horizon and nothing would notice.
  it('cuts the 12-month band at exactly 365 days, inclusive', () => {
    renderCalendar();
    expect(screen.getByText('Edgein Partners')).toBeTruthy(); // 365d — in
    expect(screen.queryByText('Edgeout Partners')).toBeNull(); // 366d — out

    fireEvent.change(windowSelect(), { target: { value: '36mo' } });
    expect(screen.getByText('Edgeout Partners')).toBeTruthy(); // ...and the wider band picks it up
  });

  // Overdue holdovers are the highest-consequence rows on this surface. Every band predicate is
  // upper-bound-only; if a `>= 0` ever creeps into one, these tenants vanish silently.
  it('keeps overdue holdovers visible in every band', () => {
    renderCalendar();
    for (const band of ['12mo', '90d', '36mo'] as const) {
      fireEvent.change(windowSelect(), { target: { value: band } });
      expect(screen.queryByText('Holdover Metals')).toBeTruthy();
    }
    expect(screen.getByText('30d over')).toBeTruthy(); // rendered as overdue, not as "in 30d"
    // Overdue holdovers are split out of "Critical (<60d)" into their own tile (Task 4) — assert
    // the tile that actually counts them. Deliberately not asserting an exact count: that would
    // couple this to ALERT_THRESHOLDS.
    expect(kpiValue('Overdue / Holdover')).not.toBe('0');
  });

  // FAR (1381d) is excluded by the FETCH horizon, not by the band predicate: BAND_MAX_DAYS['36mo']
  // is derived from FETCH_HORIZON_MONTHS, so the top band cannot exclude anything by construction.
  // Naming that here so a later reader does not mistake this for band-filter coverage.
  it('never fetches events beyond the widest band', () => {
    renderCalendar();
    fireEvent.change(windowSelect(), { target: { value: '36mo' } });
    expect(screen.queryByText('Farhorizon Corp')).toBeNull();
  });

  // The regression guard. "Next 12 Months" must mean twelve months in every band.
  it('holds the "Next 12 Months" KPI fixed when the band widens', () => {
    renderCalendar();
    const at12 = kpiValue('Next 12 Months');
    expect(at12).toBe('3'); // Holdover Metals, Acme Freight, Edgein Partners

    fireEvent.change(windowSelect(), { target: { value: '36mo' } });
    expect(screen.getByText('Longhaul Systems')).toBeTruthy(); // band really did widen
    expect(kpiValue('Next 12 Months')).toBe(at12); // ...but the 12-month KPI did not move
  });

  it('counts the widened band in the events badge', () => {
    renderCalendar();
    expect(screen.getByText('3 events')).toBeTruthy();

    fireEvent.change(windowSelect(), { target: { value: '36mo' } });
    expect(screen.getByText('5 events')).toBeTruthy();

    fireEvent.change(windowSelect(), { target: { value: '90d' } });
    expect(screen.getByText('2 events')).toBeTruthy();
  });
});

// I-2/I-5: escalations carry the lease's full annualRent (same as its own expiry), so counting
// them as "at stake" double-counted/inflated the total; retitled to make clear this is expiring
// rent, not every dated lease event. I-5: the card must not render over an empty chart.
describe('CalendarModule — "Annual rent expiring by month" card (I-2 retitle, I-5 empty-state)', () => {
  it('shows the retitled card when lease-expiry events are present', () => {
    renderCalendar();
    expect(screen.getByText('Annual rent expiring by month')).toBeTruthy();
    expect(screen.queryByText('Annual rent at stake by month')).toBeNull();
  });

  it('hides the card when the filtered window has no lease-expiry events', () => {
    renderCalendar();
    // Fixture has zero loans — filtering to loan-maturity empties the filtered set entirely.
    fireEvent.change(screen.getByLabelText('Filter by event type'), { target: { value: 'loan-maturity' } });
    expect(screen.queryByText('Annual rent expiring by month')).toBeNull();
  });
});
