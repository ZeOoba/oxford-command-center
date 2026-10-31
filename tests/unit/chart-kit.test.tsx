// tests/unit/chart-kit.test.tsx — roadmap 2.6: the hand-built SVG kit promoted from Property
// Financials into src/charts/kit must stand alone — no `--pf-*` tokens or `pf-*` classes (those
// only resolve inside .pf-root) — and keep its accessibility contract outside the PF module.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { DivergingBars } from '../../src/charts/kit/DivergingBars';
import { LineChartCrosshair } from '../../src/charts/kit/LineChartCrosshair';
import { StackedBars } from '../../src/charts/kit/PeriodBars';
import { StepChart } from '../../src/charts/kit/StepChart';

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
    expect(files).toEqual(expect.arrayContaining(['geometry.ts', 'MarkFrame.tsx', 'LineChartCrosshair.tsx', 'DivergingBars.tsx', 'PeriodBars.tsx', 'StepChart.tsx', 'kit.css']));
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

describe('kit bars and steps take colour and formats from the caller', () => {
  it('StackedBars: caller colours on the segments, signed totals in the table, keyboard tooltip', () => {
    const { container } = render(
      <StackedBars
        ariaLabel="Stack"
        testId="stack"
        formatAxis={(n) => `${n}`}
        formatCell={(n) => `$${n}`}
        data={{
          columns: [
            { key: 'a', label: 'FY24', partial: false },
            { key: 'b', label: 'FY25', partial: true },
          ],
          series: [
            { id: 's1', label: 'Tax', color: 'var(--color-info)' },
            { id: 's2', label: 'Credit', color: 'var(--color-warn)' },
          ],
          values: [
            [10, 0],
            [12, -2],
          ],
          tips: [
            [['FY24 Tax'], ['FY24 Credit']],
            [['FY25 Tax'], ['FY25 Credit']],
          ],
        }}
        stack={{ totals: [10, 10], credits: [0, -2], text: ['Total 10', 'Total 10 (incl. -2 credit)'], tableText: ['$10', '$10 (incl. -$2 credit)'], creditNote: [null, 'incl. -2 credit'] }}
      />,
    );
    const fills = [...container.querySelectorAll('rect[data-mark]')].map((r) => r.getAttribute('fill'));
    expect(fills).toEqual(['var(--color-info)', 'var(--color-info)']);
    expect(container.querySelector('details.ck-tablefb')?.textContent).toMatch(/\$10 \(incl\. -\$2 credit\)/);
    const group = container.querySelector('.ck-chart-focus') as HTMLElement;
    fireEvent.focus(group);
    expect(within(container).getByRole('status').textContent).toBe('FY24 Tax');
  });

  it('StepChart: caller colour on the line and dots, formatted table cells', () => {
    const { container } = render(
      <StepChart
        ariaLabel="Steps"
        today="2026-06-01"
        color="var(--color-pos)"
        formatAxis={(n) => `${n}`}
        formatCell={(n) => `$${n}/mo`}
        rows={[
          { from: '2026-01-01', to: '2026-12-31', value: 1000, tip: ['Step 1'] },
          { from: '2027-01-01', to: '2027-12-31', value: 1030, tip: ['Step 2'] },
        ]}
      />,
    );
    expect(container.querySelector('path[stroke="var(--color-pos)"]')).not.toBeNull();
    expect([...container.querySelectorAll('circle[data-mark]')].every((c) => c.getAttribute('fill') === 'var(--color-pos)')).toBe(true);
    expect(container.querySelector('details.ck-tablefb')?.textContent).toMatch(/\$1030\/mo/);
  });
});
