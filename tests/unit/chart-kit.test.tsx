// tests/unit/chart-kit.test.tsx — roadmap 2.6: the hand-built SVG kit promoted from Property
// Financials into src/charts/kit must stand alone — no `--pf-*` tokens or `pf-*` classes (those
// only resolve inside .pf-root) — and keep its accessibility contract outside the PF module.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { DivergingBars } from '../../src/charts/kit/DivergingBars';
import { LineChartCrosshair } from '../../src/charts/kit/LineChartCrosshair';

const KIT = join(__dirname, '../../src/charts/kit');

class ImmediateResizeObserver {
  #cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.#cb = cb;
  }
  observe() {
    this.#cb([{ contentRect: { width: 480 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}
beforeEach(() => vi.stubGlobal('ResizeObserver', ImmediateResizeObserver));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('chart kit is free of the Property Financials scope', () => {
  it('no kit file references a --pf-* token or a pf-* class', () => {
    const files = readdirSync(KIT);
    expect(files).toEqual(expect.arrayContaining(['geometry.ts', 'MarkFrame.tsx', 'LineChartCrosshair.tsx', 'DivergingBars.tsx', 'kit.css']));
    for (const f of files) {
      const src = readFileSync(join(KIT, f), 'utf8');
      expect(src, f).not.toMatch(/--pf-/);
      expect(src, f).not.toMatch(/className="[^"]*\bpf-/);
      expect(src, f).not.toMatch(/\.pf-[a-z]/);
    }
  });
});

describe('kit charts outside .pf-root', () => {
  it('LineChartCrosshair: named svg, keyboard crosshair tooltip, data-table fallback', () => {
    const { container } = render(
      <LineChartCrosshair
        ariaLabel="Test series"
        x={['Jan', 'Feb', 'Mar']}
        xTick={(v) => v}
        xTitle={(v) => v}
        formatAxis={(n) => String(n)}
        formatValue={(n) => `$${n}`}
        series={[{ id: 'a', label: 'A', color: 'var(--color-info)', values: [1, 2, 3] }]}
      />,
    );
    expect(container.querySelector('svg[role="img"][aria-label="Test series"]')).not.toBeNull();
    const group = container.querySelector('.ck-chart-focus') as HTMLElement;
    fireEvent.focus(group);
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(within(container).getByRole('status').textContent).toMatch(/\$/);
    expect(container.querySelector('details.ck-tablefb .ck-tbl table')).not.toBeNull();
  });

  it('DivergingBars: every bar is a mark, both directions in the legend, table fallback', () => {
    const { container, getByText } = render(
      <DivergingBars
        ariaLabel="Drivers"
        formatValue={(n) => `${n}`}
        positive={{ label: 'Helps', color: 'var(--color-pos)' }}
        negative={{ label: 'Hurts', color: 'var(--color-neg)' }}
        items={[
          { key: 'x', label: 'Rent', value: 5 },
          { key: 'y', label: 'Taxes', value: -3 },
        ]}
      />,
    );
    expect(container.querySelector('svg[role="img"][aria-label="Drivers"]')).not.toBeNull();
    expect(getByText('Helps')).toBeTruthy();
    expect(getByText('Hurts')).toBeTruthy();
    expect(container.querySelector('details.ck-tablefb .ck-tbl table')).not.toBeNull();
  });
});
