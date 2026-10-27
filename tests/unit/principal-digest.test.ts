import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import type { Insight } from '../../src/analytics/types';
import type { InsightCandidate } from '../../src/contracts/insights';
import type { MergedInsight } from '../../src/modules/insights/insights.logic';
import { mergeInsightSources, buildTiers } from '../../src/modules/insights/insights.logic';
import { principalDigest } from '../../src/brain/principal-digest';
import { digestSummary } from '../../src/modules/principal/digest-summary';
import { signalCount } from '../../src/lib/tier-group';

const mergedInsight = (o: Partial<MergedInsight> & Pick<MergedInsight, 'id' | 'severity'>): MergedInsight => ({
  spine: 'A', propertyId: null, title: 'T', detail: 'D', impactUsd: null, category: 'debt', advisoryOnly: true, ...o,
});
const deal = (o: Record<string, unknown>) => ({ id: 'd1', name: 'Cedar', shortName: null, location: null, market: null, sf: null, buildings: null, stage: 'Candidate', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null, lender: null, status: null, nextAction: 'Sign PSA', owner: null, targetCloseDate: null, confidential: false, estimatedFields: [], ...o });

function snapshotWithDeals(deals: unknown[]): PortfolioSnapshot {
  return { deals } as unknown as PortfolioSnapshot;
}

