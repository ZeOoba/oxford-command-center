// tests/unit/heatmap.test.tsx
// Heatmap primitive (Portfolio Trends Wave 3B): diverging variance heatmap, null = "no data".
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { Heatmap, type HeatCell } from '../../src/charts/Heatmap';

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
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ROWS = ['Alpha', 'Beta'];
const COLS = ['Jan', 'Feb', 'Mar'];
const cellEls = (c: HTMLElement) => [...c.querySelectorAll('rect[data-row]')];
const cell = (c: HTMLElement, row: string, col: string) =>
  cellEls(c).find((r) => r.getAttribute('data-row') === row && r.getAttribute('data-col') === col)!;

describe('Heatmap', () => {
  it('renders exactly rows x cols cell rects; missing pairs are no-data cells', () => {
    const cells: HeatCell[] = [{ row: 'Alpha', col: 'Jan', value: 0.1 }];
    const { container } = render(<Heatmap rows={ROWS} cols={COLS} cells={cells} />);
    expect(cellEls(container)).toHaveLength(6);
    expect(cell(container, 'Alpha', 'Jan').getAttribute('data-no-data')).toBeNull();
    expect(cell(container, 'Beta', 'Mar').getAttribute('data-no-data')).toBe('true');
  });

  it('null and 0 cells are distinguishable by attribute and by fill', () => {
    const cells: HeatCell[] = [
      { row: 'Alpha', col: 'Jan', value: null },
      { row: 'Alpha', col: 'Feb', value: 0 },
    ];
    const { container } = render(<Heatmap rows={['Alpha']} cols={['Jan', 'Feb']} cells={cells} />);
    const nul = cell(container, 'Alpha', 'Jan');
    const zero = cell(container, 'Alpha', 'Feb');
    expect(nul.getAttribute('data-no-data')).toBe('true');
    expect(nul.getAttribute('data-value')).toBeNull();
    expect(zero.getAttribute('data-no-data')).toBeNull();
    expect(zero.getAttribute('data-value')).toBe('0');
    expect(nul.getAttribute('fill')).toMatch(/^url\(#/);
    expect(zero.getAttribute('fill')).not.toBe(nul.getAttribute('fill'));
    expect(container.querySelector('pattern')).not.toBeNull();
  });

  it('equal-magnitude positive vs negative resolve to the neg vs pos tokens', () => {
    const cells: HeatCell[] = [
      { row: 'Alpha', col: 'Jan', value: 0.2 },
      { row: 'Alpha', col: 'Feb', value: -0.2 },
    ];
    const { container } = render(<Heatmap rows={['Alpha']} cols={['Jan', 'Feb']} cells={cells} />);
    const up = cell(container, 'Alpha', 'Jan');
    const down = cell(container, 'Alpha', 'Feb');
    expect(up.getAttribute('fill')).toBe('var(--color-neg)');
    expect(down.getAttribute('fill')).toBe('var(--color-pos)');
    expect(up.getAttribute('fill-opacity')).toBe(down.getAttribute('fill-opacity'));
  });

  it('intensity scales with |value|', () => {
    const cells: HeatCell[] = [
      { row: 'Alpha', col: 'Jan', value: 0.1 },
      { row: 'Alpha', col: 'Feb', value: 0.4 },
    ];
    const { container } = render(<Heatmap rows={['Alpha']} cols={['Jan', 'Feb']} cells={cells} />);
    const lo = Number(cell(container, 'Alpha', 'Jan').getAttribute('fill-opacity'));
    const hi = Number(cell(container, 'Alpha', 'Feb').getAttribute('fill-opacity'));
    expect(hi).toBeGreaterThan(lo);
  });

  it('default domain is symmetric about 0 (max |min|,|max|)', () => {
    const cells: HeatCell[] = [
      { row: 'Alpha', col: 'Jan', value: 0.1 },
      { row: 'Alpha', col: 'Feb', value: -0.4 },
      { row: 'Alpha', col: 'Mar', value: 0.4 },
    ];
    const { container } = render(<Heatmap rows={['Alpha']} cols={COLS} cells={cells} />);
    expect(cell(container, 'Alpha', 'Feb').getAttribute('data-intensity')).toBe('1');
    expect(cell(container, 'Alpha', 'Mar').getAttribute('data-intensity')).toBe('1');
    expect(cell(container, 'Alpha', 'Jan').getAttribute('data-intensity')).toBe('0.25');
  });

  it('a supplied domain is honoured and values beyond it clamp to the edge intensity', () => {
    const cells: HeatCell[] = [
      { row: 'Alpha', col: 'Jan', value: 0.5 },
      { row: 'Alpha', col: 'Feb', value: 5 },
      { row: 'Alpha', col: 'Mar', value: -5 },
    ];
    const { container } = render(<Heatmap rows={['Alpha']} cols={COLS} cells={cells} domain={[-0.5, 0.5]} />);
    expect(cell(container, 'Alpha', 'Jan').getAttribute('data-intensity')).toBe('1');
    expect(cell(container, 'Alpha', 'Feb').getAttribute('data-intensity')).toBe('1');
    expect(cell(container, 'Alpha', 'Feb').getAttribute('fill-opacity')).toBe(
      cell(container, 'Alpha', 'Jan').getAttribute('fill-opacity'),
    );
    expect(cell(container, 'Alpha', 'Mar').getAttribute('data-intensity')).toBe('1');
    expect(cell(container, 'Alpha', 'Mar').getAttribute('fill')).toBe('var(--color-pos)');
  });

  it('valueFormat output appears in cell labels where there is room, never for no-data cells', () => {
    const cells: HeatCell[] = [
      { row: 'Alpha', col: 'Jan', value: 0.123 },
      { row: 'Alpha', col: 'Feb', value: null },
    ];
    const { container } = render(
      <Heatmap rows={['Alpha']} cols={['Jan', 'Feb']} cells={cells} valueFormat={(n) => `${(n * 100).toFixed(1)}%`} />,
    );
    const texts = [...container.querySelectorAll('svg text')].map((t) => t.textContent);
    expect(texts).toContain('12.3%');
    expect(texts.filter((t) => t?.includes('%'))).toHaveLength(1);
  });

  it('sets ariaLabel on the svg', () => {
    const { container } = render(<Heatmap rows={ROWS} cols={COLS} cells={[]} ariaLabel="Variance heatmap" />);
    expect(container.querySelector('svg')!.getAttribute('aria-label')).toBe('Variance heatmap');
  });

  it('empty rows/cols/cells and a 1x1 grid do not throw and emit no NaN or negative geometry', () => {
    const check = (c: HTMLElement) => {
      for (const r of c.querySelectorAll('svg rect')) {
        for (const a of ['width', 'height']) {
          const v = Number(r.getAttribute(a));
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
        }
        for (const a of ['x', 'y']) {
          if (r.getAttribute(a) !== null) expect(Number.isFinite(Number(r.getAttribute(a)))).toBe(true);
        }
      }
      expect(c.innerHTML).not.toMatch(/NaN|undefined/);
    };
    const cases: Array<{ rows: string[]; cols: string[]; cells: HeatCell[] }> = [
      { rows: [], cols: [], cells: [] },
      { rows: ['A'], cols: [], cells: [] },
      { rows: [], cols: ['x'], cells: [] },
      { rows: ['A'], cols: ['x'], cells: [{ row: 'A', col: 'x', value: 0 }] },
      { rows: ['A'], cols: ['x'], cells: [{ row: 'A', col: 'x', value: 0.3 }] },
      { rows: ['A'], cols: ['x'], cells: [{ row: 'A', col: 'x', value: null }] },
    ];
    for (const props of cases) {
      const { container, unmount } = render(<Heatmap {...props} />);
      check(container);
      unmount();
    }
  });

  it('duplicate (row, col) cells: the last one wins', () => {
    const cells: HeatCell[] = [
      { row: 'Alpha', col: 'Jan', value: 0.1 },
      { row: 'Alpha', col: 'Jan', value: -0.3 },
    ];
    const { container } = render(<Heatmap rows={['Alpha']} cols={['Jan']} cells={cells} />);
    expect(cellEls(container)).toHaveLength(1);
    expect(cell(container, 'Alpha', 'Jan').getAttribute('data-value')).toBe('-0.3');
  });

  it('hover shows row, column and formatted value, or "no data"', () => {
    const cells: HeatCell[] = [
      { row: 'Alpha', col: 'Jan', value: 0.25 },
      { row: 'Alpha', col: 'Feb', value: null },
    ];
    const { container, getByTestId, queryByTestId } = render(
      <Heatmap rows={['Alpha']} cols={['Jan', 'Feb']} cells={cells} valueFormat={(n) => `${n * 100}%`} />,
    );
    expect(queryByTestId('heatmap-tooltip')).toBeNull();
    fireEvent.mouseMove(cell(container, 'Alpha', 'Jan'));
    expect(getByTestId('heatmap-tooltip').textContent).toMatch(/Alpha.*Jan.*25%/);
    fireEvent.mouseMove(cell(container, 'Alpha', 'Feb'));
    expect(getByTestId('heatmap-tooltip').textContent).toMatch(/Alpha.*Feb.*no data/);
    fireEvent.mouseLeave(cell(container, 'Alpha', 'Feb'));
    expect(queryByTestId('heatmap-tooltip')).toBeNull();
  });
});

describe('Heatmap rowLabels', () => {
  it('two row ids with the SAME display label render two separate rows with their own values', () => {
    const cells: HeatCell[] = [
      { row: 'id-1', col: 'Jan', value: 0.1 },
      { row: 'id-2', col: 'Jan', value: -0.2 },
    ];
    const { container } = render(<Heatmap rows={['id-1', 'id-2']} cols={['Jan']} cells={cells} rowLabels={{ 'id-1': 'Same Name', 'id-2': 'Same Name' }} />);
    expect(cellEls(container)).toHaveLength(2);
    expect(cell(container, 'id-1', 'Jan').getAttribute('data-value')).toBe('0.1');
    expect(cell(container, 'id-2', 'Jan').getAttribute('data-value')).toBe('-0.2');
    const labels = [...container.querySelectorAll('svg title')].map((t) => t.textContent);
    expect(labels).toEqual(['Same Name', 'Same Name']);
  });

  it('labels default to the id and the tooltip uses the label', () => {
    const { container } = render(<Heatmap rows={['id-1', 'x']} cols={['Jan']} cells={[{ row: 'id-1', col: 'Jan', value: 0.1 }]} rowLabels={{ 'id-1': 'Pretty' }} />);
    expect([...container.querySelectorAll('svg title')].map((t) => t.textContent)).toEqual(['Pretty', 'x']);
    fireEvent.mouseMove(cell(container, 'id-1', 'Jan'));
    expect(container.textContent).toContain('Pretty · Jan');
  });
});
