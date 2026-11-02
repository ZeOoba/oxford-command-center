import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { KpiStat } from '../../src/primitives/KpiStat';

// Regression: Brain › Insights showed "Open Insights 54" beside an "All · 55" pill. The KPI value
// went through useCountUp, which keeps showing the prior value until the first animation frame
// (and indefinitely when frames are throttled, e.g. a hidden pane/tab), so a count that grew after
// mount (warehouse candidates arriving after the snapshot) read one behind the pill.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const fmt = (n: number | null) => (n === null ? '—' : String(n));

describe('KpiStat exact counts', () => {
  it('shows the new value immediately when animate={false}, even if no animation frame ever fires', () => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);

    const { rerender } = render(<KpiStat label="Open Insights" value={54} format={fmt} animate={false} />);
    expect(screen.getByText('54')).toBeTruthy();
    rerender(<KpiStat label="Open Insights" value={55} format={fmt} animate={false} />);
    expect(screen.getByText('55')).toBeTruthy();
  });

  it('still animates by default (control: the stale read is the count-up, not the test setup)', () => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);

    const { rerender } = render(<KpiStat label="Open Insights" value={54} format={fmt} />);
    rerender(<KpiStat label="Open Insights" value={55} format={fmt} />);
    expect(screen.getByText('54')).toBeTruthy();
  });
});
