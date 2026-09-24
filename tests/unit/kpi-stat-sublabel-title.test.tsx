// tests/unit/kpi-stat-sublabel-title.test.tsx
//
// I-1 (2026-09-23 review): KpiStat's sublabel is rendered with `className="truncate"`, so a long
// disclosure (the other-holdings clause) can be cut off by the ellipsis with no way to read the
// rest. Rather than changing the truncation/tile layout, the sublabel element now carries a native
// `title` attribute so hovering reveals the full text — a `<span title="...">` needs no JS, no
// portal, and no extra DOM.
import { afterEach, describe, expect, it } from 'vitest';
import { render, within, cleanup } from '@testing-library/react';
import { KpiStat } from '../../src/primitives/KpiStat';

afterEach(() => cleanup());

describe('KpiStat sublabel hover title', () => {
  it('puts a string sublabel on the title attribute so the full text is available on hover', () => {
    const { container } = render(
      <KpiStat
        label="Portfolio Value"
        value={100}
        format={(n) => String(n)}
        sublabel="+$2.00M other holdings · 1 investment property"
      />,
    );
    const el = within(container).getByText('+$2.00M other holdings · 1 investment property');
    expect(el.getAttribute('title')).toBe('+$2.00M other holdings · 1 investment property');
    expect(el.className).toContain('truncate'); // truncation itself is unchanged
  });

  it('omits the title attribute when there is no sublabel', () => {
    const { container } = render(<KpiStat label="Static" value={100} format={(n) => String(n)} />);
    // No sublabel span rendered at all in this case.
    expect(container.querySelector('[title]')).toBeNull();
  });
});
