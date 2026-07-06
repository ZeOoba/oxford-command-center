import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TierBoard, type Tier, type TierItem } from '../../src/primitives/TierBoard';

afterEach(() => cleanup());

function makeTier(overrides: Partial<Tier> = {}): Tier {
  return { key: 'critical', title: 'Critical', tone: 'neg', items: [], ...overrides };
}

function makeItem(overrides: Partial<TierItem> = {}): TierItem {
  return { id: 'item-1', title: 'Untitled', ...overrides };
}

describe('TierBoard / tier grouping', () => {
  it('shows the item count in the tier header', () => {
    const tiers: Tier[] = [
      makeTier({
        items: [makeItem({ id: 'a', title: 'Alpha' }), makeItem({ id: 'b', title: 'Beta' })],
      }),
      makeTier({ key: 'warning', title: 'Warning', tone: 'warn', items: [makeItem({ id: 'c', title: 'Gamma' })] }),
    ];
    render(<TierBoard tiers={tiers} />);
    expect(screen.getByRole('list', { name: 'Tier board' })).toBeTruthy();
    expect(screen.getByText('Critical')).toBeTruthy();
    expect(screen.getByText('Warning')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
  });
});

describe('TierBoard / item ordering', () => {
  it('renders items in the given order with their rank numbers', () => {
    const tiers: Tier[] = [
      makeTier({
        items: [
          makeItem({ id: 'a', title: 'First item', rank: 1 }),
          makeItem({ id: 'b', title: 'Second item', rank: 2 }),
          makeItem({ id: 'c', title: 'Third item', rank: 3 }),
        ],
      }),
    ];
    const { container } = render(<TierBoard tiers={tiers} />);
    expect(screen.getByText('#1')).toBeTruthy();
    expect(screen.getByText('#2')).toBeTruthy();
    expect(screen.getByText('#3')).toBeTruthy();

    const text = container.textContent ?? '';
    expect(text.indexOf('First item')).toBeLessThan(text.indexOf('Second item'));
    expect(text.indexOf('Second item')).toBeLessThan(text.indexOf('Third item'));
  });
});

describe('TierBoard / impact rendering', () => {
  it('renders an em dash for a null impact', () => {
    const tiers: Tier[] = [
      makeTier({ items: [makeItem({ id: 'a', title: 'No dollar figure', impactUsd: null, impactKind: 'risk' })] }),
    ];
    render(<TierBoard tiers={tiers} />);
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('renders a formatted dollar figure for a non-null impact', () => {
    const tiers: Tier[] = [
      makeTier({ items: [makeItem({ id: 'a', title: 'Has a figure', impactUsd: 1_250_000, impactKind: 'gain' })] }),
    ];
    render(<TierBoard tiers={tiers} />);
    expect(screen.getByText('$1.25M')).toBeTruthy();
  });
});

describe('TierBoard / totalsBySpine', () => {
  it('renders each spine total separately rather than summing them', () => {
    const tiers: Tier[] = [
      makeTier({
        items: [makeItem({ id: 'a', title: 'Some item' })],
        totalsBySpine: [
          { label: 'Spine A', totalUsd: 1_000_000 },
          { label: 'Spine B', totalUsd: 250_000 },
        ],
      }),
    ];
    render(<TierBoard tiers={tiers} />);
    expect(screen.getByText(/Spine A:/)).toBeTruthy();
    expect(screen.getByText(/Spine B:/)).toBeTruthy();
    expect(screen.getByText('$1.00M')).toBeTruthy();
    expect(screen.getByText('$250K')).toBeTruthy();
    // Never a summed $1.25M total anywhere on the board.
    expect(screen.queryByText('$1.25M')).toBeNull();
  });
});

describe('TierBoard / empty tier', () => {
  it('renders a quiet placeholder when a tier has no items', () => {
    const tiers: Tier[] = [makeTier({ items: [] })];
    render(<TierBoard tiers={tiers} />);
    expect(screen.getByText(/clear/i)).toBeTruthy();
  });
});

describe('TierBoard / column count', () => {
  it('defaults to a 3-column grid', () => {
    render(<TierBoard tiers={[makeTier()]} />);
    const board = screen.getByRole('list', { name: 'Tier board' });
    expect(board.className).toContain('grid-cols-3');
  });

  it('renders a 2-column grid when columns=2', () => {
    render(<TierBoard tiers={[makeTier()]} columns={2} />);
    const board = screen.getByRole('list', { name: 'Tier board' });
    expect(board.className).toContain('grid-cols-2');
  });

  it('renders a 4-column grid when columns=4', () => {
    render(<TierBoard tiers={[makeTier()]} columns={4} />);
    const board = screen.getByRole('list', { name: 'Tier board' });
    expect(board.className).toContain('grid-cols-4');
  });

  it('always includes the sub-920px single-column collapse', () => {
    render(<TierBoard tiers={[makeTier()]} columns={4} />);
    const board = screen.getByRole('list', { name: 'Tier board' });
    expect(board.className).toContain('max-[920px]:grid-cols-1');
  });
});
