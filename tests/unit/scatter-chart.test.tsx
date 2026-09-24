import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
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
});
