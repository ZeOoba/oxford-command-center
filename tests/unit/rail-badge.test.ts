// A destination's rail badge summarises its tabs' badges. It is the WORST single tab badge, never a
// sum: two tabs can count the same underlying item (an overdue lease is both a critical date and an
// alert), so adding them would overstate the work.
import { describe, it, expect } from 'vitest';
import { pickRailBadge } from '../../src/shell/tab-badges';

describe('pickRailBadge', () => {
  it('is undefined when no tab has a badge', () => {
    expect(pickRailBadge([])).toBeUndefined();
    expect(pickRailBadge([undefined, undefined])).toBeUndefined();
  });

  it('ignores zero-count badges', () => {
    expect(pickRailBadge([{ count: 0, tone: 'red' }])).toBeUndefined();
  });

  it('passes a single badge through unchanged', () => {
    expect(pickRailBadge([undefined, { count: 4, tone: 'neutral' }])).toEqual({ count: 4, tone: 'neutral' });
  });

  it('picks the most severe tone even when a milder tab has the bigger count', () => {
    expect(
      pickRailBadge([
        { count: 40, tone: 'neutral' },
        { count: 2, tone: 'amber' },
        { count: 1, tone: 'red' },
      ]),
    ).toEqual({ count: 1, tone: 'red' });
  });

  it('breaks a tone tie by the larger count and never sums', () => {
    expect(
      pickRailBadge([
        { count: 3, tone: 'red' },
        { count: 5, tone: 'red' },
      ]),
    ).toEqual({ count: 5, tone: 'red' });
  });

  it('ranks amber above neutral', () => {
    expect(
      pickRailBadge([
        { count: 9, tone: 'neutral' },
        { count: 1, tone: 'amber' },
      ]),
    ).toEqual({ count: 1, tone: 'amber' });
  });
});
