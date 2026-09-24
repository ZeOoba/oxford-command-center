// tests/unit/waterfall-aria.test.tsx
//
// Waterfall hard-coded its aria-label/<title> to the NOI-bridge strings, so every consumer —
// including the rent bridge in LeaseForecastModule — was announced to screen readers as an
// "NOI driver waterfall" regardless of what it actually showed. ariaLabel/title are now optional
// props defaulting to the original NOI strings (existing NOI consumers unchanged).
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Waterfall } from '../../src/charts/Waterfall';

const drivers = [{ category: 'Rev', delta: 10 }];

describe('Waterfall aria/title', () => {
  it('defaults to the NOI-bridge aria-label and title for an existing NOI consumer', () => {
    const { container } = render(<Waterfall startValue={100} drivers={drivers} endValue={110} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-label')).toBe('NOI driver waterfall');
    expect(container.querySelector('title')?.textContent).toBe('ΔNOI driver bridge');
  });

  it('uses the rent bridge aria-label/title when passed explicitly', () => {
    const { container } = render(
      <Waterfall
        startValue={100}
        drivers={drivers}
        endValue={110}
        ariaLabel="Rent bridge waterfall"
        title="Rent bridge: in-place to projected"
      />,
    );
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-label')).toBe('Rent bridge waterfall');
    expect(container.querySelector('title')?.textContent).toBe('Rent bridge: in-place to projected');
  });
});
