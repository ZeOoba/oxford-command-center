import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { TierBoard, type Tier, type TierItem } from '../../src/primitives/TierBoard';

afterEach(() => cleanup());

function items(prefix: string, n: number, usd: number | null = 1_000): TierItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    title: `${prefix} item ${i}`,
    rank: i + 1,
    impactUsd: usd === null ? null : usd * (n - i),
    impactKind: 'risk' as const,
  }));
}

function tiers(): Tier[] {
  return [
    { key: 'critical', title: 'Critical', tone: 'neg', items: items('c', 20) },
    { key: 'warning', title: 'Warning', tone: 'warn', items: items('w', 34) },
    { key: 'info', title: 'Info', tone: 'info', items: items('i', 6, null) },
  ];
}

const cards = (c: HTMLElement) => c.querySelectorAll('[data-tier-card]');

describe('TierBoard / budget', () => {
  it('renders every item when no budget is set (back-compat)', () => {
    const { container } = render(<TierBoard tiers={tiers()} />);
    expect(cards(container)).toHaveLength(60);
    expect(screen.queryByText(/held back/i)).toBeNull();
  });

  it('caps the board at the budget, favouring earlier tiers but keeping a floor in every tier', () => {
    const { container } = render(<TierBoard tiers={tiers()} budget={10} />);
    expect(cards(container)).toHaveLength(10);
    const critical = screen.getByText('Critical').closest('section')!;
    const info = screen.getByText('Info').closest('section')!;
    expect(cards(critical as HTMLElement)).toHaveLength(6);
    expect(cards(info as HTMLElement)).toHaveLength(2);
  });

  it('shows shown/total in a capped tier header', () => {
    render(<TierBoard tiers={tiers()} budget={10} />);
    expect(screen.getByText('6/20')).toBeTruthy();
    expect(screen.getByText('2/34')).toBeTruthy();
  });

  it('keeps the highest-ranked items (they arrive pre-sorted)', () => {
    render(<TierBoard tiers={tiers()} budget={10} />);
    expect(screen.getByText('c item 0')).toBeTruthy();
    expect(screen.queryByText('c item 6')).toBeNull();
  });

  it('reports what is held back and offers to show all', () => {
    render(<TierBoard tiers={tiers()} budget={10} />);
    expect(screen.getByText(/\+50 held back/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /view all/i })).toBeTruthy();
  });

  it('expands to every item on "View all" and collapses again', () => {
    const { container } = render(<TierBoard tiers={tiers()} budget={10} />);
    fireEvent.click(screen.getByRole('button', { name: /view all/i }));
    expect(cards(container)).toHaveLength(60);
    fireEvent.click(screen.getByRole('button', { name: /show fewer/i }));
    expect(cards(container)).toHaveLength(10);
  });

  it('does not render a held-back control when everything fits', () => {
    const small: Tier[] = [{ key: 'a', title: 'A', tone: 'neg', items: items('a', 4) }];
    render(<TierBoard tiers={small} budget={10} />);
    expect(screen.queryByText(/held back/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /view all/i })).toBeNull();
  });
});

describe('TierBoard / coverage strip', () => {
  it('states signals shown of total and the dollars still on screen', () => {
    render(<TierBoard tiers={tiers()} budget={10} />);
    const strip = screen.getByLabelText('Coverage');
    expect(within(strip).getByText(/10 of 60 signals/)).toBeTruthy();
    expect(within(strip).getByText(/% of/)).toBeTruthy();
  });

  it('counts unquantified signals instead of treating them as zero dollars', () => {
    render(<TierBoard tiers={tiers()} budget={10} />);
    expect(within(screen.getByLabelText('Coverage')).getByText(/6 unquantified/)).toBeTruthy();
  });
});

describe('TierBoard / grouped rows', () => {
  const grouped = (): Tier[] => [
    {
      key: 'critical',
      title: 'Critical',
      tone: 'neg',
      items: [
        {
          id: 'group:lease',
          rank: 1,
          title: '3 leases expiring with no renewal signal',
          impactUsd: 30_000,
          impactKind: 'risk',
          members: [
            { id: 'm1', title: 'Expiring — Alpha', impactUsd: 20_000 },
            { id: 'm2', title: 'Expiring — Beta', impactUsd: 7_000 },
            { id: 'm3', title: 'Expiring — Gamma', impactUsd: 3_000 },
          ],
        },
      ],
    },
  ];

  it('shows a rolled-up row collapsed, with a member toggle', () => {
    render(<TierBoard tiers={grouped()} />);
    expect(screen.getByText('3 leases expiring with no renewal signal')).toBeTruthy();
    expect(screen.queryByText('Expiring — Alpha')).toBeNull();
    expect(screen.getByRole('button', { name: /show 3/i })).toBeTruthy();
  });

  it('expands its members in place and hides them again', () => {
    render(<TierBoard tiers={grouped()} />);
    fireEvent.click(screen.getByRole('button', { name: /show 3/i }));
    expect(screen.getByText('Expiring — Alpha')).toBeTruthy();
    expect(screen.getByText('Expiring — Gamma')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /hide 3/i }));
    expect(screen.queryByText('Expiring — Alpha')).toBeNull();
  });

  it('counts a group as its member signals in the coverage strip', () => {
    const two: Tier[] = [...grouped(), { key: 'w', title: 'Warning', tone: 'warn', items: items('w', 5) }];
    render(<TierBoard tiers={two} budget={2} />);
    expect(within(screen.getByLabelText('Coverage')).getByText(/of 8 signals/)).toBeTruthy();
  });
});
