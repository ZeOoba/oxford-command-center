// tests/unit/waterfall-data.test.ts
//
// Pure layout-prep for the ΔNOI waterfall: waterfallBars(startValue, drivers, endValue)
// computes cumulative floating-bar positions (start/end full-height totals from 0; signed
// drivers float on the running total). The React component renders these — only the math
// is unit-tested.
import { describe, expect, it } from 'vitest';
import { waterfallBars } from '../../src/charts/Waterfall';

describe('waterfallBars', () => {
  it('computes cumulative floating-bar positions; last bar lands on endValue', () => {
    const bars = waterfallBars(100, [
      { category: 'Rev', delta: 10 },
      { category: 'Ins', delta: -4 },
    ], 106);
    expect(bars[0]).toMatchObject({ label: 'Start', base: 0, top: 100, kind: 'total' });
    const rev = bars.find((b) => b.label === 'Rev')!;
    expect(rev.base).toBeCloseTo(100);
    expect(rev.top).toBeCloseTo(110);
    expect(rev.kind).toBe('pos');
    const ins = bars.find((b) => b.label === 'Ins')!;
    expect(ins.base).toBeCloseTo(106);
    expect(ins.top).toBeCloseTo(110);
    expect(ins.kind).toBe('neg');
    const end = bars[bars.length - 1]!;
    expect(end.label).toBe('End');
    expect(end.top).toBeCloseTo(106);
    expect(end.kind).toBe('total');
  });

  it('keeps total bars ordered (base ≤ top) when NOI crosses below zero', () => {
    // start +100, drivers sum to −120 → end −20 (a distressed asset). Totals must render
    // as real bars from 0, never top<base (which collapsed the End bar to a 1px sliver).
    const bars = waterfallBars(100, [
      { category: 'Ins', delta: -50 },
      { category: 'Taxes', delta: -40 },
      { category: 'Vacancy', delta: -30 },
    ], -20);
    for (const b of bars) expect(b.base).toBeLessThanOrEqual(b.top);
    const start = bars[0]!;
    expect(start).toMatchObject({ label: 'Start', base: 0, top: 100, value: 100, kind: 'total' });
    const end = bars[bars.length - 1]!;
    expect(end).toMatchObject({ label: 'End', kind: 'total', value: -20 });
    expect(end.base).toBeCloseTo(-20); // downward bar from 0
    expect(end.top).toBeCloseTo(0);
    // the last driver lands on the end total
    const vac = bars.find((b) => b.label === 'Vacancy')!;
    expect(vac.base).toBeCloseTo(-20);
    expect(vac.top).toBeCloseTo(10);
    expect(vac.kind).toBe('neg');
  });
});
