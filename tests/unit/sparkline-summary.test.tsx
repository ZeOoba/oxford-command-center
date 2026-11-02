// tests/unit/sparkline-summary.test.tsx
//
// Roadmap 2.5: a Sparkline has no axes, so its accessible name carries the trend in words.
import { describe, expect, it, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { sparklineSummary } from '../../src/charts/sparkline-summary';
import { Sparkline } from '../../src/charts/Sparkline';

afterEach(cleanup);

const usdK = (n: number) => `$${Math.round(n / 1000)}K`;

describe('sparklineSummary', () => {
  it('states ends, point count, direction and percent', () => {
    expect(sparklineSummary([410_000, 420_000, 455_000], 'NOI', usdK)).toBe('NOI: $410K to $455K over 3 points, up 11.0%');
  });

  it('says down for a falling series', () => {
    expect(sparklineSummary([200, 150], 'Occupancy')).toBe('Occupancy: 200 to 150 over 2 points, down 25.0%');
  });

  it('says flat when the ends match', () => {
    expect(sparklineSummary([5, 9, 5], 'Rent')).toBe('Rent: 5 to 5 over 3 points, flat');
  });

  it('drops the percent from a zero start or a sign flip', () => {
    expect(sparklineSummary([0, 10], 'NOI')).toBe('NOI: 0 to 10 over 2 points, up');
    expect(sparklineSummary([-10, 10], 'NOI')).toBe('NOI: -10 to 10 over 2 points, up');
  });

  it('refuses to summarise a series with a non-finite point, and a too-short one', () => {
    expect(sparklineSummary([Number.NaN, 4], 'NOI')).toBe('NOI: not enough data for a trend');
    expect(sparklineSummary([], 'NOI')).toBe('NOI: not enough data for a trend');
  });
});

describe('Sparkline', () => {
  it('exposes the summary as the svg accessible name', () => {
    const { container } = render(<Sparkline data={[1, 2]} label="Premium" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Premium: 1 to 2 over 2 points, up 100.0%');
  });

  it('still names an empty sparkline', () => {
    const { container } = render(<Sparkline data={[3]} label="Premium" />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('Premium: not enough data for a trend');
  });
});
