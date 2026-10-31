import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { ScatterChart, scatterDomain } from '../../src/charts/ScatterChart';

const pts = [
  { id: 'a', x: 70, y: 0.07, label: 'A' },
  { id: 'b', x: 120, y: 0.055, label: 'B' },
];

describe('ScatterChart', () => {
  it('pads the domain by 10% of the range on each side', () => {
    const d = scatterDomain(pts);
    expect(d.x[0]).toBeCloseTo(65);
    expect(d.x[1]).toBeCloseTo(125);
    expect(d.y[0]).toBeCloseTo(0.0535);
  });
  it('renders one circle per point with an accessible title', () => {
    const { container } = render(<ScatterChart points={pts} xLabel="$/SF" yLabel="Cap" xFormat={String} yFormat={String} />);
    expect(container.querySelectorAll('circle')).toHaveLength(2);
    expect(container.querySelector('circle title')?.textContent).toContain('A');
  });

  // I-1: axis labels (xLabel/yLabel) rendered with no labelProps, so visx fell back to its
  // hardcoded #222 Arial default — invisible on the dark 'command' surface. They must carry the
  // same theme token every tick label already uses (AXIS_TICK), just with the brighter
  // text-secondary fill so the label reads as more prominent than its own ticks.
  it('gives the x/y axis label text the shared theme token fill, not the visx #222 default', () => {
    const { container } = render(<ScatterChart points={pts} xLabel="Implied cap" yLabel="vs market" xFormat={String} yFormat={String} />);
    const labelEls = [...container.querySelectorAll('text')].filter(
      (t) => t.textContent === 'Implied cap' || t.textContent === 'vs market',
    );
    expect(labelEls).toHaveLength(2);
    for (const el of labelEls) {
      expect(el.getAttribute('fill')).toBe('var(--text-secondary)');
      expect(el.getAttribute('fill')).not.toBe('#222');
    }
  });
});

// Roadmap 2.6: ScatterChart renders in the shared kit's MarkFrame.
describe('ScatterChart kit frame', () => {
  it('arrow keys walk the points; the tooltip names the point and both formatted values', () => {
    const { container } = render(<ScatterChart points={pts} xLabel="$/SF" yLabel="Cap" xFormat={(n) => `$${n}`} yFormat={(n) => `${(n * 100).toFixed(1)}%`} />);
    const group = container.querySelector('.ck-chart-focus') as HTMLElement;
    fireEvent.focus(group);
    expect(container.querySelector('[role="status"]')!.textContent).toBe('A$/SF: $70Cap: 7.0%');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(container.querySelector('[role="status"]')!.textContent).toMatch(/^B\$\/SF: \$120/);
  });

  it('the data table lists every point with both values', () => {
    const { container } = render(<ScatterChart points={pts} xLabel="$/SF" yLabel="Cap" xFormat={String} yFormat={String} />);
    const rows = [...container.querySelectorAll('details.ck-tablefb tbody tr')].map((r) => [...r.children].map((c) => c.textContent));
    expect(rows).toEqual([
      ['A', '70', '0.07'],
      ['B', '120', '0.055'],
    ]);
  });

  it('keeps the axis-label fill as an inline style so the kit stylesheet cannot dim it (I-1)', () => {
    const { container } = render(<ScatterChart points={pts} xLabel="Implied cap" yLabel="vs market" xFormat={String} yFormat={String} />);
    const labelEls = [...container.querySelectorAll('text')].filter((t) => t.textContent === 'Implied cap' || t.textContent === 'vs market');
    for (const el of labelEls) expect((el as SVGElement).style.fill).toBe('var(--text-secondary)');
  });
});
