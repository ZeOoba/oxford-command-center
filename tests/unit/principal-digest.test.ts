import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import type { AnalyticsBundle } from '../../src/analytics/index';
import type { Insight } from '../../src/analytics/types';
import { principalDigest } from '../../src/brain/principal-digest';

const insight = (o: Partial<Insight>): Insight => ({ id: 'i', severity: 'info', category: 'debt', title: 'T', detail: 'D', ...o });
const deal = (o: Record<string, unknown>) => ({ id: 'd1', name: 'Cedar', shortName: null, location: null, market: null, sf: null, buildings: null, stage: 'Candidate', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null, lender: null, status: null, nextAction: 'Sign PSA', owner: null, targetCloseDate: null, confidential: false, estimatedFields: [], ...o });

function fixture(insights: Insight[], deals: unknown[]) {
  return {
    snapshot: { deals } as unknown as PortfolioSnapshot,
    analytics: { insights } as unknown as AnalyticsBundle,
  };
}

describe('principalDigest', () => {
  it('includes critical+warning insights and excludes info', () => {
    const { snapshot, analytics } = fixture(
      [insight({ id: 'c', severity: 'critical', title: 'Balloon' }), insight({ id: 'w', severity: 'warning', title: 'DSCR' }), insight({ id: 'n', severity: 'info', title: 'Occ' })],
      [],
    );
    const ids = principalDigest(snapshot, analytics).map((x) => x.id);
    expect(ids).toContain('c'); expect(ids).toContain('w'); expect(ids).not.toContain('n');
  });

  it('includes deals in LOI/PSA or Closing and excludes other stages', () => {
    const { snapshot, analytics } = fixture([], [deal({ id: 'a', stage: 'LOI/PSA' }), deal({ id: 'b', stage: 'Closing' }), deal({ id: 'c', stage: 'Candidate' })]);
    const ids = principalDigest(snapshot, analytics).map((x) => x.id);
    expect(ids).toContain('deal-a'); expect(ids).toContain('deal-b'); expect(ids).not.toContain('deal-c');
  });

  it('sorts critical insights before warnings before deals', () => {
    const { snapshot, analytics } = fixture(
      [insight({ id: 'w', severity: 'warning' }), insight({ id: 'c', severity: 'critical' })],
      [deal({ id: 'a', stage: 'Closing' })],
    );
    expect(principalDigest(snapshot, analytics).map((x) => x.id)).toEqual(['c', 'w', 'deal-a']);
  });

  it('returns [] for an empty snapshot', () => {
    const { snapshot, analytics } = fixture([], []);
    expect(principalDigest(snapshot, analytics)).toEqual([]);
  });
});