describe('principalDigest', () => {
  it('includes critical+warning items from the merged set (the SAME set the Insights board renders) and excludes info', () => {
    const merged = [
      mergedInsight({ id: 'c', severity: 'critical', title: 'Balloon' }),
      mergedInsight({ id: 'w', severity: 'warning', title: 'DSCR' }),
      mergedInsight({ id: 'n', severity: 'info', title: 'Occ' }),
    ];
    const ids = principalDigest(snapshotWithDeals([]), merged).map((x) => x.id);
    expect(ids).toContain('c'); expect(ids).toContain('w'); expect(ids).not.toContain('n');
  });

  it('includes deals in LOI/PSA or Closing and excludes other stages', () => {
    const ids = principalDigest(
      snapshotWithDeals([deal({ id: 'a', stage: 'LOI/PSA' }), deal({ id: 'b', stage: 'Closing' }), deal({ id: 'c', stage: 'Candidate' })]),
      [],
    ).map((x) => x.id);
    expect(ids).toContain('deal-a'); expect(ids).toContain('deal-b'); expect(ids).not.toContain('deal-c');
  });

  it('sorts critical insights before warnings before deals', () => {
    const merged = [mergedInsight({ id: 'w', severity: 'warning' }), mergedInsight({ id: 'c', severity: 'critical' })];
    const ids = principalDigest(snapshotWithDeals([deal({ id: 'a', stage: 'Closing' })]), merged).map((x) => x.id);
    expect(ids).toEqual(['c', 'w', 'deal-a']);
  });

  it('returns [] for an empty snapshot and empty merged set', () => {
    expect(principalDigest(snapshotWithDeals([]), [])).toEqual([]);
  });

  // 2026-09-23 review, gap #1: before this fix the Digest counted raw analytics.insights (no
  // dedup against a richer warehouse candidate) — a number the Insights board itself never
  // showed, because mergeInsightSources() drops the Spine-A duplicate. principalDigest now
  // consumes the board's OWN merged output directly, so a superseded item can't double count:
  // it was never in `merged` to begin with.
  it('a Spine-A insight superseded by a richer warehouse candidate is not double-counted (mirrors the board exactly)', () => {
    const snapshot = { deals: [], loans: [], leases: [] } as unknown as PortfolioSnapshot;
    const spineAInsights: Insight[] = [
      { id: 'spine-a-1', severity: 'critical', category: 'debt', title: 'Spine A balloon insight', detail: 'D', impactAnnualUsd: 10_000, spine: 'A', provenance: 'derived' },
    ];
    const candidates: InsightCandidate[] = [
      {
        id: 'spine-a-1', // same fallback key as the Spine-A insight above -> same dedup key (both resolve to propertyId null)
        family: 'CF', // debt -> CF via CATEGORY_TO_FAMILY
        generatorId: 'cf-hurdle-drag',
        propertyId: null,
        spine: 'B',
        attribution: { inputs: {} },
        confidence: 0.9,
        goal: 2,
        materialityUsd: 25_000,
        title: 'Richer warehouse candidate',
        discovery: 'discovery',
        prov: { source: 'test', confidence: 'derived' },
        advisoryOnly: true,
      },
    ];
    const { merged, supersededCount } = mergeInsightSources(spineAInsights, candidates, snapshot);
    expect(supersededCount).toBe(1); // the board itself drops the Spine-A duplicate

    const digest = principalDigest(snapshot, merged);
    // Exactly ONE critical item (the richer candidate) — never two, and never the dropped title.
    expect(digest.filter((d) => d.rank === 0)).toHaveLength(1);
    expect(digest[0]?.title).toBe('Richer warehouse candidate');
  });

  // Review follow-up: principalDigest previously kept `merged`'s own (arbitrary) order, so the
  // Digest's top-3 could differ from the board's Critical tier. principalDigest is now derived from
  // buildTiers (grouped, pinned-first, dollar-ranked). Compares against buildTiers(merged) directly — the board's
  // OWN output — never a second call to principalDigest, so this can't pass by both sides sharing
  // the same bug.
  it("digest's critical ordering (and top-3) matches buildTiers(merged)'s Critical tier exactly", () => {
    const merged = [
      mergedInsight({ id: 'c1', severity: 'critical', impactUsd: 100, title: 'C1' }),
      mergedInsight({ id: 'c2', severity: 'critical', impactUsd: 900, title: 'C2' }),
      mergedInsight({ id: 'c3', severity: 'critical', impactUsd: 50, title: 'C3' }),
      mergedInsight({ id: 'c4', severity: 'critical', impactUsd: 500, title: 'C4' }),
      mergedInsight({ id: 'w1', severity: 'warning', impactUsd: 10, title: 'W1' }),
    ];
    const digest = principalDigest(snapshotWithDeals([]), merged);
    const tiers = buildTiers(merged);
    const boardCritical = tiers.find((t) => t.key === 'critical')!;
    const boardPriority = tiers.find((t) => t.key === 'priority')!;

    // Insertion order (c1,c2,c3,c4) is NOT impactUsd-descending order (c2=900,c4=500,c1=100,c3=50)
    // — a re-implemented or absent sort would fail this.
    const digestCriticalIds = digest.filter((d) => d.rank === 0).map((d) => d.id);
    expect(digestCriticalIds).toEqual(boardCritical.items.map((i) => i.id));
    expect(digestCriticalIds).toEqual(['c2', 'c4', 'c1', 'c3']);

    const summary = digestSummary(digest);
    expect(summary.critical).toBe(boardCritical.items.reduce((n, i) => n + signalCount(i), 0));
    expect(summary.review).toBe(boardPriority.items.reduce((n, i) => n + signalCount(i), 0));
    expect(summary.top.map((t) => t.id)).toEqual(boardCritical.items.slice(0, 3).map((i) => i.id));
  });

  // The fixture above uses cause-less ids, so it cannot see grouping or pinning — it passed
  // vacuously after buildTiers started rolling up (refute wf_75f08f8a-621). This one uses the ids
  // conditions.ts really emits: ≥3 of one cause plus pinned lapsed coverage.
  it('digest ids stay unique when one cause spans critical and warning', () => {
    const exp = (id: string, severity: 'critical' | 'warning') =>
      mergedInsight({ id: `expiring-${id}`, severity, category: 'lease', impactUsd: 5, title: id });
    const ids = principalDigest(
      snapshotWithDeals([]),
      [exp('a', 'critical'), exp('b', 'critical'), exp('c', 'critical'), exp('d', 'warning'), exp('e', 'warning'), exp('f', 'warning')],
    ).map((d) => d.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('digest matches the board on real alert ids: grouped rows, pinned lapsed coverage, signal counts', () => {
    const lapsed = (n: number) =>
      mergedInsight({ id: `ins-lapsed-P${n}`, severity: 'critical', spine: 'B', category: 'insurance', title: `Policy expired — P${n}` });
    const lease = (n: number, usd: number) =>
      mergedInsight({ id: `lease-expiry-L${n}`, severity: 'critical', category: 'lease', impactUsd: usd, title: `Expiring — L${n}` });
    const merged = [
      lapsed(1), lapsed(2), mergedInsight({ id: 'ins-lapsed-live-P3', severity: 'critical', spine: 'B', category: 'insurance', title: 'Policy lapsed — P3' }),
      mergedInsight({ id: 'debt-balloon-1', severity: 'critical', spine: 'B', impactUsd: 400_000, title: 'Balloon' }),
      lease(1, 50_000), lease(2, 40_000), lease(3, 30_000),
      mergedInsight({ id: 'w1', severity: 'warning', impactUsd: 10, title: 'W1' }),
    ];
    const digest = principalDigest(snapshotWithDeals([]), merged);
    const tiers = buildTiers(merged);
    const boardCritical = tiers.find((t) => t.key === 'critical')!;

    // Same rows, same order as the board's Critical tier — pinned insurance group first.
    expect(digest.filter((d) => d.rank === 0).map((d) => d.id)).toEqual(boardCritical.items.map((i) => i.id));
    expect(boardCritical.items[0]!.id).toBe('group:critical:insurance-lapsed');

    const summary = digestSummary(digest);
    expect(summary.critical).toBe(7); // 3 lapsed + 1 debt + 3 leases = signals, unchanged by grouping
    expect(summary.review).toBe(1);
    expect(summary.top.map((t) => t.id)).toEqual(boardCritical.items.slice(0, 3).map((i) => i.id));
  });
});
