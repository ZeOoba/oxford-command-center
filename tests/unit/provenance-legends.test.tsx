// tests/unit/provenance-legends.test.tsx — roadmap 3.3: recorded / reconstructed / roll-off line
// styles + legend, and the scenario-spread band (never labelled as statistical confidence).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Lease } from '../../src/contracts/index';
import type { MonthPoint } from '../../src/analytics/portfolio-trends';
import { AreaChart } from '../../src/charts/AreaChart';
import { BarChart } from '../../src/charts/BarChart';
import { SeriesLegend } from '../../src/charts/SeriesLegend';
import { provenanceKinds, provenanceRuns } from '../../src/charts/series-provenance';
import { SPREAD_LABEL, pointProvenance, renewAllLeases, spreadBand } from '../../src/modules/portfolio/scenario-spread';

class ImmediateResizeObserver {
  #cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.#cb = cb;
  }
  observe() {
    this.#cb([{ contentRect: { width: 400 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}
beforeEach(() => vi.stubGlobal('ResizeObserver', ImmediateResizeObserver));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('provenanceRuns / provenanceKinds', () => {
  it('splits into contiguous runs that share the joining point', () => {
    expect(provenanceRuns(['reconstructed', 'reconstructed', 'recorded', 'recorded', 'forecast'])).toEqual([
      { kind: 'reconstructed', from: 0, to: 1 },
      { kind: 'recorded', from: 1, to: 3 },
      { kind: 'forecast', from: 3, to: 4 },
    ]);
    expect(provenanceRuns([])).toEqual([]);
  });

  it('lists the kinds present in legend order', () => {
    expect(provenanceKinds(['forecast', 'recorded', 'forecast'])).toEqual(['recorded', 'forecast']);
  });
});

const lease = (id: string, leaseStart: string, leaseEnd: string | null): Lease =>
  ({ id, propertyId: 'p1', status: 'Active', leaseStart, leaseEnd, monthlyRent: 1000, sf: 100, escalationPct: null, escalationDate: null }) as unknown as Lease;

describe('renewAllLeases', () => {
  it('extends only leases in effect at the as-of month; ended leases stay ended, open-ended stay open', () => {
    const out = renewAllLeases([lease('a', '2024-01-01', '2026-12-31'), lease('b', '2023-01-01', '2026-06-30'), lease('c', '2024-01-01', null)], '2026-09-15');
    expect(out.map((l) => l.leaseEnd)).toEqual([null, '2026-06-30', null]);
  });
});

const pt = (month: string, inPlaceRent: number, isForecast: boolean): MonthPoint => ({
  month, isForecast, inPlaceRent, leasedSf: 0, totalSf: 0, vacantSf: 0, vacancyPct: 0, leaseCount: 0,
});

describe('spreadBand', () => {
  it('is null on history, closed at the as-of month, [min,max] forward, null where a month is missing', () => {
    const contractual = [pt('2026-08', 100, false), pt('2026-09', 100, false), pt('2026-10', 80, true), pt('2026-11', 70, true)];
    const renewAll = [pt('2026-08', 100, false), pt('2026-09', 100, false), pt('2026-10', 102, true)];
    expect(spreadBand(contractual, renewAll, (p) => p.inPlaceRent, '2026-09')).toEqual([
      null,
      { lo: 100, hi: 100 },
      { lo: 80, hi: 102 },
      null,
    ]);
  });

  it('pointProvenance tags forecast first, else the merged source', () => {
    expect(
      pointProvenance([
        { isForecast: false, source: 'reconstructed' },
        { isForecast: false, source: 'recorded' },
        { isForecast: true, source: 'reconstructed' },
      ]),
    ).toEqual(['reconstructed', 'recorded', 'forecast']);
  });

  it('the band label names its two scenarios and disclaims probability', () => {
    expect(SPREAD_LABEL).toMatch(/no renewals/);
    expect(SPREAD_LABEL).toMatch(/current terms/);
    expect(SPREAD_LABEL).toMatch(/not a probability/);
    expect(SPREAD_LABEL).not.toMatch(/confiden/i);
  });
});

describe('AreaChart provenance + band', () => {
  const data = ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11'].map((m, i) => ({ date: `${m}-01`, value: 100 - i }));

  it('draws one dashed/dotted/solid path per provenance run and the band when given', () => {
    const { container } = render(
      <AreaChart
        data={data}
        ariaLabel="t"
        provenance={['reconstructed', 'recorded', 'recorded', 'forecast', 'forecast']}
        band={[null, null, { lo: 98, hi: 98 }, { lo: 90, hi: 99 }, { lo: 85, hi: 101 }]}
      />,
    );
    const lines = [...container.querySelectorAll('[data-provenance]')];
    expect(lines.map((l) => l.getAttribute('data-provenance'))).toEqual(['reconstructed', 'recorded', 'forecast']);
    expect(lines[0]!.getAttribute('stroke-dasharray')).toBe('1.5 4');
    expect(lines[1]!.getAttribute('stroke-dasharray')).toBeNull();
    expect(lines[2]!.getAttribute('stroke-dasharray')).toBe('6 4');
    expect(container.querySelector('[data-testid="area-band"]')).not.toBeNull();
  });

  it('without provenance draws a single solid line and no band (unchanged callers)', () => {
    const { container } = render(<AreaChart data={data} ariaLabel="t" />);
    const lines = [...container.querySelectorAll('[data-provenance]')];
    expect(lines).toHaveLength(1);
    expect(lines[0]!.getAttribute('stroke-dasharray')).toBeNull();
    expect(container.querySelector('[data-testid="area-band"]')).toBeNull();
  });
});

describe('BarChart provenance', () => {
  it('outlines forecast bars and fades reconstructed ones', () => {
    const { container } = render(
      <BarChart
        ariaLabel="t"
        data={[
          { label: 'a', value: 5, provenance: 'reconstructed' },
          { label: 'b', value: 5, provenance: 'recorded' },
          { label: 'c', value: 5, provenance: 'forecast' },
        ]}
      />,
    );
    const rects = [...container.querySelectorAll('rect[data-provenance]')];
    expect(rects.map((r) => r.getAttribute('data-provenance'))).toEqual(['reconstructed', 'recorded', 'forecast']);
    expect(rects[2]!.getAttribute('fill')).toBe('transparent');
    expect(rects[2]!.getAttribute('stroke-dasharray')).toBe('4 3');
    expect((rects[0] as SVGElement).style.opacity).toBe('0.45');
  });
});

describe('SeriesLegend', () => {
  it('names each present kind in text and the band only when given', () => {
    render(<SeriesLegend kinds={['recorded', 'forecast']} bandLabel={SPREAD_LABEL} />);
    expect(screen.getByText('Recorded')).toBeTruthy();
    expect(screen.getByText('Contractual roll-off')).toBeTruthy();
    expect(screen.queryByText('Reconstructed (current leases)')).toBeNull();
    expect(screen.getByText(SPREAD_LABEL)).toBeTruthy();
  });

  it('renders nothing with no kinds and no band', () => {
    const { container } = render(<SeriesLegend kinds={[]} />);
    expect(container.innerHTML).toBe('');
  });
});
